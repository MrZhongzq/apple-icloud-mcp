import { z, type ZodRawShape } from 'zod';
import { findAccount, type AccountConfig, type AppConfig } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import { accessKeyIdFrom, tokenFamilyIdFrom } from '../../core/session.js';
import { wrapTool } from '../../server/wrap.js';
import type { ToolDeps, ToolRegistrar } from '../../server/types.js';

/**
 * 远程 HTTP 入口才有的登录规则。stdio / CLI 不传，两个工具的 schema 与行为与以前逐字相同。
 *
 * 远程入口是几个人共用一台服务器：`.env` 里的账号属于服务器主人，任何一把有效的访问密钥都能
 * 调 `apple_login`，所以 env 账号能不能用必须是主人在管理页上明确打开的开关，而不是默认可用。
 */
export interface RemoteLoginDeps {
  /** 每次调用都现读，不在注册时读一次：管理页随时可能切换它。 */
  envAccountsEnabled(): boolean;
  /** 解开一个加密信封，得到只活在这次会话里的账号。没有配置信封私钥时不传，`envelope` 参数也就不出现。 */
  openEnvelope?: (text: string) => { account: AccountConfig; notices: string[] };
}

export interface SessionToolDeps extends ToolDeps {
  config: AppConfig;
  remote?: RemoteLoginDeps;
}

const ENVELOPE_ONLY_HINT = '运行 node scripts/make-envelope.mjs，把它输出的一整行原样作为 envelope 参数传给 apple_login';

export function registerSessionTools(server: ToolRegistrar, deps: SessionToolDeps): void {
  const { sessions, logger, config, remote } = deps;
  const openEnvelope = remote?.openEnvelope;

  /** env 账号此刻是否可用：stdio / CLI 永远可用；远程入口看开关。 */
  const envAccountsUsable = (): boolean => remote === undefined || remote.envAccountsEnabled();

  const accountArg = z.string().optional().describe('要登录的 iCloud 邮箱，单账号时可省略');
  // 只有真的能解信封时才把 envelope 放进 schema：一个永远报错的参数只会误导模型去用它。
  const loginSchema: ZodRawShape = openEnvelope
    ? {
        account: accountArg,
        envelope: z
          .string()
          .optional()
          .describe('远程入口的登录凭据：运行 node scripts/make-envelope.mjs 得到的一整行，原样传入。与 account 二选一。'),
      }
    : { account: accountArg };

  /** 返回要登录的账号，以及它被自动降级时的说明（例如 Gmail 版 Apple ID 的邮件工具被关掉）。 */
  function resolveAccount(args: { account?: string; envelope?: string }): {
    account: AccountConfig;
    notices: string[];
  } {
    if (openEnvelope && args.envelope !== undefined) {
      if (args.account !== undefined) {
        throw new AppError('INVALID_INPUT', 'account 与 envelope 只能给一个', {
          hint: '用信封登录时只传 envelope；信封里已经带着账号',
        });
      }
      return openEnvelope(args.envelope);
    }
    // 先看开关、后找账号：开关关着时连"这个邮箱有没有配置"都不该透露。
    if (!envAccountsUsable()) {
      throw new AppError('INVALID_INPUT', '这台服务器只接受加密信封登录', { hint: ENVELOPE_ONLY_HINT });
    }
    const account = findAccount(config, args.account);
    return { account, notices: envNoticesFor(account) };
  }

  /**
   * config.notices 是启动时为所有 env 账号攒下的一张扁平列表，不按账号分组；这里挑出属于这个
   * 账号的那条。core/config.ts::parseAccount 写的每条说明都以"账号 <label>：发信地址 <sender> "开头，
   * label 与 sender 合在一起足以分清不同账号。
   */
  function envNoticesFor(account: AccountConfig): string[] {
    const prefix = `账号 ${account.label}：发信地址 ${account.sender} `;
    return config.notices.filter((notice) => notice.startsWith(prefix));
  }

  server.registerTool(
    'apple_accounts',
    {
      title: '列出已配置的 iCloud 账号',
      description:
        '返回服务端配置的账号及其读写权限。无需登录即可调用，用于在多账号时确认当前有哪些账号可用（MCP 客户端据此决定 apple_login 的 account 参数）。' +
        (remote ? '远程服务器只接受加密信封登录时这里返回空数组，这是正常的。' : ''),
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrapTool(logger, 'apple_accounts', async () =>
      // 开关关着时 env 账号对调用方而言不存在：列出来只会诱导模型拿 account 去登录然后被拒。
      envAccountsUsable()
        ? config.accounts.map((account) => ({
            email: account.email,
            label: account.label,
            capabilities: account.capabilities,
          }))
        : [],
    ),
  );

  server.registerTool(
    'apple_login',
    {
      title: '登录 iCloud',
      description:
        '建立会话并返回 session_id，后续所有工具都需要它。会真正连接一次该账号已开启能力所需的协议' +
        '（邮件走 IMAP、日历/提醒事项走 CalDAV、通讯录走 CardDAV）验证凭据，因此凭据错误会在这一步立即暴露。单账号时 account 可省略。',
      inputSchema: loginSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(logger, 'apple_login', async (args: { account?: string; envelope?: string }, extra) => {
      const { account, notices } = resolveAccount(args);

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
        // 信封账号：变量在用户自己的 .env 里，「重启服务」既做不到也没用（与 capabilityHint 同一口径）；
        // 消息也不带 label——它默认就是邮箱，而 wrapTool 会把这条消息记进日志。
        if (account.origin === 'envelope') {
          throw new AppError('PERMISSION_DENIED', '信封里的账号没有开启任何能力，登录没有意义', {
            hint: '在你自己的 .env 里把 ALLOW_MAIL_READ_1 / ALLOW_CALENDAR_READ_1 / ALLOW_REMINDERS_READ_1 / ALLOW_CONTACTS_READ_1 至少之一设为 true，重新生成信封后再登录',
          });
        }
        throw new AppError('PERMISSION_DENIED', `账号 ${account.label} 没有开启任何能力，登录没有意义`, {
          hint: '至少把 ALLOW_MAIL_READ_n / ALLOW_CALENDAR_READ_n / ALLOW_REMINDERS_READ_n / ALLOW_CONTACTS_READ_n 之一设为 true 后重启服务',
        });
      }

      // 远程 HTTP 入口下，这次调用是被某个 OAuth 访问令牌放行的；把那个令牌所属的家族
      // 登记到会话上，吊销该令牌时 `destroyByToken` 才找得到这条会话并真的关掉它的
      // IMAP/SMTP 连接。stdio 入口没有 authInfo，值为 undefined，行为与以前完全一致。
      const session = sessions.create(account, tokenFamilyIdFrom(extra), accessKeyIdFrom(extra));

      try {
        if (needsImap) await session.providers.imap.verify();
        if (needsCalDav) await session.providers.caldav.verify();
        if (needsCardDav) await session.providers.carddav.verify();
      } catch (err) {
        await sessions.destroy(session.id, accessKeyIdFrom(extra));
        throw err;
      }

      // 信封账号的邮箱来自解密后的载荷，不进日志；env 账号是部署者自己的配置，照旧记下。
      logger.info(
        'login ok',
        account.origin === 'envelope' ? { origin: 'envelope', session: session.id } : { account: account.email, session: session.id },
      );
      return {
        session_id: session.id,
        account: account.email,
        label: account.label,
        capabilities: account.capabilities,
        // 降级说明以前只写进服务端 stderr，调用方看不见，只会困惑于邮件工具为什么报权限不足。
        ...(notices.length > 0 ? { notices } : {}),
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
    wrapTool(logger, 'work_done', async (args: { session_id: string }, extra) => ({
      success: await sessions.destroy(args.session_id, accessKeyIdFrom(extra)),
    })),
  );
}
