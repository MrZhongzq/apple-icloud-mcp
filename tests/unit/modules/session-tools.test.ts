import { describe, it, expect, vi } from 'vitest';
import { registerSessionTools } from '../../../src/modules/session/tools.js';
import { createLogger } from '../../../src/core/logger.js';
import { accountFromEnvelopeEnv, loadConfig, type AppConfig } from '../../../src/core/config.js';
import { AppError } from '../../../src/core/errors.js';
import type { ToolConfig, ToolResult } from '../../../src/server/types.js';
import type { SessionStore } from '../../../src/core/session.js';

interface Registered {
  config: ToolConfig;
  handler: (args: any) => Promise<ToolResult>;
}

function collect(): { server: any; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: ToolConfig, handler: (args: any) => Promise<ToolResult>) {
      tools.set(name, { config, handler });
    },
  };
  return { server, tools };
}

const silentLogger = createLogger('error', () => {});

const config = loadConfig({
  ICLOUD_ACCOUNT_1: 'me@icloud.com',
  ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
  ICLOUD_LABEL_1: 'personal',
  ALLOW_MAIL_WRITE_1: 'true',
});

function makeSessions(providers: Record<string, unknown>, from: AppConfig = config) {
  const destroy = vi.fn().mockResolvedValue(true);
  const store = {
    create: vi.fn().mockReturnValue({
      id: 'session-abc',
      account: from.accounts[0],
      providers,
    }),
    get: vi.fn(),
    destroy,
    destroyAll: vi.fn(),
    sweep: vi.fn(),
    size: vi.fn().mockReturnValue(1),
  } as unknown as SessionStore;
  return { store, destroy };
}

function healthyProviders() {
  return {
    imap: { verify: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) },
    caldav: { verify: vi.fn().mockResolvedValue(undefined) },
    carddav: { verify: vi.fn().mockResolvedValue(undefined) },
    smtp: {},
  };
}

describe('apple_accounts', () => {
  it('lists configured accounts without requiring a session', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const shape = tools.get('apple_accounts')!.config.inputSchema;
    expect(Object.keys(shape)).toHaveLength(0);

    const result = await tools.get('apple_accounts')!.handler({});
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      {
        email: 'me@icloud.com',
        label: 'personal',
        capabilities: config.accounts[0]!.capabilities,
      },
    ]);
  });

  // Contacts tools are now registered (phase 2b), so apple_accounts must advertise the
  // full capability set again -- including contactsRead/contactsWrite -- rather than
  // projecting them out.
  it('advertises contacts capabilities now that contacts tools exist', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });
    const result = await tools.get('apple_accounts')!.handler({});
    const [entry] = JSON.parse(result.content[0]!.text) as Array<{ capabilities: Record<string, boolean> }>;
    expect(Object.keys(entry!.capabilities).sort()).toEqual([
      'calendarRead', 'calendarWrite', 'contactsRead', 'contactsWrite',
      'mailRead', 'mailWrite', 'remindersRead', 'remindersWrite',
    ]);
  });

  it('never exposes the app password', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });
    const result = await tools.get('apple_accounts')!.handler({});
    expect(result.content[0]!.text).not.toContain('abcd-efgh');
  });
});

describe('apple_login', () => {
  it('verifies imap and caldav before handing out a session id', async () => {
    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers);
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const result = await tools.get('apple_login')!.handler({});
    expect(providers.imap.verify).toHaveBeenCalled();
    expect(providers.caldav.verify).toHaveBeenCalled();
    expect(providers.carddav.verify).toHaveBeenCalled();

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.session_id).toBe('session-abc');
    expect(payload.account).toBe('me@icloud.com');
    expect(payload.label).toBe('personal');
    expect(payload.capabilities.mailWrite).toBe(true);
    expect(payload.capabilities).toHaveProperty('contactsRead');
    expect(payload.capabilities).toHaveProperty('contactsWrite');
    expect(payload, '没有降级说明时不带 notices 字段').not.toHaveProperty('notices');
  });

  it('destroys the session and reports AUTH_FAILED when verification fails', async () => {
    const { server, tools } = collect();
    const providers = healthyProviders();
    providers.imap.verify = vi
      .fn()
      .mockRejectedValue(new AppError('AUTH_FAILED', 'iCloud 拒绝了这组凭据'));
    const { store, destroy } = makeSessions(providers);
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const result = await tools.get('apple_login')!.handler({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('AUTH_FAILED');
    expect(destroy).toHaveBeenCalledWith('session-abc', undefined);
  });

  // core/config.ts 对一个非 iCloud 发信地址（典型：Gmail 版 Apple ID）关掉 mailRead/mailWrite，
  // 并明确承诺日历、提醒事项与通讯录不受影响。登录若仍无条件验证 IMAP，Apple 会拒绝这个
  // 非 iCloud 用户名，会话被销毁、返回 AUTH_FAILED——session_id 发不出来，等于把这条保护
  // 想保住的那些模块全部锁死。所以邮件关掉时 imap.verify 一次都不能调。
  it('logs in without touching IMAP when the account has no mail capability', async () => {
    const mailless = loadConfig({
      ICLOUD_ACCOUNT_1: 'me@gmail.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ICLOUD_LABEL_1: 'gmail-apple-id',
      ALLOW_MAIL_READ_1: 'true',
    });
    expect(mailless.accounts[0]!.capabilities.mailRead, 'the domain guard should have disabled mail').toBe(false);

    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store, destroy } = makeSessions(providers, mailless);
    registerSessionTools(server, { sessions: store, logger: silentLogger, config: mailless });

    const result = await tools.get('apple_login')!.handler({});
    const payload = JSON.parse(result.content[0]!.text);
    expect(result.isError).toBeUndefined();
    expect(payload.session_id).toBe('session-abc');
    expect(providers.imap.verify).not.toHaveBeenCalled();
    expect(providers.caldav.verify).toHaveBeenCalled();
    expect(providers.carddav.verify).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    // 降级说明原本只在启动时写进 stderr，调用方看不见；登录响应里要把属于这个账号的那条带上。
    expect(payload.notices).toEqual(mailless.notices);
    expect(payload.notices).toHaveLength(1);
  });

  it("surfaces only this account's notice when several env accounts were downgraded", async () => {
    const two = loadConfig({
      ICLOUD_ACCOUNT_1: 'one@gmail.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ICLOUD_ACCOUNT_2: 'two@gmail.com',
      ICLOUD_APP_PASSWORD_2: 'abcd-efgh-ijkl-mnop',
    });
    expect(two.notices).toHaveLength(2);

    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers, two);
    (store.create as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'session-two', account: two.accounts[1], providers });
    registerSessionTools(server, { sessions: store, logger: silentLogger, config: two });

    const payload = JSON.parse((await tools.get('apple_login')!.handler({ account: 'two@gmail.com' })).content[0]!.text);
    expect(payload.notices).toEqual([two.notices[1]]);
  });

  it('verifies only CalDAV for a calendar-and-reminders-only account', async () => {
    const calendarOnly = loadConfig({
      ICLOUD_ACCOUNT_1: 'me@icloud.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ALLOW_MAIL_READ_1: 'false',
      ALLOW_CONTACTS_READ_1: 'false',
    });

    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers, calendarOnly);
    registerSessionTools(server, { sessions: store, logger: silentLogger, config: calendarOnly });

    await tools.get('apple_login')!.handler({});
    expect(providers.imap.verify).not.toHaveBeenCalled();
    expect(providers.carddav.verify).not.toHaveBeenCalled();
    expect(providers.caldav.verify).toHaveBeenCalled();
  });

  it('refuses to hand out a session that could do nothing at all', async () => {
    const nothing = loadConfig({
      ICLOUD_ACCOUNT_1: 'me@icloud.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ALLOW_MAIL_READ_1: 'false',
      ALLOW_CALENDAR_READ_1: 'false',
      ALLOW_REMINDERS_READ_1: 'false',
      ALLOW_CONTACTS_READ_1: 'false',
    });

    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers, nothing);
    registerSessionTools(server, { sessions: store, logger: silentLogger, config: nothing });

    const result = await tools.get('apple_login')!.handler({});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe('PERMISSION_DENIED');
    expect(payload.error.hint).toContain('ALLOW_');
    expect(store.create).not.toHaveBeenCalled();
    expect(providers.imap.verify).not.toHaveBeenCalled();
    expect(providers.caldav.verify).not.toHaveBeenCalled();
    expect(providers.carddav.verify).not.toHaveBeenCalled();
  });

  it('reports NOT_FOUND for an unconfigured account', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const result = await tools.get('apple_login')!.handler({ account: 'other@icloud.com' });
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('NOT_FOUND');
  });
});

// 远程 HTTP 入口：几个人共用一台服务器。env 账号开关关着的时候，`.env` 里那个账号是主人的，
// 任何一把有效密钥都不能拿 `account`（或什么都不给）登进去——这正是"朋友登进主人 iCloud"
// 那个反目标的直接测试。stdio / CLI 不传 remote，行为与 schema 必须与今天逐字相同。
describe('apple_login / apple_accounts in remote mode', () => {
  it('remote mode with env accounts disabled refuses login without an envelope', async () => {
    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers);
    registerSessionTools(server, {
      sessions: store,
      logger: silentLogger,
      config,
      remote: { envAccountsEnabled: () => false },
    });

    for (const args of [{}, { account: 'me@icloud.com' }]) {
      const result = await tools.get('apple_login')!.handler(args);
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.error.code).toBe('INVALID_INPUT');
      expect(payload.error.message).toBe('这台服务器只接受加密信封登录');
      expect(payload.error.hint).toContain('make-envelope.mjs');
    }
    expect(store.create).not.toHaveBeenCalled();
    expect(providers.imap.verify).not.toHaveBeenCalled();
  });

  it('remote mode with env accounts disabled lists no accounts', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, {
      sessions: store,
      logger: silentLogger,
      config,
      remote: { envAccountsEnabled: () => false },
    });
    const result = await tools.get('apple_accounts')!.handler({});
    expect(JSON.parse(result.content[0]!.text)).toEqual([]);
  });

  it('remote mode with env accounts enabled logs in as today', async () => {
    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers);
    registerSessionTools(server, {
      sessions: store,
      logger: silentLogger,
      config,
      remote: { envAccountsEnabled: () => true },
    });

    const result = await tools.get('apple_login')!.handler({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text).session_id).toBe('session-abc');
    expect(store.create).toHaveBeenCalledWith(config.accounts[0], undefined, undefined);

    const listed = await tools.get('apple_accounts')!.handler({});
    expect(JSON.parse(listed.content[0]!.text)).toHaveLength(1);
  });

  it('reads the switch on every call, not once at registration', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    let enabled = true;
    registerSessionTools(server, {
      sessions: store,
      logger: silentLogger,
      config,
      remote: { envAccountsEnabled: () => enabled },
    });
    expect((await tools.get('apple_login')!.handler({})).isError).toBeUndefined();
    enabled = false;
    const refused = await tools.get('apple_login')!.handler({});
    expect(JSON.parse(refused.content[0]!.text).error.code).toBe('INVALID_INPUT');
  });

  it('without remote the schema has no envelope field', () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });
    expect(Object.keys(tools.get('apple_login')!.config.inputSchema)).toEqual(['account']);
  });

  it('remote without an envelope opener still has no envelope field', () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, {
      sessions: store,
      logger: silentLogger,
      config,
      remote: { envAccountsEnabled: () => true },
    });
    expect(Object.keys(tools.get('apple_login')!.config.inputSchema)).toEqual(['account']);
  });

  it('with an envelope opener the schema gains envelope, and giving both is INVALID_INPUT', async () => {
    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers);
    const openEnvelope = vi.fn();
    registerSessionTools(server, {
      sessions: store,
      logger: silentLogger,
      config,
      remote: { envAccountsEnabled: () => true, openEnvelope },
    });
    expect(Object.keys(tools.get('apple_login')!.config.inputSchema).sort()).toEqual(['account', 'envelope']);

    const result = await tools.get('apple_login')!.handler({ account: 'me@icloud.com', envelope: 'ame1.x' });
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('INVALID_INPUT');
    expect(openEnvelope).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });

  it('an envelope logs in with the account it opened, even with env accounts disabled', async () => {
    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers);
    const envelopeAccount = { ...config.accounts[0]!, email: 'friend@icloud.com', origin: 'envelope' as const };
    const openEnvelope = vi.fn().mockReturnValue({ account: envelopeAccount, notices: [] });
    registerSessionTools(server, {
      sessions: store,
      logger: silentLogger,
      config,
      remote: { envAccountsEnabled: () => false, openEnvelope },
    });

    const result = await tools.get('apple_login')!.handler({ envelope: 'ame1.sealed' });
    expect(result.isError).toBeUndefined();
    expect(openEnvelope).toHaveBeenCalledWith('ame1.sealed');
    expect(store.create).toHaveBeenCalledWith(envelopeAccount, undefined, undefined);
    expect(JSON.parse(result.content[0]!.text).account).toBe('friend@icloud.com');
  });

  // 能力全关时的提示要按来源说：env 账号改服务器的环境变量再重启；信封账号只能改自己的 .env、
  // 重新生成信封——叫一个信封用户去「重启服务」，他既做不到，也没用。
  it('the no-capability hint is origin-aware, and the env wording is unchanged', async () => {
    const nothingEnv = {
      ICLOUD_ACCOUNT_1: 'me@icloud.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ALLOW_MAIL_READ_1: 'false',
      ALLOW_CALENDAR_READ_1: 'false',
      ALLOW_REMINDERS_READ_1: 'false',
      ALLOW_CONTACTS_READ_1: 'false',
    };
    const nothing = loadConfig(nothingEnv);

    const envSide = collect();
    registerSessionTools(envSide.server, {
      sessions: makeSessions(healthyProviders(), nothing).store,
      logger: silentLogger,
      config: nothing,
    });
    const envError = JSON.parse((await envSide.tools.get('apple_login')!.handler({})).content[0]!.text).error;
    expect(envError.code).toBe('PERMISSION_DENIED');
    expect(envError.message).toBe('账号 me@icloud.com 没有开启任何能力，登录没有意义');
    expect(envError.hint).toBe(
      '至少把 ALLOW_MAIL_READ_n / ALLOW_CALENDAR_READ_n / ALLOW_REMINDERS_READ_n / ALLOW_CONTACTS_READ_n 之一设为 true 后重启服务',
    );

    const lines: string[] = [];
    const envelopeAccount = { ...nothing.accounts[0]!, email: 'friend@icloud.com', label: 'friend@icloud.com', origin: 'envelope' as const };
    const envelopeSide = collect();
    const { store } = makeSessions(healthyProviders(), nothing);
    registerSessionTools(envelopeSide.server, {
      sessions: store,
      logger: createLogger('debug', (line) => lines.push(line)),
      config: nothing,
      remote: { envAccountsEnabled: () => false, openEnvelope: () => ({ account: envelopeAccount, notices: [] }) },
    });
    const result = await envelopeSide.tools.get('apple_login')!.handler({ envelope: 'ame1.sealed' });
    const envelopeError = JSON.parse(result.content[0]!.text).error;
    expect(envelopeError.code).toBe('PERMISSION_DENIED');
    expect(envelopeError.hint).toBe(
      '在你自己的 .env 里把 ALLOW_MAIL_READ_1 / ALLOW_CALENDAR_READ_1 / ALLOW_REMINDERS_READ_1 / ALLOW_CONTACTS_READ_1 至少之一设为 true，重新生成信封后再登录',
    );
    expect(envelopeError.hint).not.toContain('重启服务');
    expect(store.create).not.toHaveBeenCalled();
    // 这条消息会经 wrapTool 进日志：信封账号的邮箱（label 默认就是邮箱）不能跟着进去。
    expect(lines.join('\n')).not.toContain('friend@icloud.com');
  });

  it('a successful envelope login never logs the account email', async () => {
    const lines: string[] = [];
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    const envelopeAccount = { ...config.accounts[0]!, email: 'friend@icloud.com', label: 'friend@icloud.com', origin: 'envelope' as const };
    registerSessionTools(server, {
      sessions: store,
      logger: createLogger('debug', (line) => lines.push(line)),
      config,
      remote: { envAccountsEnabled: () => false, openEnvelope: () => ({ account: envelopeAccount, notices: [] }) },
    });

    const result = await tools.get('apple_login')!.handler({ envelope: 'ame1.sealed' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text).account, '调用方自己仍然看得到').toBe('friend@icloud.com');
    const loginLine = lines.find((line) => line.includes('"login ok"'));
    expect(loginLine).toBeDefined();
    expect(JSON.parse(loginLine!).meta).toEqual({ origin: 'envelope', session: 'session-abc' });
    expect(lines.join('\n')).not.toContain('friend@icloud.com');
  });

  it('an env login still logs the account as before', async () => {
    const lines: string[] = [];
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: createLogger('debug', (line) => lines.push(line)), config });
    await tools.get('apple_login')!.handler({});
    const loginLine = lines.find((line) => line.includes('"login ok"'));
    expect(JSON.parse(loginLine!).meta).toEqual({ account: 'me@icloud.com', session: 'session-abc' });
  });

  // 端到端走一遍真的解析：信封里一个写错的邮箱，错误照样回给调用方，但日志里只有变量名。
  it('an envelope whose account fails to parse keeps the value out of the logs', async () => {
    const lines: string[] = [];
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, {
      sessions: store,
      logger: createLogger('debug', (line) => lines.push(line)),
      config,
      remote: {
        envAccountsEnabled: () => false,
        openEnvelope: () =>
          accountFromEnvelopeEnv({ ICLOUD_ACCOUNT_1: 'typo-secret-value', ICLOUD_APP_PASSWORD_1: 'fake-pass' }),
      },
    });

    const result = await tools.get('apple_login')!.handler({ envelope: 'ame1.sealed' });
    const error = JSON.parse(result.content[0]!.text).error;
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('信封里的 ICLOUD_ACCOUNT_1 不是合法邮箱');
    expect(lines.some((line) => line.includes('ICLOUD_ACCOUNT_1')), '日志里仍然看得出是哪个变量').toBe(true);
    expect(lines.join('\n')).not.toContain('typo-secret-value');
  });

  it('an envelope login carries the notices the opener produced', async () => {
    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers);
    const envelopeAccount = { ...config.accounts[0]!, email: 'friend@gmail.com', origin: 'envelope' as const };
    const openEnvelope = vi.fn().mockReturnValue({ account: envelopeAccount, notices: ['邮件工具已禁用'] });
    registerSessionTools(server, {
      sessions: store,
      logger: silentLogger,
      config,
      remote: { envAccountsEnabled: () => false, openEnvelope },
    });

    const result = await tools.get('apple_login')!.handler({ envelope: 'ame1.sealed' });
    expect(JSON.parse(result.content[0]!.text).notices).toEqual(['邮件工具已禁用']);
  });
});

describe('work_done', () => {
  it('does not claim to clear credentials from memory -- the App password lives in config for the process lifetime (I9)', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const description = tools.get('work_done')!.config.description ?? '';
    expect(description).not.toContain('清除内存中的凭据');
    expect(description).toContain('销毁');
    expect(description).toMatch(/关闭.*连接/);
    expect(description).toContain('session_id');
  });

  it('destroys the session', async () => {
    const { server, tools } = collect();
    const { store, destroy } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const result = await tools.get('work_done')!.handler({ session_id: 'session-abc' });
    expect(destroy).toHaveBeenCalledWith('session-abc', undefined);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ success: true });
  });
});
