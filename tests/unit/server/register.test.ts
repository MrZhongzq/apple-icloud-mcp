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
});
