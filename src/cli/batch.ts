import { findAccount } from '../core/config.js';
import { AppError, toErrorPayload } from '../core/errors.js';
import { defaultSessionFactory, invokeTool } from './execute.js';
import { CLI_MANAGED_SESSION_TOOLS, SESSION_MANAGED_MESSAGE, multiAccountRefusal } from './dispatch.js';
import type { SessionFactory, CliSessionStore } from './execute.js';
import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { CollectedTool } from './registry.js';

// 与本目录其余文件一致：不写反斜杠转义序列。
const NEWLINE = String.fromCharCode(10);

export interface BatchOp {
  tool: string;
  args?: Record<string, unknown>;
}

export interface BatchOutcome {
  tool: string;
  ok: boolean;
  value: unknown;
}

export interface RunBatchDeps {
  config: AppConfig;
  logger: Logger;
  tools: Map<string, CollectedTool>;
  /** 与 `executeOnce` 同义：生产路径必须传入与 `collectTools` 共享的那个 store。 */
  sessionFactory?: SessionFactory;
}

export interface RunBatchOptions {
  /** true 时首个失败即停止，返回已经跑完的那几条；默认跑完全部。 */
  stopOnError?: boolean;
}

/** 一条已经通过校验、可以直接执行的操作：工具已解析，是否需要会话已判定。 */
interface PlannedOp {
  op: BatchOp;
  tool: CollectedTool;
  needsSession: boolean;
}

/**
 * 整批先校验，全部通过才开始执行。
 *
 * 这条顺序是批量模式最重要的性质，不是风格问题：边跑边查的话，一个把第三条
 * 拼错成 `mail_snd` 的 ops.json 会先把前两条**真的执行掉**（可能已经发了信、
 * 删了邮件），然后才报"未知工具"——副作用已经发生，而调用方看到的是一次失败，
 * 会很自然地改完拼写重跑一遍，于是前两条又执行了第二次。
 *
 * 三类拒绝都在这里，理由各不相同：
 *
 * 1. **`apple_login` / `work_done`**：批量模式是继 `dispatch.ts` 之后第二条
 *    进入执行的路径，同一条排除必须在这里再做一次，否则一份写着
 *    `{"tool":"work_done"}` 的 ops.json 就绕过了它——而且绕过之后的表现正是
 *    Task 2 要防的那个形状：用户读到 `{"success": true}`，以为关掉了什么，
 *    实际被销毁的是 CLI 刚给这一批建出来、还没被任何 handler 用过的空会话，
 *    并且这一批**剩下的操作**从此拿着一个已销毁的 session_id 继续跑。
 * 2. **未知工具**：见上面整段。
 * 3. **args 里写了 `session_id`**：会话由 CLI 自己管理，`session_id` 在命令行
 *    这一侧不存在（flags.ts 的 INJECTED_KEYS 保证它不会变成 flag）。但批量模式
 *    的参数来自 JSON，调用方完全写得出这个字段。这里必须**明确拒绝**而不是
 *    静默覆盖：静默覆盖会让人以为自己传进去的那个 id 生效了（例如以为可以接着
 *    上一次 `apple_login` 的会话继续用），而实际上它被丢掉了——同样是一次
 *    "看起来成功了、其实不是你要的那件事"。
 */
function planBatch(deps: Pick<RunBatchDeps, 'config' | 'tools'>, ops: readonly BatchOp[]): PlannedOp[] {
  const planned: PlannedOp[] = [];

  for (const [index, op] of ops.entries()) {
    const where = `第 ${index + 1} 条操作`;

    // 必须排在工具表查找之前：`work_done` 是**存在**于工具表里的，
    // 先查表就会查到它、然后照常执行。
    if (CLI_MANAGED_SESSION_TOOLS.has(op.tool)) {
      throw new AppError('INVALID_INPUT', `${where}（${op.tool}）不能出现在批量操作里。${NEWLINE}${SESSION_MANAGED_MESSAGE}`, {
        hint: '批量模式会自己建一个会话跑完整批操作、结束时销毁，把这一条从 ops 文件里删掉即可',
      });
    }

    const tool = deps.tools.get(op.tool);
    if (!tool) {
      throw new AppError('NOT_FOUND', `${where}引用了未知工具：${op.tool}`, {
        hint: '用 cli --list 查看全部可用工具；整批操作都没有执行',
      });
    }

    if (op.args !== undefined && 'session_id' in op.args) {
      throw new AppError('INVALID_INPUT', `${where}（${op.tool}）的 args 里带了 session_id，批量模式不接受这个字段。`, {
        hint: '会话由 CLI 自己建立和销毁（整批共用一个），传进来的 session_id 不会生效，所以这里直接拒绝而不是悄悄覆盖它；把该字段删掉即可',
      });
    }

    // args 里的键必须在工具自己的 schema 里。这条检查在这里、而不是靠工具去发现，
    // 是因为**命令行这条路上没有别人会做它**：MCP SDK 的 zod 校验发生在 SDK 那一层，
    // CLI 直接调收集到的 handler，那一层根本不在路径上。少了它，一份把 `limit`
    // 拼成 `limt` 的 ops.json 会静默地按"没传这个参数"执行——拿回 20 条而不是 5 条，
    // 没有任何报错，退出码 0。同样地，`args` 拼成 `arg`（见 parseBatchOps）会让整条
    // 操作变成"不带任何参数地调用"。两种都是这一阶段在反复清除的那种"悄悄干了别的事"。
    //
    // 只查键名，不查类型：值的类型该由工具自己的 zod schema 说了算，在这里再写一份
    // 类型校验就是同一份真相的第二个副本（`flags.ts` 的 FlagSpec.choices 上有同样的
    // 注释）。键名不一样——schema 里有哪些键是这一层能无歧义知道的事实。
    const allowedKeys = Object.keys(tool.config.inputSchema);
    for (const key of Object.keys(op.args ?? {})) {
      if (!allowedKeys.includes(key)) {
        const usable = allowedKeys.filter((k) => k !== 'session_id');
        throw new AppError('INVALID_INPUT', `${where}（${op.tool}）的 args 里有一个该工具不认识的参数：${key}`, {
          hint:
            (usable.length > 0 ? `${op.tool} 接受的参数是：${usable.join('、')}。` : `${op.tool} 不接受任何参数。`) +
            '拼错的参数会被静默当成"没传"，所以这里直接拒绝整批；用 cli ' +
            op.tool +
            ' --help 可以看到每个参数的含义',
        });
      }
    }

    planned.push({ op, tool, needsSession: 'session_id' in tool.config.inputSchema });
  }

  // 与一次性模式（dispatch.ts 的 resolveCall）同一条规则、同一段文案：多账号下
  // 不替调用方猜账号。`apple_accounts` 例外，它就是用来看配了哪些账号的。
  if (deps.config.accounts.length > 1 && planned.some((p) => p.op.tool !== 'apple_accounts')) {
    throw new AppError('INVALID_INPUT', multiAccountRefusal(deps.config).trim());
  }

  return planned;
}

/**
 * 校验一份来自文件/标准输入的 ops JSON。放在这里而不是 `bin/cli.ts` 里，
 * 是为了它能被直接单测——入口脚本"加载即执行"，没法安全地 import 进测试。
 */
export function parseBatchOps(text: string): BatchOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AppError('INVALID_INPUT', '批量操作文件不是合法 JSON', {
      cause: err,
      hint: '文件内容应形如 [{"tool":"mail_search","args":{"limit":5}}]',
    });
  }

  if (!Array.isArray(parsed)) {
    throw new AppError('INVALID_INPUT', '批量操作文件的顶层必须是一个数组', {
      hint: '文件内容应形如 [{"tool":"mail_search","args":{"limit":5}}]',
    });
  }

  const ops: BatchOp[] = [];
  for (const [index, raw] of parsed.entries()) {
    const where = `第 ${index + 1} 条操作`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AppError('INVALID_INPUT', `${where}不是一个对象`, { hint: '每一条都应形如 {"tool":"...","args":{...}}' });
    }
    const obj = raw as Record<string, unknown>;
    // 操作对象上只允许 tool 和 args 两个键。多出来的键**一定**是打错了，而打错的
    // 后果是静默的：`arg` 而不是 `args`，整条操作就变成"不带任何参数地调用这个工具"，
    // 照常执行、照常返回一个像模像样的结果。
    for (const key of Object.keys(obj)) {
      if (key !== 'tool' && key !== 'args') {
        throw new AppError('INVALID_INPUT', `${where}有一个多余的键：${key}`, {
          hint: '每一条操作只接受 tool 和 args 两个键；args 少写一个 s 会让整条操作变成"不带参数调用"，所以这里直接拒绝',
        });
      }
    }
    if (typeof obj.tool !== 'string' || obj.tool.length === 0) {
      throw new AppError('INVALID_INPUT', `${where}缺少 tool 字段（必须是非空字符串）`, {
        hint: '每一条都应形如 {"tool":"...","args":{...}}',
      });
    }
    if (obj.args === undefined) {
      ops.push({ tool: obj.tool });
      continue;
    }
    if (obj.args === null || typeof obj.args !== 'object' || Array.isArray(obj.args)) {
      throw new AppError('INVALID_INPUT', `${where}（${obj.tool}）的 args 必须是一个对象`, {
        hint: '不需要参数时整个省略 args 即可',
      });
    }
    ops.push({ tool: obj.tool, args: obj.args as Record<string, unknown> });
  }

  return ops;
}

/**
 * 一次会话跑完一串操作。
 *
 * 批量模式存在的唯一理由就是这个"一次"：一次性模式每条命令都要重做
 * TCP + TLS + IMAP AUTH 握手，二十条只读操作里十九次握手是白花的。这里
 * 在整批开始前建**一个**会话，全部操作共用，`finally` 销毁——任何失败路径
 * （包括某一条抛异常）都不会漏掉那条 IMAP 连接。
 *
 * 默认不因单条失败中断：批量里最常见的形态是一串只读查询，其中一条撞上
 * `NOT_FOUND` 不该让后面十九条都不跑。要"首个失败即停"（写操作串联、后一条
 * 依赖前一条成功）就传 `stopOnError: true`。
 */
export async function runBatch(deps: RunBatchDeps, ops: readonly BatchOp[], opts: RunBatchOptions = {}): Promise<BatchOutcome[]> {
  const planned = planBatch(deps, ops);

  let store: CliSessionStore | undefined;
  let sessionId: string | undefined;
  if (planned.some((p) => p.needsSession)) {
    const factory = deps.sessionFactory ?? defaultSessionFactory(deps.config, deps.logger);
    store = factory();
    sessionId = store.create(findAccount(deps.config)).id;
  }

  const outcomes: BatchOutcome[] = [];
  try {
    for (const { op, tool, needsSession } of planned) {
      const args: Record<string, unknown> = { ...op.args };
      if (needsSession && sessionId !== undefined) {
        args.session_id = sessionId;
      }

      let outcome: BatchOutcome;
      try {
        const result = await invokeTool(tool, args);
        outcome = { tool: op.tool, ok: !result.isError, value: result.value };
      } catch (err) {
        // handler 本身抛异常（正常情况下 server/wrap.ts 已经把异常收成结构化
        // 错误，走不到这里）——转成同样的错误载荷形状，让 stdout 上的每一条
        // outcome 都是同一种结构，调用方不用为这一种情况写第二套解析。
        deps.logger.warn('批量操作抛出异常', { tool: op.tool });
        outcome = { tool: op.tool, ok: false, value: toErrorPayload(err) };
      }

      outcomes.push(outcome);
      if (!outcome.ok && opts.stopOnError === true) break;
    }
  } finally {
    if (store && sessionId !== undefined) {
      await store.destroy(sessionId);
    }
  }

  return outcomes;
}
