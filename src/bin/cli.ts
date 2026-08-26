#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { createSessionStore } from '../core/session.js';
import { createProviders } from '../providers/icloud/index.js';
import { collectTools } from '../cli/registry.js';
import { runCliDaemonFirst, formatFailure, multiAccountRefusal } from '../cli/dispatch.js';
import { startDaemon } from '../cli/daemon.js';
import { stopDaemon, waitForDaemonReady } from '../cli/client.js';
import { DAEMON_RUN_MARKER } from '../cli/transport.js';
import type { Endpoint } from '../cli/transport.js';

const NEWLINE = String.fromCharCode(10);

/** `cli start` 等一个新起的守护进程真正可连接的上限；`waitForDaemonReady` 内部
 *  50ms 轮一次，这个上限只是给"进程起不来"（比如配置在 spawn 之后才报错）
 *  一个明确的失败点，而不是无限等下去。 */
const START_TIMEOUT_MS = 5_000;

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
    '  cli <tool> [flags...]      执行该工具（有守护进程在跑就用它，否则跑一次性会话）' +
    NEWLINE +
    '  cli start                  启动守护进程（后台），直到它真的能连上才返回' +
    NEWLINE +
    '  cli stop                   停止守护进程' +
    NEWLINE
  );
}

function describeEndpoint(endpoint: Endpoint): string {
  return endpoint.kind === 'unix'
    ? `unix socket ${endpoint.path}`
    : `127.0.0.1:${endpoint.port}（TCP 回环，需要令牌握手；Windows 沙箱下 unix socket 不可用时的兜底）`;
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

  // 这是 `cli start` detach 出来的子进程内部标记，不是用户命令：真正的常驻
  // 主体在这里。父进程（下面的 `start` 分支）负责把这个子进程 spawn 出去、
  // 等它真正可连接、打印端点、退出。
  if (first === DAEMON_RUN_MARKER) {
    const handle = await startDaemon({
      config,
      logger,
      // 空闲超时、收到 stop 指令、或者收到信号，都要真的退出这个进程——
      // 光把 server 关掉、会话销毁、端点文件删掉，不代表进程会自己退出：
      // 万一某个 provider 留下一个没清干净的定时器/连接，事件循环就不会
      // 自然排空，daemon 变成一个没有监听、没有端点文件、`cli stop` 也找
      // 不到、`cli start` 却会在它旁边再起一个的隐形僵尸。`onShutdown` 是
      // `shutdown()` 内部三条触发路径（空闲计时器、`__cli_daemon_stop__`、
      // 外部 `close()`）共用的唯一出口，保证它们都真的落到 `process.exit`。
      onShutdown: () => process.exit(0),
    });
    process.once('SIGINT', () => void handle.close());
    process.once('SIGTERM', () => void handle.close());
    return;
  }

  // `stop` 不需要 config 描述的账号信息——它只是去敲已经在跑的那个守护进程的门，
  // 让它自己清理退出。放在 config/logger 之后而不是之前，只是为了和其余分支
  // 共享同一套"先读配置、打印 notices"的启动顺序，不代表它真的依赖 config 的内容。
  if (first === 'stop') {
    const stopped = await stopDaemon();
    await flush(process.stdout, (stopped ? '守护进程已停止' : '没有正在运行的守护进程') + NEWLINE);
    // 退出码恒为 0：没有守护进程在跑不是一次失败，是这条命令想要的终态之一——
    // `cli stop` 常出现在清理脚本或 `set -e` 的收尾处，一个本来就无事可做的
    // 清理步骤不该让脚本因此中断。
    process.exit(0);
  }

  if (first === 'start') {
    // 和一次性模式的多账号拒绝同一个理由、同一段文案：守护进程同样只持有
    // 一个账号的会话，沉默地挑第一个账号是错的。
    if (config.accounts.length > 1) {
      exitUsageError(multiAccountRefusal(config));
    }

    // 已经有一个能连上的守护进程在跑，就不再 spawn 第二个——两个监听者抢占
    // 同一个 socket 地址没有好结果。用 timeoutMs: 0 只做一次即时探测，不是
    // 真的等——已经在跑就该立刻知道。这只是缩小竞态窗口的快路径，真正的
    // 安全网是 daemon.ts 里的 EADDRINUSE 探测 + 端点文件所有权校验：
    // 就算两个 `cli start` 在这里同时探测到"没人在跑"、都真的 spawn 了，
    // 后起的那个也不会删掉先起的那个仍然活着的端点。
    const already = await waitForDaemonReady(undefined, 0);
    if (already) {
      await flush(process.stdout, `守护进程已经在跑，监听于 ${describeEndpoint(already)}` + NEWLINE);
      process.exit(0);
    }

    const scriptPath = process.argv[1];
    if (scriptPath === undefined) {
      exitUsageError('无法确定当前脚本路径，无法启动守护进程');
    }

    // `detached: true` + `unref()`：子进程脱离这个父进程的进程组，父进程退出
    // 后子进程继续活着。stderr 用 'pipe' 而不是 'ignore'——子进程失败的唯一
    // 反馈渠道曾经就是"5 秒之后超时，打印一句没有实际信息的提示"；这里在
    // 父进程还醒着、还在轮询就绪状态的这段时间里，把子进程的 stderr 收集
    // 起来，失败时原样带出去。
    const child = spawn(process.execPath, [scriptPath, DAEMON_RUN_MARKER], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.unref();

    let childStderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      childStderr += chunk.toString('utf8');
    });

    let childFailure: string | undefined;
    child.once('error', (err) => {
      // spawn 本身失败（比如可执行文件路径有问题）：Node 用 'error' 事件报告，
      // 不接这个监听器的话它会在某个后续 tick 被当成未捕获异常抛出，绕过
      // main().catch，用户看到的是一段和这次操作毫不相关的原始堆栈。
      childFailure = err instanceof Error ? err.message : String(err);
    });
    const childExited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        if (childFailure === undefined) {
          childFailure = signal
            ? `守护进程子进程被信号 ${signal} 终止`
            : `守护进程子进程提前退出，退出码 ${code ?? 'null'}`;
        }
        resolve();
      });
    });

    // 不是等文件出现，是等真的能连上：`writeEndpoint` 只在 `listen`（以及
    // unix 模式下的 `chmod`）成功之后才落盘，但端点文件本身可能是上一个
    // 崩溃/被杀掉的守护进程留下的僵尸——文件"存在"不等于"这次启动的这个
    // 进程已经在监听"。`cli start && cli mail_search` 这种调用方式要求
    // start 返回时 daemon 必须真的可用，否则 mail_search 会在 daemon 就绪
    // 前抢跑，悄悄退回一次性模式，付掉 daemon 本该省下的握手成本，而且
    // 没有任何症状。和子进程的退出赛跑——子进程如果直接死掉，没有理由还
    // 傻等满 5 秒超时才告诉用户。
    const endpoint = await Promise.race([waitForDaemonReady(undefined, START_TIMEOUT_MS), childExited.then(() => undefined)]);

    if (!endpoint) {
      const detail =
        childFailure !== undefined
          ? NEWLINE + childFailure + (childStderr.trim().length > 0 ? NEWLINE + childStderr.trim() : '')
          : childStderr.trim().length > 0
            ? NEWLINE + childStderr.trim()
            : '';
      exitUsageError(`守护进程未能在 ${START_TIMEOUT_MS}ms 内就绪；用 cli stop 清理残留状态后重试` + detail);
    }
    await flush(process.stdout, `守护进程已启动，监听于 ${describeEndpoint(endpoint)}` + NEWLINE);
    process.exit(0);
  }

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    providerFactory: (account) => createProviders(account, { logger, imapIdleTimeoutMs: config.imapIdleTimeoutMs }),
  });

  const tools = collectTools({ config, sessions, logger });

  // sessionFactory 必须返回上面这同一个 `sessions` 实例——`tools` 里的 handler
  // （比如 mail_search）内部是靠这个 store 的 `get(session_id)` 找会话的；
  // executeOnce 若用另一个 store 建会话，注入的 session_id 在 handler 眼里就是
  // 个不存在的会话。`runCliDaemonFirst` 在这之外先试一次 callDaemon——有守护
  // 进程在跑就用它已经建好的会话执行，连不上才落到这条一次性路径。
  const outcome = await runCliDaemonFirst({ config, logger, tools, sessionFactory: () => sessions }, argv);

  await flush(process.stdout, outcome.stdout);
  await flush(process.stderr, outcome.stderr);
  process.exit(outcome.exitCode);
}

main().catch((err: unknown) => {
  // main() 内部的已知失败路径都已经各自处理并退出；能走到这里的是没预料到的异常。
  process.stderr.write(`apple-icloud-mcp cli 出错：${formatFailure(err)}${NEWLINE}`);
  process.exit(1);
});
