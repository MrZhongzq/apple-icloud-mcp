import { describe, it, expect } from 'vitest';
import { registerAllTools } from '../../../src/server/createServer.js';
import { createSessionStore } from '../../../src/core/session.js';
import { createLogger } from '../../../src/core/logger.js';
import { loadConfig } from '../../../src/core/config.js';
import type { ToolConfig, ToolResult } from '../../../src/server/types.js';

type Handler = (args: any, extra?: any) => Promise<ToolResult>;
interface Registered {
  config: ToolConfig;
  handler: Handler;
}

const config = loadConfig({
  ICLOUD_ACCOUNT_1: 'me@icloud.com',
  ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
  ALLOW_MAIL_WRITE_1: 'true',
  ALLOW_CALENDAR_WRITE_1: 'true',
  ALLOW_REMINDERS_WRITE_1: 'true',
  ALLOW_CONTACTS_WRITE_1: 'true',
});

// 最小的合法参数：只在工具于解析会话之前就因参数报错时才需要补。
const FIXTURE_ARGS: Record<string, Record<string, unknown>> = {};

function setup() {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, cfg: ToolConfig, handler: Handler) {
      tools.set(name, { config: cfg, handler });
    },
  };
  const sessions = createSessionStore({
    ttlMs: 60_000,
    providerFactory: () =>
      ({
        imap: { close: async () => {} },
        smtp: { close: async () => {} },
        caldav: {},
        carddav: {},
      }) as never,
  });
  registerAllTools(server as never, { config, sessions, logger: createLogger('error', () => {}) });
  return { tools, sessions };
}

const extraOf = (id: string) => ({ authInfo: { token: 't', clientId: 'c', scopes: [], extra: { accessKeyId: id } } });

describe('tool-level session ownership', () => {
  it('every session-bound tool refuses a session_id owned by another access key', async () => {
    const { tools, sessions } = setup();
    const s = sessions.create(config.accounts[0]!, 'fam', 'key-A');
    let checked = 0;
    for (const [name, t] of tools) {
      if (name === 'work_done') continue;
      if (!('session_id' in (t.config.inputSchema ?? {}))) continue;
      const res = await t.handler({ session_id: s.id, ...FIXTURE_ARGS[name] }, extraOf('key-B'));
      expect(res.isError, name).toBe(true);
      expect(JSON.parse(res.content[0]!.text).error.code, name).toBe('SESSION_EXPIRED');
      checked += 1;
    }
    expect(checked).toBe(22);
  });

  it('work_done from another key does not destroy the session', async () => {
    const { tools, sessions } = setup();
    const s = sessions.create(config.accounts[0]!, 'fam', 'key-A');
    const res = await tools.get('work_done')!.handler({ session_id: s.id }, extraOf('key-B'));
    expect(JSON.parse(res.content[0]!.text)).toEqual({ success: false });
    expect(sessions.size()).toBe(1);
  });
});
