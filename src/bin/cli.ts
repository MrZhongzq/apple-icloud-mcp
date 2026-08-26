#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { createSessionStore } from '../core/session.js';
import { createProviders } from '../providers/icloud/index.js';
import { collectTools } from '../cli/registry.js';
import { runCli, formatFailure } from '../cli/dispatch.js';

const NEWLINE = String.fromCharCode(10);

/**
 * stdio 入口（`bin/stdio.ts`）靠 spawn 它的客户端注入环境变量，没有父进程替
 * CLI 做这件事，所以 CLI 自己读 `.env`。只在文件存在时读，且显式 `override: false`——
 * 沙盒可能已经把凭据直接注入了进程环境，一个过期的 `.env` 不能悄悄把它覆盖掉。
 */
function loadDotEnvIfPresent(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

/**
 * CLI 自身出错（未知命令、参数非法、配置缺失）：说明写 stderr，退出码 1，
 * 不管重试——参数不对不会因为重试就变对。
 *
 * 直接同步写 + `process.exit(1)`，和 `bin/stdio.ts` 的启动失败处理同一个模式：
 * 这里的文案都是短的诊断信息，同步写给终端/管道不会被截断；`process.exit` 在
 * `@types/node` 里就是 `never`，函数体走到这一步就没有正常返回路径，
 * 因此本函数的 `never` 返回类型是真的（不是靠额外 throw 凑出来的假 never——
 * 早先那样写会导致 throw 被 main().catch 二次捕获，把同一条错误打印两遍）。
 */
function exitUsageError(message: string): never {
  process.stderr.write(message + NEWLINE);
  process.exit(1);
}

/**
 * 把非空文本写到给定的流，等它真正被消费完（写回调触发）才 resolve。
 * 直接 `stream.write(x); process.exit(code)` 在部分平台的管道上（尤其是
 * Windows）不保证 write 已经落地，会截断输出；用回调换取"退出前一定写完"的保证。
 */
function flush(stream: NodeJS.WritableStream, text: string): Promise<void> {
  if (text.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
}

function renderUsage(): string {
  return (
    '用法：' +
    NEWLINE +
    '  cli --list                 列出全部工具（名字 + 一行描述）' +
    NEWLINE +
    '  cli <tool> --help          查看某个工具的参数' +
    NEWLINE +
    '  cli <tool> [flags...]      执行该工具' +
    NEWLINE
  );
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();

  const argv = process.argv.slice(2);
  const first = argv[0];

  // 顶层的"没参数"/"--help" 必须能在没有任何有效配置的情况下也显示用法——
  // 一个刚拿到沙盒、还没设置任何 ICLOUD_ACCOUNT_n 的用户第一步往往就是 cli --help。
  if (first === undefined) {
    exitUsageError(renderUsage());
  }
  if (first === '--help' || first === '-h') {
    await flush(process.stdout, renderUsage());
    process.exit(0);
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    exitUsageError(formatFailure(err));
  }

  const logger = createLogger(config.logLevel, (line) => process.stderr.write(line + NEWLINE));
  for (const notice of config.deprecations) logger.warn(notice);
  for (const notice of config.notices) logger.warn(notice);

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    providerFactory: (account) => createProviders(account, { logger, imapIdleTimeoutMs: config.imapIdleTimeoutMs }),
  });

  const tools = collectTools({ config, sessions, logger });

  // sessionFactory 必须返回上面这同一个 `sessions` 实例——`tools` 里的 handler
  // （比如 mail_search）内部是靠这个 store 的 `get(session_id)` 找会话的；
  // executeOnce 若用另一个 store 建会话，注入的 session_id 在 handler 眼里就是
  // 个不存在的会话。
  const outcome = await runCli({ config, logger, tools, sessionFactory: () => sessions }, argv);

  await flush(process.stdout, outcome.stdout);
  await flush(process.stderr, outcome.stderr);
  process.exit(outcome.exitCode);
}

main().catch((err: unknown) => {
  // main() 内部的已知失败路径都已经各自处理并退出；能走到这里的是没预料到的异常。
  process.stderr.write(`apple-icloud-mcp cli 出错：${formatFailure(err)}${NEWLINE}`);
  process.exit(1);
});
