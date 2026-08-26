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

function defaultSessionFactory(config: AppConfig, logger: Logger): SessionFactory {
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
    const result = await tool.handler(args);
    const first = result.content[0];
    if (!first) {
      throw new AppError('INTERNAL', `工具 ${call.tool} 返回了空的 content`);
    }
    const value = parseToolJson(call.tool, first.text);
    return { value, isError: result.isError === true };
  } finally {
    // 销毁必须在这里，不能只在成功路径上做——它关的是 IMAP/SMTP 连接，
    // handler 抛异常时同样必须关掉，否则进程退出时还留着一条打开的 socket。
    if (store && sessionId) {
      await store.destroy(sessionId);
    }
  }
}
