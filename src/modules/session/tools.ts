import { z } from 'zod';
import { findAccount, type AppConfig, type Capabilities } from '../../core/config.js';
import { wrapTool } from '../../server/wrap.js';
import type { ToolDeps, ToolRegistrar } from '../../server/types.js';

export interface SessionToolDeps extends ToolDeps {
  config: AppConfig;
}

/** apple_login / apple_accounts 对外投影的能力字段。 */
type PublicCapabilities = Omit<Capabilities, 'contactsRead' | 'contactsWrite'>;

/**
 * contactsRead/contactsWrite 不对外投影：config 已经解析它们（下一阶段要用），但本阶段
 * 没有任何联系人工具，SKILL.md 也明确写着联系人不可用。原样回显 capabilities 会让每次
 * 登录都告诉模型 contactsRead: true，而它随后找不到任何能用上这项能力的工具——一个只会
 * 制造错误计划的假承诺。等联系人模块真的存在时，再把这两个键加回来。
 */
function publicCapabilities(capabilities: Capabilities): PublicCapabilities {
  const { contactsRead: _contactsRead, contactsWrite: _contactsWrite, ...rest } = capabilities;
  return rest;
}

export function registerSessionTools(server: ToolRegistrar, deps: SessionToolDeps): void {
  const { sessions, logger, config } = deps;

  server.registerTool(
    'apple_accounts',
    {
      title: '列出已配置的 iCloud 账号',
      description:
        '返回服务端配置的账号及其读写权限。无需登录即可调用，用于在多账号时确定 apple_login 的 account 参数。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrapTool(logger, 'apple_accounts', async () =>
      config.accounts.map((account) => ({
        email: account.email,
        label: account.label,
        capabilities: publicCapabilities(account.capabilities),
      })),
    ),
  );

  server.registerTool(
    'apple_login',
    {
      title: '登录 iCloud',
      description:
        '建立会话并返回 session_id，后续所有工具都需要它。会真正连接一次 IMAP 与 CalDAV 验证凭据，因此凭据错误会在这一步立即暴露。单账号时 account 可省略。',
      inputSchema: {
        account: z.string().optional().describe('要登录的 iCloud 邮箱，单账号时可省略'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(logger, 'apple_login', async (args: { account?: string }) => {
      const account = findAccount(config, args.account);
      const session = sessions.create(account);

      try {
        await session.providers.imap.verify();
        await session.providers.caldav.verify();
      } catch (err) {
        await sessions.destroy(session.id);
        throw err;
      }

      logger.info('login ok', { account: account.email, session: session.id });
      return {
        session_id: session.id,
        account: account.email,
        label: account.label,
        capabilities: publicCapabilities(account.capabilities),
      };
    }),
  );

  server.registerTool(
    'work_done',
    {
      title: '结束会话',
      description:
        '销毁该 session_id 对应的会话、关闭其 IMAP/SMTP 连接，并使该 session_id 之后不能再使用。' +
        '完成全部 iCloud 相关任务后必须调用。',
      inputSchema: { session_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrapTool(logger, 'work_done', async (args: { session_id: string }) => ({
      success: await sessions.destroy(args.session_id),
    })),
  );
}
