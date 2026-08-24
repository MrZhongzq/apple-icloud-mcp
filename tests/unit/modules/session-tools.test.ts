import { describe, it, expect, vi } from 'vitest';
import { registerSessionTools } from '../../../src/modules/session/tools.js';
import { createLogger } from '../../../src/core/logger.js';
import { loadConfig, type AppConfig } from '../../../src/core/config.js';
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
    expect(destroy).toHaveBeenCalledWith('session-abc');
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
    expect(destroy).toHaveBeenCalledWith('session-abc');
    expect(JSON.parse(result.content[0]!.text)).toEqual({ success: true });
  });
});
