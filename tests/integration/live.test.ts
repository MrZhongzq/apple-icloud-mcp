import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { createProviders } from '../../src/providers/icloud/index.js';
import { createMailService } from '../../src/modules/mail/service.js';
import { createCalendarService } from '../../src/modules/calendar/service.js';
import { createReminderService } from '../../src/modules/reminders/service.js';
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
    const { folders, failures } = await providers.imap.listFolders();
    expect(failures).toEqual([]);
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

    // event_id is tracked outside the try so `finally` can clean up no matter where an
    // assertion fails; it's cleared the moment deleteEvent() is actually sent (not when
    // the assertion on its result passes), so a stranded object never lands in the
    // user's real iCloud calendar and a re-run never piles up duplicates. The cleanup
    // delete itself is swallowed -- it must never throw over, and mask, the real
    // assertion failure that's already propagating -- and tolerates the object already
    // being gone (e.g. the explicit delete below succeeded but a later assertion threw).
    let eventId: string | undefined;
    try {
      const created = await service.createEvent(
        {
          title: 'MCP 集成测试事件',
          start: '2030-01-01T02:00:00.000Z',
          end: '2030-01-01T03:00:00.000Z',
        },
        target.calendar_id,
      );
      eventId = created.event_id;
      expect(created.title).toBe('MCP 集成测试事件');

      const updated = await service.updateEvent(created.event_id, { location: '测试地点' });
      expect(updated.location).toBe('测试地点');

      const deleteResult = await service.deleteEvent(created.event_id);
      eventId = undefined;
      expect(deleteResult).toEqual({ deleted: true });
    } finally {
      if (eventId) {
        await service.deleteEvent(eventId).catch(() => {});
      }
    }
  });

  it('detects a VTODO list and round-trips a reminder', async () => {
    // Same convention as the dedicated test calendar above: writes are confined to a
    // list the user designated by name, and this test never falls back to any other
    // list. If it doesn't exist, fail with instructions to create it manually --
    // writing into a list the user didn't designate would put test data into their
    // real reminders.
    const config = loadConfig(env);
    const service = createReminderService({
      account: config.accounts[0]!,
      caldav: providers.caldav,
    });

    const listName = env.INTEGRATION_REMINDER_LIST_NAME ?? 'MCP-Test';
    const lists = await service.listLists();
    const target = lists.find((l) => l.name === listName);
    if (!target) {
      throw new Error(`未找到测试提醒列表 ${listName}，请先在 iCloud 提醒事项中手动创建它`);
    }

    // Same cleanup convention as the calendar test above: reminder_id is tracked outside
    // the try so `finally` can delete it no matter where an assertion fails, cleared as
    // soon as the delete is actually sent (not when the assertion on its result passes),
    // and the cleanup delete itself is swallowed so it can never mask the real failure
    // or choke on an object that's already gone.
    let reminderId: string | undefined;
    try {
      const created = await service.create(
        { title: 'MCP 集成测试提醒' },
        target.list_id,
      );
      reminderId = created.reminder_id;
      expect(created.title).toBe('MCP 集成测试提醒');
      expect(created.completed).toBe(false);

      const completed = await service.update(created.reminder_id, { completed: true });
      expect(completed.completed).toBe(true);
      expect(completed.completed_at).toBeDefined();

      const removeResult = await service.remove(completed.reminder_id);
      reminderId = undefined;
      expect(removeResult).toEqual({ deleted: true });
    } finally {
      if (reminderId) {
        await service.remove(reminderId).catch(() => {});
      }
    }
  });
});
