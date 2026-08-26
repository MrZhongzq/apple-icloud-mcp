#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { createSessionStore } from '../core/session.js';
import { createProviders } from '../providers/icloud/index.js';
import { collectTools } from '../cli/registry.js';
import { runCliDaemonFirst, formatFailure, multiAccountRefusal, listCliTools } from '../cli/dispatch.js';
import { parseBatchOps, runBatch } from '../cli/batch.js';
import { startDaemon } from '../cli/daemon.js';
import { stopDaemon, waitForDaemonReady } from '../cli/client.js';
import { startDaemonProcess } from '../cli/start.js';
import { DAEMON_RUN_MARKER } from '../cli/transport.js';
import type { Endpoint } from '../cli/transport.js';

const NEWLINE = String.fromCharCode(10);

/**
 * stdio 入口（`bin/stdio.ts`）靠 spawn 它的客户端注入环境变量，没有父进程替
 * CLI 做这件事，所以 CLI 自己读 `.env`。只在文件存在时读，且显式 `override: false`——
 * 沙盒可能已经把凭据直接注入了进程环境，一个过期的 `.env` 不能悄悄把它覆盖掉。
 */
function loadDotEnvIfPresent(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    // `quiet: true` 不是可有可无的整洁：没有它，dotenv 会往 **stdout** 打一行
    // `◇ injected env (3) from .env // tip: …`，而这个入口的 stdout 只允许有
    // 结果 JSON——一行横幅就让 `out=$(cli mail_search …); echo "$out" | jq` 这
    // 类用法直接 SyntaxError。
    //
    // 另外两个入口没这个问题纯属侥幸：它们写的是 `import 'dotenv/config'`，
    // 那条路径经过 dotenv 的 cli-options 层，那里把 `quiet` 默认成了 'true'。
    // 显式调用 `dotenv.config({...})` 不继承那个默认值。**不要把它删掉，也不要
    // 指望任何默认值**——同一个包的两种引入方式给的默认值不一样，这正是它当初
    // 溜过去的原因。
    dotenv.config({ path: envPath, override: false, quiet: true });
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
    '  cli batch <ops.json>       在同一个会话里跑完一串操作；加 --stop-on-error 则首个失败即停' +
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

  // `stop` 必须排在 loadConfig **之前**。它只是去敲已经在跑的那个守护进程的门，
  // 关一个 socket 不需要任何凭据。放在 loadConfig 之后（早先就是那样，理由是
  // "和其余分支共享同一套启动顺序"）的后果是：`.env` 一坏——变量名打错、密码
  // 轮换到一半——`cli stop` 就先在配置校验上退出 1，而那个仍然活着、仍然握着
  // 一条已认证 IMAP 连接的守护进程就再也停不掉了，只能等它自己空闲超时。而
  // SKILL.md 恰恰告诉无人值守的 agent「把 cli stop 无条件放在收尾处」，`set -e`
  // 下那一句还会把整个清理流程一起中断。需要凭据才能做的事，`stop` 一件都没有。
  if (first === 'stop') {
    const stopped = await stopDaemon();
    await flush(process.stdout, (stopped ? '守护进程已停止' : '没有正在运行的守护进程') + NEWLINE);
    // 退出码恒为 0：没有守护进程在跑不是一次失败，是这条命令想要的终态之一——
    // `cli stop` 常出现在清理脚本或 `set -e` 的收尾处，一个本来就无事可做的
    // 清理步骤不该让脚本因此中断。
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
  // 主体在这里。父进程（下面的 `start` 分支，实际逻辑在 `cli/start.ts`）
  // 负责把这个子进程 spawn 出去、等它真正可连接、打印端点、退出。
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

    // spawn、等就绪、和子进程的退出赛跑，全部在 cli/start.ts 里——单独抽出来
    // 是因为这套逻辑本身需要被测试覆盖（NN-1：旧的固定 5s 超时比子进程自己
    // 冷启动都短），而 bin/cli.ts 作为一个"加载即执行"的入口脚本没法被安全
    // 导入到测试里。
    const result = await startDaemonProcess({ scriptPath });

    if (result.kind === 'ready') {
      await flush(process.stdout, `守护进程已启动，监听于 ${describeEndpoint(result.endpoint)}` + NEWLINE);
      process.exit(0);
    }

    if (result.kind === 'child-failed') {
      exitUsageError(
        `守护进程启动失败；用 cli stop 清理残留状态后重试` + (result.detail.length > 0 ? NEWLINE + result.detail : ''),
      );
    }

    // result.kind === 'timed-out-but-alive'：这不是失败，是起得慢。子进程
    // 冷启动（Node 自身 + 本项目的模块图：express/imapflow/nodemailer/tsdav/
    // mailparser/ical.js/zod/MCP SDK）在慢机器、冷页缓存、网络挂载的安装
    // 目录下可能超过一般的预期——绝不能在这里建议 cli stop，那会杀掉一个
    // 正在起来的健康守护进程；也不能假装它已经就绪。退出码非零，因为这次
    // `start` 调用确实没能确认成功，但消息必须清楚说明原因不是"死了"。
    exitUsageError(
      `守护进程仍在启动中（超过 ${result.timeoutMs}ms 还没就绪），但子进程还活着——这是启动慢，不是启动失败。` +
        NEWLINE +
        '不要用 cli stop（会杀掉一个正在起来的健康守护进程）；稍后重新运行 cli start——已经就绪的话会直接告诉你监听地址，否则继续等或查看运行时目录下的 daemon.log。',
    );
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
  // `cli batch ops.json [--stop-on-error]`：整批操作共用一个会话。放在这里而不是
  // 前面几个分支旁边，是因为它需要 `sessions` 和 `tools`。
  //
  // 传给 runBatch 的是 `listCliTools(tools)` 而不是完整工具表：apple_login /
  // work_done 的排除在 `batch.ts` 的校验里已经按名字做了一次，这里再滤一次是
  // 纵深防御——两道门里任何一道都足以挡住，但只留一道时它退化成"没人再检查"。
  //
  // 这条路径不走 daemon：批量模式本来就自己建一个会话跑完全部操作，daemon 能
  // 省下的那次握手它已经省了。有守护进程在跑时两者互不影响（各自持有自己的会话）。
  if (first === 'batch') {
    // 位置无关地解析：`cli batch --stop-on-error ops.json` 和
    // `cli batch ops.json --stop-on-error` 都对。早先按固定位置读（argv[1] 是
    // 路径、其余是 flag），前一种写法会指着 `ops.json` 说"未知参数"——把唯一
    // 写对了的那个参数当成错的。
    let stopOnError = false;
    let opsPath: string | undefined;
    for (const token of argv.slice(1)) {
      if (token === '--stop-on-error') {
        stopOnError = true;
        continue;
      }
      if (token.startsWith('--')) {
        exitUsageError(`未知参数：${token}${NEWLINE}用法：cli batch <ops.json> [--stop-on-error]`);
      }
      if (opsPath !== undefined) {
        exitUsageError(`只能给一个 ops 文件，但收到了两个：${opsPath} 和 ${token}${NEWLINE}用法：cli batch <ops.json> [--stop-on-error]`);
      }
      opsPath = token;
    }
    if (opsPath === undefined) {
      exitUsageError('用法：cli batch <ops.json> [--stop-on-error]');
    }

    let opsText: string;
    try {
      opsText = readFileSync(path.resolve(process.cwd(), opsPath), 'utf8');
    } catch (err) {
      exitUsageError(`读不到批量操作文件 ${opsPath}：${formatFailure(err)}`);
    }

    let ops;
    try {
      ops = parseBatchOps(opsText);
    } catch (err) {
      exitUsageError(formatFailure(err));
    }

    let outcomes;
    try {
      outcomes = await runBatch(
        { config, logger, tools: listCliTools(tools), sessionFactory: () => sessions },
        ops,
        { stopOnError },
      );
    } catch (err) {
      // 整批校验没过（未知工具、apple_login/work_done、args 里带 session_id、
      // 多账号）——一条都没执行，这是 CLI 自身的失败，退出码 1。
      await flush(process.stderr, formatFailure(err) + NEWLINE);
      process.exit(1);
    }

    await flush(process.stdout, JSON.stringify(outcomes, null, 2) + NEWLINE);
    // 有任何一条失败就退 2，和一次性模式"工具返回结构化错误"的退出码一致；
    // 具体哪一条失败在 stdout 的 outcomes 里，逐条带着 ok 和 value。
    process.exit(outcomes.every((o) => o.ok) ? 0 : 2);
  }

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
