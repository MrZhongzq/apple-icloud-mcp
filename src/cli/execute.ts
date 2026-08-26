import { z } from 'zod';
import { findAccount, type AccountConfig, type AppConfig } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { createSessionStore } from '../core/session.js';
import { createProviders } from '../providers/icloud/index.js';
import type { Logger } from '../core/logger.js';
import type { CollectedTool } from './registry.js';

export interface ExecuteResult {
  /** 工具返回的 JSON（已从 MCP 的 content 信封里取出）。 */
  value: unknown;
  /** 工具以结构化错误失败时为 true；此时 value 是 { error: {...} }。 */
  isError: boolean;
}

/**
 * `executeOnce` 只需要"建一个会话、拿到 id、之后能销毁它"这三件事，不需要
 * `SessionStore` 的其余方法（get/destroyByToken/destroyAll/sweep/size）。
 * 用这个最小接口而不是直接复用 `SessionStore`，是为了让 Step 4 的假实现
 * 不必伪造一整个 `Session`（含 IMAP/SMTP/CalDAV/CardDAV provider）——
 * 真实的 `createSessionStore(...)` 结构上天然满足这个更窄的接口，不需要转换。
 */
export interface CliSessionHandle {
  id: string;
}

export interface CliSessionStore {
  create(account: AccountConfig): CliSessionHandle;
  destroy(id: string): Promise<boolean>;
}

/**
 * 会话工厂：调用一次得到本次执行要用来建会话/销会话的 store。
 *
 * **生产环境下这个 store 必须和构建 `tools`（即调用 `collectTools` 时）用的
 * 是同一个实例**——工具 handler 内部（例如 `mail_search`）会用它自己闭包里的
 * `SessionStore.get(session_id)` 去找会话；如果 `executeOnce` 用另一个 store
 * 创建会话，注入的 `session_id` 在 handler 眼里会是一个不存在的会话，报
 * `SESSION_EXPIRED`。`src/bin/cli.ts` 因此总是显式传入
 * `sessionFactory: () => sessions`（那个与 `collectTools` 共享的单例）。
 *
 * 这里的默认值（新建一个 store）只是给独立使用 `executeOnce` 的场景（如测试）
 * 兜底，不是生产路径依赖的行为。
 */
export type SessionFactory = () => CliSessionStore;

/**
 * 生产默认的会话工厂：新建一个自己的 store。给独立使用 `executeOnce` / `runBatch`
 * 的场景（如测试）兜底，不是 `bin/cli.ts` 那条生产路径依赖的行为——那条路径总是
 * 显式传入与 `collectTools` 共享的那个单例（见上面 `SessionFactory` 的注释）。
 */
export function defaultSessionFactory(config: AppConfig, logger: Logger): SessionFactory {
  return () =>
    createSessionStore({
      ttlMs: config.sessionTtlMs,
      providerFactory: (account) => createProviders(account, { logger, imapIdleTimeoutMs: config.imapIdleTimeoutMs }),
    });
}

function parseToolJson(toolName: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    // 解析失败要抛一个说明清楚的错误，不能把原始文本直接吐给调用方——
    // 那样调用方拿到的要么是垃圾数据要么是一个静默的 undefined。
    throw new AppError('INTERNAL', `工具 ${toolName} 的返回不是合法 JSON`, { cause: err });
  }
}

/**
 * 参数没通过工具自己的 schema。单独一个类型，是因为它和"工具执行后报错"
 * 必须落在不同的退出码上：工具**根本没跑**，这是一次用法错误（退出 1），
 * 不是 iCloud 那边的回答（退出 2）。守护进程那条路要把这个区别带过线，
 * 见 `daemon.ts` 的 `usageError` 与 `client.ts` 的 `DaemonResult`。
 */
export class ToolArgsError extends AppError {}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map((seg) => String(seg)).join('.');
      return path.length > 0 ? `${path}：${issue.message}` : issue.message;
    })
    .join('；');
}

/**
 * 用工具**自己的** schema 校验一次参数。
 *
 * 这条检查存在，是因为命令行这条路上没有别人会做它：stdio 与 HTTP 两个入口的
 * 参数校验发生在 MCP SDK 里——SDK 拿 `inputSchema` 解析完再调 handler——而 CLI
 * 直接调 `collectTools` 收集到的那个 handler，SDK 那一层根本不在路径上。于是同一批
 * handler 在两个入口有前置条件、在第三个入口没有，而它们是**按"有"写的**：
 * `{"limit":"five"}` 只是看得见的那一角，真正没有症状的是拿字符串去做算术或索引。
 *
 * `z.strictObject(tool.config.inputSchema)` 不是 schema 的第二份副本，它**就是**那份
 * schema——`inputSchema` 是 ZodRawShape，工具注册时交给 SDK 的也是同一个对象。
 *
 * 用 strict 而不是默认的剥离行为：多出来的键必须**拒绝**，不能悄悄丢掉。丢掉一个
 * 参数正是这一阶段反复在清除的那种"看起来成功了、其实干了别的事"。上游两条路
 * （`flags.ts` 只按 schema 生成 flag；`batch.ts` 的整批校验查键名）都已经挡过一次，
 * 所以这里的 strict 是一道**永远不该被触发的兜底**——真触发了，说明上游漏了。
 */
export function validateToolArgs(tool: CollectedTool, args: Record<string, unknown>): Record<string, unknown> {
  const schema = z.strictObject(tool.config.inputSchema);
  const result = schema.safeParse(args);
  if (result.success) {
    // 返回解析结果而不是原始对象，是为了和 MCP 入口拿到的东西一致：SDK 交给
    // handler 的就是解析产物。今天两者在结构上完全相同（25 个工具的 schema 里
    // 没有任何 default/transform/coerce），所以这不改变任何现有行为；但日后
    // 谁给某个字段加了 `.default()`，CLI 会和 MCP 一样应用它，而不是悄悄分叉。
    return result.data as Record<string, unknown>;
  }
  throw new ToolArgsError('INVALID_INPUT', `工具 ${tool.name} 的参数不合法：${describeIssues(result.error.issues)}`, {
    hint: `用 cli ${tool.name} --help 查看该工具接受哪些参数；参数没通过校验时工具没有被执行`,
  });
}

/**
 * 调一次工具 handler，并把 MCP 的 content 信封拆成 `ExecuteResult`。
 *
 * 单独抽出来是因为批量模式（`batch.ts`）要在**同一个**会话里连着调很多次，
 * 不能复用 `executeOnce`（它每次都建会话、销会话，正是批量模式要省掉的东西）。
 * 抽成一个共享函数而不是在 batch.ts 里重写一遍，是为了让"空 content"和
 * "返回不是合法 JSON"这两种畸形返回在两条路径上是同一套处理——两份副本迟早
 * 会有一份漏掉其中一种，而漏掉的那种在这里的表现是 `undefined` 静默流到 stdout。
 */
export async function invokeTool(tool: CollectedTool, args: Record<string, unknown>): Promise<ExecuteResult> {
  // 校验放在这里、而不是各调用方各写一遍：一次性模式（executeOnce）、批量模式
  // （batch.ts）和守护进程（daemon.ts）三条路全部经过这一个函数，这是 CLI 里
  // 唯一一个"handler 即将被调用"的收口点。而且它在 session_id 注入**之后**——
  // 注入进去的那个值也要像别的参数一样被检查，不能成为全场唯一没人验过的字段。
  const checked = validateToolArgs(tool, args);
  const result = await tool.handler(checked);
  const first = result.content[0];
  if (!first) {
    throw new AppError('INTERNAL', `工具 ${tool.name} 返回了空的 content`);
  }
  const value = parseToolJson(tool.name, first.text);
  return { value, isError: result.isError === true };
}

/**
 * 在一个隐式会话里执行一次工具调用：建会话 → 注入 session_id → 调用 → 销毁。
 * 会话的销毁放在 finally，任何失败路径都不会漏掉连接。
 */
export async function executeOnce(
  deps: {
    config: AppConfig;
    logger: Logger;
    tools: Map<string, CollectedTool>;
    sessionFactory?: SessionFactory;
  },
  call: { tool: string; args: Record<string, unknown> },
): Promise<ExecuteResult> {
  const { config, logger, tools } = deps;

  const tool = tools.get(call.tool);
  if (!tool) {
    throw new AppError('NOT_FOUND', `未知工具：${call.tool}`, { hint: '用 --list 查看全部可用工具' });
  }

  // 判断依据是 schema 里有没有 session_id，不是硬编码工具名单——
  // 名单会在加新工具时悄悄过时，而这个检查随 schema 自动更新。
  const needsSession = 'session_id' in tool.config.inputSchema;

  const args: Record<string, unknown> = { ...call.args };
  let store: CliSessionStore | undefined;
  let sessionId: string | undefined;

  if (needsSession) {
    const factory = deps.sessionFactory ?? defaultSessionFactory(config, logger);
    store = factory();
    const account = findAccount(config);
    const session = store.create(account);
    sessionId = session.id;
    args.session_id = sessionId;
  }

  try {
    return await invokeTool(tool, args);
  } finally {
    // 销毁必须在这里，不能只在成功路径上做——它关的是 IMAP/SMTP 连接，
    // handler 抛异常时同样必须关掉，否则进程退出时还留着一条打开的 socket。
    if (store && sessionId) {
      await store.destroy(sessionId);
    }
  }
}
