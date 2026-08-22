import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { createProviders } from '../../src/providers/icloud/index.js';
import { createMailService } from '../../src/modules/mail/service.js';
import { createCalendarService } from '../../src/modules/calendar/service.js';
import type { SessionProviders } from '../../src/core/session.js';

const envPath = join(process.cwd(), '.env.test');
const hasCredentials = existsSync(envPath);

/** 只解析 .env.test，不污染 process.env。 */
function readTestEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(line.trim());
    if (match && !line.trim().startsWith('#')) env[match[1]!] = match[2]!.trim();
  }
  return env;
}

describe.skipIf(!hasCredentials)('live iCloud integration', () => {
  let providers: SessionProviders;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    env = readTestEnv();
    const config = loadConfig(env);
    providers = createProviders(config.accounts[0]!);
  });

  afterAll(async () => {
    await providers?.imap.close();
  });

  it('authenticates against IMAP and CalDAV', async () => {
    await expect(providers.imap.verify()).resolves.toBeUndefined();
    await expect(providers.caldav.verify()).resolves.toBeUndefined();
  });

  it('discovers a trash folder and an inbox', async () => {
    const folders = await providers.imap.listFolders();
    expect(folders.some((f) => f.specialUse === 'inbox')).toBe(true);
    expect(folders.some((f) => f.specialUse === 'trash')).toBe(true);
  });

  it('reads real inbox messages without mojibake', async () => {
    const config = loadConfig(env);
    const service = createMailService({
      account: config.accounts[0]!,
      imap: providers.imap,
      smtp: providers.smtp,
    });
    const result = await service.search({ limit: 3 });
    for (const message of result.messages) {
      expect(message.subject).not.toContain('=?');
      expect(message.subject).not.toContain('�');
    }
  });

  it('detects the dedicated test calendar as writable', async () => {
    // Privilege detection (current-user-privilege-set scanned via hasWritePrivilege /
    // applyPrivilegeFallback in providers/icloud/caldav.ts) has never been exercised
    // against real iCloud until this test runs. It fails safe -- if detection finds no
    // writable calendar anywhere, every calendar is reported writable and the server's
    // 403 becomes the real enforcement -- but whether it detects *correctly* here is
    // exactly what this assertion checks. A calendar the account can genuinely write to
    // must come back with writable === true, not merely "listCalendars() didn't throw".
    const config = loadConfig(env);
    const service = createCalendarService({
      account: config.accounts[0]!,
      caldav: providers.caldav,
    });

    const calendars = await service.listCalendars();
    const target = calendars.find((c) => c.name === env.INTEGRATION_CALENDAR_NAME);
    if (!target) {
      throw new Error(
        `未找到测试日历 ${env.INTEGRATION_CALENDAR_NAME}，请先在 iCloud 中手动创建它`,
      );
    }
    expect(target.writable).toBe(true);
  });

  it('creates, updates and deletes an event in the dedicated test calendar', async () => {
    const config = loadConfig(env);
    const service = createCalendarService({
      account: config.accounts[0]!,
      caldav: providers.caldav,
    });

    const calendars = await service.listCalendars();
    const target = calendars.find((c) => c.name === env.INTEGRATION_CALENDAR_NAME);
    if (!target) {
      throw new Error(
        `未找到测试日历 ${env.INTEGRATION_CALENDAR_NAME}，请先在 iCloud 中手动创建它`,
      );
    }

    const created = await service.createEvent(
      {
        title: 'MCP 集成测试事件',
        start: '2030-01-01T02:00:00.000Z',
        end: '2030-01-01T03:00:00.000Z',
      },
      target.calendar_id,
    );
    expect(created.title).toBe('MCP 集成测试事件');

    const updated = await service.updateEvent(created.event_id, { location: '测试地点' });
    expect(updated.location).toBe('测试地点');

    await expect(service.deleteEvent(created.event_id)).resolves.toEqual({ deleted: true });
  });
});
