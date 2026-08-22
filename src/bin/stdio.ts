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

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);

  for (const notice of config.deprecations) logger.warn(notice);

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    providerFactory: createProviders,
  });

  // unref 让定时器不阻止进程退出
  const sweeper = setInterval(() => {
    void sessions.sweep().then((removed) => {
      if (removed > 0) logger.debug('swept expired sessions', { removed });
    });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const server = createServer({ config, sessions, logger });
  await server.connect(new StdioServerTransport());

  logger.info('apple-icloud-mcp ready', {
    transport: 'stdio',
    accounts: config.accounts.length,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    clearInterval(sweeper);
    await sessions.destroyAll();
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
