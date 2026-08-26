import { AppError } from '../core/errors.js';
import { deriveFlags, parseFlags, renderHelp } from './flags.js';
import { executeOnce, type SessionFactory } from './execute.js';
import { callDaemon } from './client.js';
import type { ClientTimeouts } from './client.js';
import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { CollectedTool } from './registry.js';
import { configFingerprint, endpointFiles, readEndpoint } from './transport.js';
import type { EndpointFiles } from './transport.js';

const NEWLINE = String.fromCharCode(10);

/**
 * `apple_login` 和 `work_done` 对命令行的一次性执行模式没有意义，必须从
 * --list / --help / dispatch 里整体排除：
 *
 * - CLI 的会话边界是**进程本身**，不是调用方能拿着到处传的 token——每次
 *   `cli <tool>` 都在一个隐式会话里跑完就销毁（见 execute.ts）。
 * - `work_done` 在这个模型下只会销毁 `executeOnce` 自己刚建、还没被任何
 *   handler 用过的空会话，返回 `{"success": true}`——用户会以为自己关掉了
 *   什么，但那个会话本来就是个空壳，什么都没发生。这正是本项目一直在防的
 *   "看起来成功了、其实什么都没做"的形状。
 * - `apple_login` 返回的 `session_id` 在进程退出的那一刻就不存在了——一个
 *   指向空气的句柄，调用方没有第二次调用能用上它。
 *
 * 排除依据是这两个工具**是什么**（会话管理本身），不是它们 schema 里的什么
 * 属性——`apple_login` 的 schema 甚至没有 `session_id`，跟 `apple_accounts`
 * 长得一样，schema 层面分不出来。所以这里必须按名字排除，这是本项目里少数
 * 名单式判断是对的地方。`apple_accounts` 不受影响：它不需要会话，是用户
 * 查看当前配置了哪些账号的唯一方式，必须保留。
 */
export const CLI_MANAGED_SESSION_TOOLS: ReadonlySet<string> = new Set(['apple_login', 'work_done']);

/**
 * 排除这两个工具时给调用方的解释。导出给 `batch.ts` 复用——批量模式是第二条
 * 进入执行的路径，同一条排除规则必须在两处都生效，理由文案也不该各写一份。
 */
export const SESSION_MANAGED_MESSAGE =
  'apple_login 和 work_done 不是命令行子命令：命令行的一次性执行模式自己管理会话' +
  '（登录、执行、登出都在这一次进程运行期间完成），不需要也不支持调用方显式登录/登出。' +
  '直接运行 cli <tool> [flags...] 即可，会话会在这次调用内自动建立和销毁。';

/** 把 CLI 管理的会话工具从工具集合里滤掉，用于 --list 和名字解析。 */
export function listCliTools(tools: Map<string, CollectedTool>): Map<string, CollectedTool> {
  const visible = new Map<string, CollectedTool>();
  for (const [name, tool] of tools) {
    if (CLI_MANAGED_SESSION_TOOLS.has(name)) continue;
    visible.set(name, tool);
  }
  return visible;
}

export function formatFailure(err: unknown): string {
  if (err instanceof AppError) {
    return err.hint ? `${err.message}${NEWLINE}提示：${err.hint}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 把守护进程回来的 `{ error: { message, hint } }` 载荷渲染成**和 `formatFailure`
 * 一模一样**的纯文本。
 *
 * 为什么需要它：用法错误（工具没跑，退出码 1）在一次性路径上是一个被抛出来的
 * `AppError`，由 `formatFailure` 渲染成两行中文；同一个失败经过守护进程时，它在
 * 那边就已经被 `toErrorPayload` 拍平成了 JSON 载荷。退出码上一轮已经统一过了，
 * 渲染没有——于是同一条命令、同一个错误，跑没跑过 `cli start` 决定了用户看到的是
 * 中文两行还是一坨 JSON。更糟的是文档教的是"stderr 上的 `{"error":…}` 信封意味着
 * 退出码 2（工具跑了、iCloud 这么回答）"，而这里的 JSON 恰恰意味着工具**没跑**。
 *
 * 认不出这个形状时原样回退到 JSON——那至少不会丢信息。
 */
export function formatErrorPayload(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'error' in value) {
    const error = (value as { error: unknown }).error;
    if (error !== null && typeof error === 'object') {
      const { message, hint } = error as { message?: unknown; hint?: unknown };
      if (typeof message === 'string') {
        return typeof hint === 'string' && hint.length > 0 ? `${message}${NEWLINE}提示：${hint}` : message;
      }
    }
  }
  return JSON.stringify(value, null, 2);
}

/**
 * `--list` 每行只印第一句。
 *
 * 光取第一行是不够的：工具描述是靠字符串拼接写出来的，里面**一个换行都没有**，
 * 于是整段（`contacts_search` 实测 798 字符，`calendar_list_events` 385）会原样
 * 印在一行上，`--list` 就不再是一份能扫一眼的清单了。完整描述仍然在
 * `<tool> --help` 里，一个字都没少——这里砍掉的只是清单视图里的后续句子。
 *
 * 切分点是第一个句号（工具描述全是中文，第一句都以 `。` 结尾）。找不到句号时
 * 退回整个第一行，而不是靠字符数硬截——按长度截断会把一句话拦腰砍断，比印全还难读。
 */
function firstSentence(description: string): string {
  const firstLine = description.split(NEWLINE)[0] ?? '';
  const stop = firstLine.indexOf('。');
  return stop === -1 ? firstLine : firstLine.slice(0, stop + 1);
}

function renderToolList(tools: Map<string, CollectedTool>): string {
  const names = [...tools.keys()].sort();
  const lines = names.map((name) => {
    const tool = tools.get(name);
    const description = tool ? firstSentence(tool.config.description) : '';
    return name + '  ' + description;
  });
  return lines.join(NEWLINE) + NEWLINE;
}

/**
 * 多账号拒绝时列出账号，帮调用方看清现在配置了什么，而不是丢一句干巴巴的报错。
 * 导出给 `bin/cli.ts` 的 `start` 子命令复用——daemon 同样一次只服务一个账号，
 * 拒绝文案不该在两处各写一份、日后各自漂移。
 */
export function multiAccountRefusal(config: AppConfig): string {
  const names = config.accounts.map((a) => a.label).join('、');
  return (
    `已配置 ${config.accounts.length} 个账号（${names}）：命令行的一次性执行模式一次只服务一个账号，` +
    '不会替你猜选哪一个。' +
    NEWLINE +
    '把不同账号拆分到各自的 .env 文件里，分别用各自的沙盒/routine 运行；用 apple_accounts 可以看到当前一共配置了哪些账号。' +
    NEWLINE
  );
}

export interface RunCliDeps {
  config: AppConfig;
  logger: Logger;
  tools: Map<string, CollectedTool>;
  sessionFactory: SessionFactory;
}

export interface RunCliOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `resolveCall` 的结果：要么已经是终态输出（usage 错误、--list、--help、排除、多账号拒绝、
 *  flag 解析失败），要么是一次已经解析好、可以真正执行的调用。 */
type ResolvedCall = { kind: 'outcome'; outcome: RunCliOutcome } | { kind: 'call'; toolName: string; args: Record<string, unknown> };

/**
 * 把 argv 解析成"该直接输出什么"或"该执行哪个工具、带什么参数"，不做任何执行。
 * `runCli`（一次性模式）和 `runCliDaemonFirst`（先试 daemon 再退回一次性）共享
 * 这同一段解析——两者的区别只在于拿到一个已解析调用之后怎么执行它，解析规则
 * （排除名单、多账号拒绝、flag 校验……）必须完全一致，不能有第二份copy。
 */
function resolveCall(deps: Pick<RunCliDeps, 'config' | 'tools'>, argv: string[]): ResolvedCall {
  const { config } = deps;
  const visibleTools = listCliTools(deps.tools);

  const toolName = argv[0];
  if (toolName === undefined) {
    return { kind: 'outcome', outcome: { exitCode: 1, stdout: '', stderr: '缺少工具名，用 cli --list 查看全部工具' + NEWLINE } };
  }

  if (toolName === '--list') {
    return { kind: 'outcome', outcome: { exitCode: 0, stdout: renderToolList(visibleTools), stderr: '' } };
  }

  if (CLI_MANAGED_SESSION_TOOLS.has(toolName)) {
    return { kind: 'outcome', outcome: { exitCode: 1, stdout: '', stderr: SESSION_MANAGED_MESSAGE + NEWLINE } };
  }

  const tool = visibleTools.get(toolName);
  if (!tool) {
    return {
      kind: 'outcome',
      outcome: { exitCode: 1, stdout: '', stderr: `未知工具：${toolName}${NEWLINE}用 cli --list 查看全部工具${NEWLINE}` },
    };
  }

  const rest = argv.slice(1);
  const specs = deriveFlags(tool.config);

  if (rest[0] === '--help' || rest[0] === '-h') {
    return { kind: 'outcome', outcome: { exitCode: 0, stdout: renderHelp(toolName, tool.config, specs) + NEWLINE, stderr: '' } };
  }

  // apple_accounts 不需要账号解析（它就是用来看配置了哪些账号的），其余工具在
  // 多账号配置下一律拒绝——沉默地挑第一个账号是错的，宁可让调用方自己拆分 .env。
  if (toolName !== 'apple_accounts' && config.accounts.length > 1) {
    return { kind: 'outcome', outcome: { exitCode: 1, stdout: '', stderr: multiAccountRefusal(config) } };
  }

  let args: Record<string, unknown>;
  try {
    args = parseFlags(specs, rest);
  } catch (err) {
    return { kind: 'outcome', outcome: { exitCode: 1, stdout: '', stderr: formatFailure(err) + NEWLINE } };
  }

  return { kind: 'call', toolName, args };
}

/** 已解析调用的一次性执行路径：建隐式会话、跑、销毁——`executeOnce` 本身的行为。 */
async function executeAndFormat(deps: RunCliDeps, toolName: string, args: Record<string, unknown>): Promise<RunCliOutcome> {
  const { config, logger } = deps;
  const visibleTools = listCliTools(deps.tools);
  try {
    const result = await executeOnce(
      { config, logger, tools: visibleTools, sessionFactory: deps.sessionFactory },
      { tool: toolName, args },
    );
    if (result.isError) {
      return { exitCode: 2, stdout: '', stderr: JSON.stringify(result.value, null, 2) + NEWLINE };
    }
    return { exitCode: 0, stdout: JSON.stringify(result.value, null, 2) + NEWLINE, stderr: '' };
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: formatFailure(err) + NEWLINE };
  }
}

/**
 * `cli --list` / `cli <tool> --help` / `cli <tool> [flags...]` 的实际分派逻辑。
 * 只返回退出码和该写到 stdout/stderr 的文本，不做任何真正的 I/O 或
 * `process.exit`——那些副作用留给 `bin/cli.ts`，这样这里可以被直接单测，
 * 而且测的就是真正跑在生产路径上的这份代码，不是它的另一份重写。
 *
 * 调用方必须保证 `argv[0]` 已经不是顶层的 `undefined`/`--help`/`-h`——那两种
 * 不需要 config 就该能显示用法，由 `bin/cli.ts` 在建 config 之前处理掉。
 *
 * 这条路径永远走隐式会话（建立 → 执行 → 销毁），不管有没有 daemon 在跑。
 * 需要"有 daemon 就用它"的调用方用 `runCliDaemonFirst`。
 */
export async function runCli(deps: RunCliDeps, argv: string[]): Promise<RunCliOutcome> {
  const resolved = resolveCall(deps, argv);
  if (resolved.kind === 'outcome') return resolved.outcome;
  return executeAndFormat(deps, resolved.toolName, resolved.args);
}

export interface RunCliDaemonDeps extends RunCliDeps {
  /** 测试注入的端点文件位置；生产环境省略，用默认的临时目录路径。 */
  files?: EndpointFiles;
  /** 测试注入的超时旋钮，原样传给 callDaemon。生产路径（bin/cli.ts）
   *  从不传——见 client.ts 里 roundTrip 上的注释：请求字节写出去之后不该有总时长上限。 */
  timeouts?: ClientTimeouts;
}

/**
 * `bin/cli.ts` 真正对外暴露的 `cli <tool>` 分派：先试有没有一个活着的守护进程，
 * 能连上就用它已经建好的会话执行（省下这次调用本该重做的 TCP+TLS+AUTH 握手）；
 * 连不上——没启动、被杀掉、端点文件是僵死的——`callDaemon` 会自己清理端点文件
 * 并返回 `undefined`，这里随即原样退回 `executeAndFormat` 的一次性模式（并在
 * stderr 上说一声，见下面 catch 之外的 `logger.warn`——这条退回完全没有别的
 * 症状，用户拿到的结果照样正确，唯一的差别是悄悄多付了一次握手，不说清楚
 * 就没人会知道）。
 *
 * 用法解析（--list/--help/排除名单/多账号拒绝/flag 校验）与 `runCli` 共享同一个
 * `resolveCall`，只在"已经解析出一个要执行的调用"之后才分叉成两条执行路径——
 * 这条顺序不能反：先跑一次性模式、daemon 只是"顺便"，会让常驻会话形同虚设，
 * 每条命令还是在从头登录，而命令本身照样能跑通、没有任何症状。
 *
 * `callDaemon` 在"请求已经写给 daemon、但没能确认执行结果"时会抛而不是返回
 * `undefined`（`client.ts` 的 `RoundTripOutcome` 上有完整说明）——这里必须把
 * 那个异常当成一次失败直接报给调用方，绝不能落到下面的 `executeAndFormat`
 * 重跑一遍：daemon 可能已经真的执行了那次调用，对 `mail_send` 这类写操作，
 * 重试意味着用户会收到两封信。
 */
export async function runCliDaemonFirst(deps: RunCliDaemonDeps, argv: string[]): Promise<RunCliOutcome> {
  const resolved = resolveCall(deps, argv);
  if (resolved.kind === 'outcome') return resolved.outcome;

  const files = deps.files ?? endpointFiles();

  let hadEndpoint = false;
  let daemonResult;
  try {
    // 有没有端点文件，必须在 callDaemon **之前**问：连不上僵死端点时 callDaemon
    // 会顺手把文件删掉，事后再问永远得到"没有"——而"你启动过 daemon、它已经没了"
    // 恰恰是唯一值得说一句的那种情况。
    //
    // 这一句必须和 callDaemon 落在**同一个 try 里**：`readEndpoint` 会在运行时
    // 目录属于别人时抛 PERMISSION_DENIED（那正是它存在的意义），放在 try 外面
    // 的话那个异常会一路冒到 bin/cli.ts 的 main().catch，用户看到的是带
    // "apple-icloud-mcp cli 出错：" 前缀的兜底文案，而不是这里统一的错误渲染。
    hadEndpoint = (await readEndpoint(files)) !== undefined;
    daemonResult = await callDaemon(
      { tool: resolved.toolName, args: resolved.args, configFingerprint: configFingerprint(deps.config) },
      deps.files,
      deps.timeouts,
    );
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: formatFailure(err) + NEWLINE };
  }

  if (daemonResult) {
    // 参数没通过工具自己的 schema：工具没跑，这是用法错误（1），不是 iCloud 的
    // 回答（2）。一次性路径上这类失败是 executeAndFormat 的 catch 收的，同样是 1；
    // 两条路必须给出同一个退出码，否则同一条命令会因为"有没有 cli start"而分叉。
    if (daemonResult.usageError) {
      // 渲染也必须和一次性路径一致，不只是退出码——见 formatErrorPayload。
      return { exitCode: 1, stdout: '', stderr: formatErrorPayload(daemonResult.value) + NEWLINE };
    }
    if (daemonResult.isError) {
      return { exitCode: 2, stdout: '', stderr: JSON.stringify(daemonResult.value, null, 2) + NEWLINE };
    }
    return { exitCode: 0, stdout: JSON.stringify(daemonResult.value, null, 2) + NEWLINE, stderr: '' };
  }

  // 只在"确实有过一个端点"时才说。从没跑过 cli start 的用户——也就是绝大多数
  // 命令——本来就该走一次性模式，对他们每条命令都喊一句"守护进程不可用"，等于
  // 把唯一值得注意的那种情况（你启动过、它死了、你正在悄悄重新付握手）淹没在
  // 默认状态的噪声里。一个值表示两种意思，正是本阶段在测试里修过四次的形状。
  if (hadEndpoint) {
    deps.logger.warn('守护进程的端点文件还在，但连不上——它可能已经被杀掉或崩溃了；本次退回一次性会话', {
      tool: resolved.toolName,
    });
  }
  return executeAndFormat(deps, resolved.toolName, resolved.args);
}
