#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { createSessionStore } from '../core/session.js';
import { createProviders } from '../providers/icloud/index.js';
import { createServer } from '../server/createServer.js';
import { AppError } from '../core/errors.js';

const SWEEP_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);

  for (const notice of config.deprecations) logger.warn(notice);

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    providerFactory: (account) => createProviders(account, { logger, imapIdleTimeoutMs: config.imapIdleTimeoutMs }),
  });

  // unref 让定时器不阻止进程退出
  const sweeper = setInterval(() => {
    void sessions
      .sweep()
      .then((removed) => {
        if (removed > 0) logger.debug('swept expired sessions', { removed });
      })
      .catch((err: unknown) => {
        // 后台定时器绝不能让未处理的 rejection 掀翻整个服务器
        logger.warn('session sweep failed', {
          detail: err instanceof Error ? err.name : typeof err,
        });
      });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const server = createServer({ config, sessions, logger });
  await server.connect(new StdioServerTransport());

  logger.info('apple-icloud-mcp ready', {
    transport: 'stdio',
    accounts: config.accounts.length,
  });

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

    // 关闭连接不应无限期阻塞退出：logout() 对着已断开的 socket 可能永不返回
    const closed = sessions.destroyAll().then(() => true);
    const deadline = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS).unref();
    });

    if (!(await Promise.race([closed, deadline]))) {
      logger.warn('shutdown timed out, exiting anyway', { ms: SHUTDOWN_TIMEOUT_MS });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // 启动期失败必须写 stderr：stdout 属于 MCP 协议
  const message = err instanceof AppError ? `${err.message}${err.hint ? `\n提示：${err.hint}` : ''}` : String(err);
  process.stderr.write(`apple-icloud-mcp 启动失败：${message}\n`);
  process.exit(1);
});
