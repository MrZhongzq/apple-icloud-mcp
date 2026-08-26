import { spawn as spawnDefault } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { waitForDaemonReady as waitForDaemonReadyDefault } from './client.js';
import { DAEMON_RUN_MARKER, endpointFiles, ensureOwnedDir } from './transport.js';
import type { Endpoint, EndpointFiles } from './transport.js';

// 与本目录其余文件一致：不写反斜杠转义序列（本项目已因此折叠过六次）。
const NEWLINE = String.fromCharCode(10);

/**
 * `child_process.spawn` 的全部真实签名很宽，但 `startDaemonProcess` 只用得到
 * `unref`/`once('error')`/`once('exit')` 这几个方法——把注入点收窄成这一个
 * 最小接口，而不是整个 `ChildProcess`，测试才能用一个纯 `EventEmitter` 假出来，
 * 不用真的 fork 一个进程。
 */
export interface MinimalChildProcess {
  pid?: number;
  unref(): void;
  once(event: 'error', listener: (err: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type SpawnFn = (
  execPath: string,
  args: string[],
  options: { detached: boolean; stdio: ['ignore', 'ignore', number] },
) => MinimalChildProcess;

const defaultSpawn: SpawnFn = (execPath, args, options) => spawnDefault(execPath, args, options);

/**
 * `cli start` 等一个新起的守护进程真正可连接的上限。必须覆盖子进程完整的
 * Node 启动 + 本项目模块图冷加载（express/imapflow/nodemailer/tsdav/
 * mailparser/ical.js/zod/MCP SDK 全部加载完）——实测裸的
 * `node dist/bin/cli.js --list` 在某些机器上就要 6.9 秒，5 秒的旧值本身就
 * 比这更短，健康的 daemon 在预算耗尽前根本来不及起来。30 秒足够宽松：
 * 轮询在 daemon 真正就绪的那一刻立即返回，多余的预算不花一分钱，只在
 * 起不来的时候才会被用满。
 */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

export type StartDaemonProcessResult =
  | { kind: 'ready'; endpoint: Endpoint }
  /** 子进程自己死了（spawn 失败、崩溃、被信号杀掉）——这是真正的失败，`detail`
   *  带着能拼到一起的诊断信息（'error' 事件 + daemon.log 的内容）。 */
  | { kind: 'child-failed'; detail: string }
  /** 到点了，但子进程还活着——这是"起得慢"，不是"起失败了"。调用方不能把
   *  这当成 child-failed 一样处理：既不能建议 `cli stop`（会杀掉一个正在
   *  起来的健康 daemon），也不能假装它已经就绪。 */
  | { kind: 'timed-out-but-alive'; timeoutMs: number };

export interface StartDaemonProcessDeps {
  /** 当前脚本自己的路径——子进程用同一个脚本，靠 `DAEMON_RUN_MARKER` 识别
   *  自己该扮演常驻进程而不是走一次性分派。 */
  scriptPath: string;
  files?: EndpointFiles;
  /** 测试注入：默认 `DEFAULT_START_TIMEOUT_MS`，测试传一个小得多的值，不用
   *  真的等 30 秒。 */
  timeoutMs?: number;
  /** 测试注入：真实实现是 `child_process.spawn`；测试传一个不真的 fork 进程
   *  的假实现（一个 EventEmitter 就够）。 */
  spawn?: SpawnFn;
  /** 测试注入：真实实现是 `client.ts` 的 `waitForDaemonReady`；测试可以传一个
   *  自己控制时机的假实现。 */
  waitForDaemonReady?: typeof waitForDaemonReadyDefault;
}

/**
 * `cli start` 的核心：把子进程 spawn 出去（stderr 落在一个真实文件描述符上，
 * 不是父进程手里的 pipe——见 `bin/cli.ts` 里那段解释 EPIPE 的注释)，轮询它
 * 真正可连接，和子进程的退出赛跑。三种结果由调用方（`bin/cli.ts`）决定怎么
 * 报：`ready` 打印监听地址退出 0；`child-failed` 报错退出 1；
 * `timed-out-but-alive` 必须说清楚"这是起得慢，不是死了"，不能建议
 * `cli stop`。
 */
export async function startDaemonProcess(deps: StartDaemonProcessDeps): Promise<StartDaemonProcessResult> {
  const files = deps.files ?? endpointFiles();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const spawnFn = deps.spawn ?? defaultSpawn;
  const waitFn = deps.waitForDaemonReady ?? waitForDaemonReadyDefault;

  const runtimeDir = path.dirname(files.infoPath);
  await ensureOwnedDir(runtimeDir);
  // daemon.log 的生命周期：每次 cli start 用 'w' 截断重写（避免上一次失败的
  // 残留日志和这一次的诊断信息混在一起，误导排查），此外不做任何大小上限
  // 或轮转——这只是一个诊断文件，不是审计日志，截断本身已经是它的轮转
  // 机制。运行期间它不会自动清空：daemon 常驻可能持续很久，LOG_LEVEL=debug
  // 时 imap.ts 会把每一帧 imapflow 协议数据都记进去（core/logger.ts 的
  // redact 只按键名遮蔽形如 pass/password/secret/token 的字段，不认识
  // imapflow 帧内部的字段名），文件可能因此长得比预期大，只在下一次
  // cli start 时被截断。
  const logPath = path.join(runtimeDir, 'daemon.log');
  const logFd = openSync(logPath, 'w', 0o600);

  const child = spawnFn(process.execPath, [deps.scriptPath, DAEMON_RUN_MARKER], {
    detached: true,
    stdio: ['ignore', 'ignore', logFd],
  });
  child.unref();
  // fd 已经被子进程继承（复制）走了，父进程这份可以立刻关掉。
  closeSync(logFd);

  let childFailure: string | undefined;
  child.once('error', (err) => {
    childFailure = err instanceof Error ? err.message : String(err);
  });
  let childAlive = true;
  const childExited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      childAlive = false;
      if (childFailure === undefined) {
        childFailure = signal
          ? `守护进程子进程被信号 ${signal} 终止`
          : `守护进程子进程提前退出，退出码 ${code ?? 'null'}`;
      }
      resolve();
    });
  });

  const endpoint = await Promise.race([waitFn(files, timeoutMs), childExited.then(() => undefined)]);

  if (endpoint) {
    return { kind: 'ready', endpoint };
  }

  if (!childAlive) {
    let logTail = '';
    try {
      logTail = readFileSync(logPath, 'utf8').trim();
    } catch {
      // 日志文件本身读不到就算了，不能让诊断信息的读取失败盖过原本的报错。
    }
    const detail =
      (childFailure !== undefined ? childFailure : '') + (logTail.length > 0 ? (childFailure ? NEWLINE : '') + logTail : '');
    return { kind: 'child-failed', detail };
  }

  return { kind: 'timed-out-but-alive', timeoutMs };
}
