#!/usr/bin/env node
import 'dotenv/config';
import { createServer as createNodeServer } from 'node:http';
import { loadConfig, loadHttpConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { createSessionStore } from '../core/session.js';
import { createProviders } from '../providers/icloud/index.js';
import { createAuthStore } from '../auth/store.js';
import { createOAuthProvider } from '../auth/provider.js';
import { createPendingStore } from '../auth/login.js';
import { createHttpApp } from '../server/httpApp.js';
import { AppError } from '../core/errors.js';

/** stdio.ts 用同一个上限；HTTP 入口的清场工作更多（还要关全部 mcp transport），
 *  但没有理由给部署方一个更长的关闭等待时间。 */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** 与 stdio.ts 相同的周期：清掉过期会话、过期授权码与过期令牌，
 *  否则一个长期运行的公网进程只能靠"下次访问才顺便清理"，内存只增不减。 */
const SWEEP_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  // 绝不带着半套配置开始监听：这两步任一失败都必须在 listen 之前退出。
  const config = loadConfig(process.env);
  const httpConfig = loadHttpConfig(process.env);
  const logger = createLogger(config.logLevel);

  for (const notice of config.deprecations) logger.warn(notice);
  for (const notice of config.notices) logger.warn(notice);

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    providerFactory: (account) => createProviders(account, { logger, imapIdleTimeoutMs: config.imapIdleTimeoutMs }),
  });

  const store = createAuthStore({ path: httpConfig.tokenStorePath, key: httpConfig.encryptionKey, logger });
  // 解密失败（密钥变了/文件损坏）必须在这里就退出，而不是带着一个打不开的令牌存储去监听端口。
  await store.load();

  // provider.authorize()（任务四）与 /admin-login 路由（本任务）必须共享同一个 pending
  // store，否则登录页永远找不到 authorize() 暂存的待授权请求——这里显式建一个，两处都传。
  const pending = createPendingStore();
  const provider = createOAuthProvider({ store, sessions, logger, pending });

  const { app, closeAll } = createHttpApp({ config, httpConfig, sessions, provider, logger, pending });

  const server = createNodeServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(httpConfig.port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  logger.info('apple-icloud-mcp http ready', {
    transport: 'streamable-http',
    port: httpConfig.port,
    accounts: config.accounts.length,
  });

  const sweeper = setInterval(() => {
    void Promise.all([sessions.sweep(), provider.sweep()])
      .then(([removedSessions, removedAuth]) => {
        if (removedSessions > 0 || removedAuth > 0) {
          logger.debug('swept expired sessions and auth records', { removedSessions, removedAuth });
        }
      })
      .catch((err: unknown) => {
        // 后台定时器绝不能让未处理的 rejection 掀翻整个服务器
        logger.warn('periodic sweep failed', {
          detail: err instanceof Error ? err.name : typeof err,
        });
      });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      // 第二次信号意味着用户不想再等：放弃剩余的清理直接退出
      logger.warn('forced shutdown', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info('shutting down', { signal });
    clearInterval(sweeper);

    // 停止接受新连接
    server.close();

    const cleanup = (async (): Promise<void> => {
      await closeAll();
      await sessions.destroyAll();
    })().then(() => true);
    const deadline = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS).unref();
    });

    if (!(await Promise.race([cleanup, deadline]))) {
      logger.warn('shutdown timed out, exiting anyway', { ms: SHUTDOWN_TIMEOUT_MS });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // 启动期失败必须写 stderr——这里没有 stdout 归属协议的约束，但和 stdio.ts 保持一致，
  // 且绝不能让半套配置的进程看起来像是启动成功了。
  const message = err instanceof AppError ? `${err.message}${err.hint ? `\n提示：${err.hint}` : ''}` : String(err);
  process.stderr.write(`apple-icloud-mcp http 启动失败：${message}\n`);
  process.exit(1);
});
