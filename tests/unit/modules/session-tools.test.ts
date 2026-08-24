import { describe, it, expect, vi } from 'vitest';
import { registerSessionTools } from '../../../src/modules/session/tools.js';
import { createLogger } from '../../../src/core/logger.js';
import { loadConfig } from '../../../src/core/config.js';
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

function makeSessions(providers: Record<string, unknown>) {
  const destroy = vi.fn().mockResolvedValue(true);
  const store = {
    create: vi.fn().mockReturnValue({
      id: 'session-abc',
      account: config.accounts[0],
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
    const { contactsRead: _r, contactsWrite: _w, ...expected } = config.accounts[0]!.capabilities;
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      {
        email: 'me@icloud.com',
        label: 'personal',
        capabilities: expected,
      },
    ]);
  });

  // config 会解析 ALLOW_CONTACTS_* 供下一阶段使用，但本阶段一个联系人工具都没有注册，
  // SKILL.md 也写明联系人不可用：原样回显会让模型拿到一个用不上的 contactsRead: true。
  it('does not advertise contacts capabilities while no contacts tool exists', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });
    const result = await tools.get('apple_accounts')!.handler({});
    const [entry] = JSON.parse(result.content[0]!.text) as Array<{ capabilities: Record<string, boolean> }>;
    expect(Object.keys(entry!.capabilities).sort()).toEqual([
      'calendarRead', 'calendarWrite', 'mailRead', 'mailWrite', 'remindersRead', 'remindersWrite',
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

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.session_id).toBe('session-abc');
    expect(payload.account).toBe('me@icloud.com');
    expect(payload.label).toBe('personal');
    expect(payload.capabilities.mailWrite).toBe(true);
    expect(payload.capabilities).not.toHaveProperty('contactsRead');
    expect(payload.capabilities).not.toHaveProperty('contactsWrite');
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
