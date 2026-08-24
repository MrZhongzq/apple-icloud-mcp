import { z } from 'zod';
import { findAccount, type AppConfig } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
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
        '建立会话并返回 session_id，后续所有工具都需要它。会真正连接一次该账号已开启能力所需的协议' +
        '（邮件走 IMAP、日历/提醒事项走 CalDAV、通讯录走 CardDAV）验证凭据，因此凭据错误会在这一步立即暴露。单账号时 account 可省略。',
      inputSchema: {
        account: z.string().optional().describe('要登录的 iCloud 邮箱，单账号时可省略'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(logger, 'apple_login', async (args: { account?: string }) => {
      const account = findAccount(config, args.account);

      // 每个协议只在它服务的能力真的开着时才验证。无条件验证 IMAP 会把
      // core/config.ts 的 iCloud 发信域名保护整个反过来用：那条保护对一个
      // Gmail 版 Apple ID 关掉 mailRead/mailWrite 并承诺"日历、提醒事项与通讯录
      // 不受影响"，可登录仍然拿这个非 iCloud 用户名去连 IMAP，Apple 直接拒绝，
      // 会话随即销毁、返回 AUTH_FAILED——于是 session_id 根本发不出来，其它模块
      // 一个都用不了。CardDAV 则是另一个方向的同一个毛病：从来没被验证过。
      const caps = account.capabilities;
      const needsImap = caps.mailRead || caps.mailWrite;
      const needsCalDav = caps.calendarRead || caps.calendarWrite || caps.remindersRead || caps.remindersWrite;
      const needsCardDav = caps.contactsRead || caps.contactsWrite;

      if (!needsImap && !needsCalDav && !needsCardDav) {
        throw new AppError('PERMISSION_DENIED', `账号 ${account.label} 没有开启任何能力，登录没有意义`, {
          hint: '至少把 ALLOW_MAIL_READ_n / ALLOW_CALENDAR_READ_n / ALLOW_REMINDERS_READ_n / ALLOW_CONTACTS_READ_n 之一设为 true 后重启服务',
        });
      }

      const session = sessions.create(account);

      try {
        if (needsImap) await session.providers.imap.verify();
        if (needsCalDav) await session.providers.caldav.verify();
        if (needsCardDav) await session.providers.carddav.verify();
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
