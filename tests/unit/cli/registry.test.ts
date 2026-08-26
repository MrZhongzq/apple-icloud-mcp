import { describe, it, expect, vi } from 'vitest';
import { collectTools } from '../../../src/cli/registry.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';
import type { SessionStore } from '../../../src/core/session.js';

const logger = createLogger('error', () => {});

function appConfig(overrides: Partial<AppConfig['accounts'][0]['capabilities']> = {}): AppConfig {
  return {
    accounts: [
      {
        id: 'account_1',
        label: 'a@icloud.com',
        email: 'a@icloud.com',
        sender: 'a@icloud.com',
        appPassword: 'x',
        capabilities: {
          mailRead: true, mailWrite: false,
          calendarRead: true, calendarWrite: false,
          remindersRead: true, remindersWrite: false,
          contactsRead: true, contactsWrite: false,
          ...overrides,
        },
      },
    ],
    sessionTtlMs: 60_000,
    imapIdleTimeoutMs: 60_000,
    logLevel: 'error',
    deprecations: [],
    notices: [],
  } as AppConfig;
}

const sessions = {} as SessionStore;

describe('collectTools', () => {
  it('collects all 25 tools without starting an MCP server', () => {
    const tools = collectTools({ config: appConfig(), sessions, logger });
    expect(tools.size).toBe(25);
    for (const name of ['apple_accounts', 'mail_search', 'calendar_create_event', 'reminders_list', 'contacts_search']) {
      expect(tools.has(name), `缺少 ${name}`).toBe(true);
    }
  });

  it('carries each tool schema and handler through unchanged', () => {
    const tools = collectTools({ config: appConfig(), sessions, logger });
    const search = tools.get('mail_search')!;
    expect(typeof search.handler).toBe('function');
    expect(search.config.inputSchema).toHaveProperty('session_id');
    expect(search.config.description.length).toBeGreaterThan(0);
  });

  it('honours capability gating exactly as the MCP entrypoints do', () => {
    // 邮件能力全关的账号：mail_* 一个都不该被注册
    const tools = collectTools({
      config: appConfig({ mailRead: false, mailWrite: false }),
      sessions,
      logger,
    });
    expect([...tools.keys()].filter((n) => n.startsWith('mail_')), '能力门控必须与 MCP 入口一致').toHaveLength(0);
    expect(tools.has('calendar_list')).toBe(true);
  });
});
