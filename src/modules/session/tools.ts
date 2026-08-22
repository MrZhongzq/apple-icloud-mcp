import { z } from 'zod';
import { findAccount, type AppConfig } from '../../core/config.js';
import { wrapTool } from '../../server/wrap.js';
import type { ToolDeps, ToolRegistrar } from '../../server/types.js';

export interface SessionToolDeps extends ToolDeps {
  config: AppConfig;
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
        capabilities: account.capabilities,
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
        capabilities: account.capabilities,
      };
    }),
  );

  server.registerTool(
    'work_done',
    {
      title: '结束会话',
      description:
        '销毁会话、关闭连接并清除内存中的凭据。完成全部 iCloud 相关任务后必须调用。',
      inputSchema: { session_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrapTool(logger, 'work_done', async (args: { session_id: string }) => ({
      success: await sessions.destroy(args.session_id),
    })),
  );
}
