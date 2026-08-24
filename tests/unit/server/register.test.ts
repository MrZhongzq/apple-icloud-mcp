import { describe, it, expect, vi } from 'vitest';
import { registerAllTools } from '../../../src/server/createServer.js';
import { loadConfig } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import type { ToolConfig, ToolResult } from '../../../src/server/types.js';
import type { SessionStore } from '../../../src/core/session.js';

function collect() {
  const names: string[] = [];
  const server = {
    registerTool(name: string, _config: ToolConfig, _handler: (args: any) => Promise<ToolResult>) {
      names.push(name);
    },
  };
  return { server, names };
}

const logger = createLogger('error', () => {});
const sessions = { get: vi.fn(), create: vi.fn(), destroy: vi.fn() } as unknown as SessionStore;

const base = {
  ICLOUD_ACCOUNT_1: 'me@icloud.com',
  ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
};

describe('registerAllTools', () => {
  it('always registers the session tools', () => {
    const { server, names } = collect();
    registerAllTools(server, { config: loadConfig(base), sessions, logger });
    expect(names).toContain('apple_login');
    expect(names).toContain('apple_accounts');
    expect(names).toContain('work_done');
  });

  it('registers mail and calendar tools when both are readable', () => {
    const { server, names } = collect();
    registerAllTools(server, { config: loadConfig(base), sessions, logger });
    expect(names).toContain('mail_search');
    expect(names).toContain('calendar_list_events');
  });

  it('omits mail tools entirely when every account has mail disabled', () => {
    const { server, names } = collect();
    const config = loadConfig({ ...base, ALLOW_MAIL_READ_1: 'false', ALLOW_MAIL_WRITE_1: 'false' });
    registerAllTools(server, { config, sessions, logger });
    expect(names.some((n) => n.startsWith('mail_'))).toBe(false);
    expect(names).toContain('calendar_list_events');
  });

  it('registers no duplicate tool names', () => {
    const { server, names } = collect();
    registerAllTools(server, { config: loadConfig(base), sessions, logger });
    expect(new Set(names).size).toBe(names.length);
  });

  it('registers mail tools when only one of several accounts enables mail', () => {
    const { server, names } = collect();
    const config = loadConfig({
      ...base,
      ALLOW_MAIL_READ_1: 'false',
      ALLOW_MAIL_WRITE_1: 'false',
      ICLOUD_ACCOUNT_2: 'work@icloud.com',
      ICLOUD_APP_PASSWORD_2: 'abcd-efgh-ijkl-mnop',
      ALLOW_MAIL_READ_2: 'true',
    });
    registerAllTools(server, { config, sessions, logger });
    expect(names).toContain('mail_search');
  });

  it('registers reminder tools when only one of several accounts enables reminders', () => {
    // A single-account fixture can't tell .some() from .every() -- under one account
    // they agree. This asserts the reminder tools register when account 1 has reminders
    // off and only account 2 has it on, which .every() would get wrong.
    const { server, names } = collect();
    const config = loadConfig({
      ...base,
      ALLOW_REMINDERS_READ_1: 'false',
      ALLOW_REMINDERS_WRITE_1: 'false',
      ICLOUD_ACCOUNT_2: 'work@icloud.com',
      ICLOUD_APP_PASSWORD_2: 'abcd-efgh-ijkl-mnop',
      ALLOW_REMINDERS_READ_2: 'true',
    });
    registerAllTools(server, { config, sessions, logger });
    expect(names).toContain('reminders_lists');
  });

  it('omits reminder tools entirely when every account has reminders disabled', () => {
    const { server, names } = collect();
    const config = loadConfig({
      ...base,
      ALLOW_REMINDERS_READ_1: 'false',
      ALLOW_REMINDERS_WRITE_1: 'false',
    });
    registerAllTools(server, { config, sessions, logger });
    expect(names.some((n) => n.startsWith('reminders_'))).toBe(false);
    expect(names).toContain('calendar_list_events');
  });

  it('registers contact tools when only one of several accounts enables contacts', () => {
    // A single-account fixture can't tell .some() from .every() -- under one account
    // they agree. This asserts the contacts tools register when account 1 has contacts
    // off and only account 2 has it on, which .every() would get wrong.
    const { server, names } = collect();
    const config = loadConfig({
      ...base,
      ALLOW_CONTACTS_READ_1: 'false',
      ALLOW_CONTACTS_WRITE_1: 'false',
      ICLOUD_ACCOUNT_2: 'work@icloud.com',
      ICLOUD_APP_PASSWORD_2: 'abcd-efgh-ijkl-mnop',
      ALLOW_CONTACTS_READ_2: 'true',
    });
    registerAllTools(server, { config, sessions, logger });
    expect(names).toContain('contacts_search');
  });

  it('omits contact tools entirely when every account has contacts disabled', () => {
    const { server, names } = collect();
    const config = loadConfig({
      ...base,
      ALLOW_CONTACTS_READ_1: 'false',
      ALLOW_CONTACTS_WRITE_1: 'false',
    });
    registerAllTools(server, { config, sessions, logger });
    expect(names.some((n) => n.startsWith('contacts_'))).toBe(false);
    expect(names).toContain('calendar_list_events');
  });

  it('registers mail tools when account 1 has a non-iCloud sender but account 2 has a valid iCloud sender', () => {
    const { server, names } = collect();
    const config = loadConfig({
      ICLOUD_ACCOUNT_1: 'me@gmail.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ICLOUD_ACCOUNT_2: 'work@gmail.com',
      ICLOUD_APP_PASSWORD_2: 'abcd-efgh-ijkl-mnop',
      ICLOUD_SENDER_2: 'work@icloud.com',
    });
    registerAllTools(server, { config, sessions, logger });
    expect(names).toContain('mail_search');
  });
});
