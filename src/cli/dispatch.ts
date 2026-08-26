import { AppError } from '../core/errors.js';
import { deriveFlags, parseFlags, renderHelp } from './flags.js';
import { executeOnce, type SessionFactory } from './execute.js';
import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { CollectedTool } from './registry.js';

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

const SESSION_MANAGED_MESSAGE =
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

function renderToolList(tools: Map<string, CollectedTool>): string {
  const names = [...tools.keys()].sort();
  const lines = names.map((name) => {
    const tool = tools.get(name);
    const description = tool ? tool.config.description.split(NEWLINE)[0] : '';
    return name + '  ' + description;
  });
  return lines.join(NEWLINE) + NEWLINE;
}

/** 多账号拒绝时列出账号，帮调用方看清现在配置了什么，而不是丢一句干巴巴的报错。 */
function multiAccountRefusal(config: AppConfig): string {
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

/**
 * `cli --list` / `cli <tool> --help` / `cli <tool> [flags...]` 的实际分派逻辑。
 * 只返回退出码和该写到 stdout/stderr 的文本，不做任何真正的 I/O 或
 * `process.exit`——那些副作用留给 `bin/cli.ts`，这样这里可以被直接单测，
 * 而且测的就是真正跑在生产路径上的这份代码，不是它的另一份重写。
 *
 * 调用方必须保证 `argv[0]` 已经不是顶层的 `undefined`/`--help`/`-h`——那两种
 * 不需要 config 就该能显示用法，由 `bin/cli.ts` 在建 config 之前处理掉。
 */
export async function runCli(deps: RunCliDeps, argv: string[]): Promise<RunCliOutcome> {
  const { config, logger } = deps;
  const visibleTools = listCliTools(deps.tools);

  const toolName = argv[0];
  if (toolName === undefined) {
    return { exitCode: 1, stdout: '', stderr: '缺少工具名，用 cli --list 查看全部工具' + NEWLINE };
  }

  if (toolName === '--list') {
    return { exitCode: 0, stdout: renderToolList(visibleTools), stderr: '' };
  }

  if (CLI_MANAGED_SESSION_TOOLS.has(toolName)) {
    return { exitCode: 1, stdout: '', stderr: SESSION_MANAGED_MESSAGE + NEWLINE };
  }

  const tool = visibleTools.get(toolName);
  if (!tool) {
    return { exitCode: 1, stdout: '', stderr: `未知工具：${toolName}${NEWLINE}用 cli --list 查看全部工具${NEWLINE}` };
  }

  const rest = argv.slice(1);
  const specs = deriveFlags(tool.config);

  if (rest[0] === '--help' || rest[0] === '-h') {
    return { exitCode: 0, stdout: renderHelp(toolName, tool.config, specs) + NEWLINE, stderr: '' };
  }

  // apple_accounts 不需要账号解析（它就是用来看配置了哪些账号的），其余工具在
  // 多账号配置下一律拒绝——沉默地挑第一个账号是错的，宁可让调用方自己拆分 .env。
  if (toolName !== 'apple_accounts' && config.accounts.length > 1) {
    return { exitCode: 1, stdout: '', stderr: multiAccountRefusal(config) };
  }

  let args: Record<string, unknown>;
  try {
    args = parseFlags(specs, rest);
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: formatFailure(err) + NEWLINE };
  }

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
