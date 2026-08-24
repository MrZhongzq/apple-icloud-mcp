import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { createProviders } from '../../src/providers/icloud/index.js';
import { createMailService } from '../../src/modules/mail/service.js';
import { createCalendarService } from '../../src/modules/calendar/service.js';
import { createReminderService } from '../../src/modules/reminders/service.js';
import { createLogger } from '../../src/core/logger.js';
import { createContactsCache } from '../../src/modules/contacts/cache.js';
import { createContactService } from '../../src/modules/contacts/service.js';
import type { SessionProviders } from '../../src/core/session.js';

const silentLogger = createLogger('error', () => {});

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
    // assertion fails; it's cleared once deleteEvent() has resolved (not when
    // the assertion on its result passes, and not at send time -- a delete that throws
    // leaves the id intact so `finally` retries it), so a stranded object never lands in the
    // user's real iCloud calendar and a re-run never piles up duplicates. The cleanup
    // delete never throws -- it must not mask the real assertion failure that's already
    // propagating -- but it does report to stderr, so a genuinely broken delete path
    // leaves a trace instead of silently stranding objects run after run -- and tolerates the object already
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
        await service
          .deleteEvent(eventId)
          .catch((err: unknown) =>
            console.error(`[cleanup] 事件 ${eventId} 删除失败，已残留在 ${env.INTEGRATION_CALENDAR_NAME} 中：`, err),
          );
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
        await service
          .remove(reminderId)
          .catch((err: unknown) =>
            console.error(`[cleanup] 提醒 ${reminderId} 删除失败，已残留在 ${listName} 中：`, err),
          );
      }
    }
  });

  it('syncs the address book and round-trips a contact', async () => {
    // Contacts have no "dedicated address book" the way the calendar/reminders tests
    // have a dedicated calendar/list -- a real user won't create one just for testing.
    // Isolation here is by name prefix instead: every write this test makes stays
    // inside INTEGRATION_CONTACT_PREFIX, and the cleanup in `finally` re-reads and
    // re-checks that prefix before deleting -- never deletes by id alone.
    const config = loadConfig(env);
    const carddav = providers.carddav;
    const cache = createContactsCache({ carddav, logger: silentLogger });
    const service = createContactService({ account: config.accounts[0]!, carddav, cache });

    const prefix = env.INTEGRATION_CONTACT_PREFIX ?? 'MCP-Test-';
    const fullName = `${prefix}${Date.now()}`;

    // First search establishes the cache; only structure is asserted here, not count --
    // a real account's contact count is unpredictable.
    const initial = await service.search({ limit: 5 });
    expect(Array.isArray(initial.contacts)).toBe(true);

    // contact_id is tracked outside the try so `finally` can clean up no matter where an
    // assertion fails.
    let contactId: string | undefined;
    try {
      const created = await service.create({
        name: { full: fullName, family: prefix.replace(/-$/, ''), given: 'Case' },
        emails: [{ value: 'mcp-test@example.com', type: ['work'] }],
        organization: '集成测试',
      });
      contactId = created.contact_id;
      expect(created.name.full).toBe(fullName);
      expect(created.has_photo).toBe(false);

      const read = await service.read(created.contact_id);
      expect(read.name.full).toBe(fullName);
      expect(read.emails?.[0]?.value).toBe('mcp-test@example.com');
      expect(read.organization).toBe('集成测试');

      const updated = await service.update(created.contact_id, { organization: '集成测试-已改' });
      expect(updated.organization).toBe('集成测试-已改');
      // The name must not have moved, otherwise the prefix check below is meaningless.
      expect(updated.name.full).toBe(fullName);

      const deleted = await service.remove(created.contact_id);
      expect(deleted).toEqual({ deleted: true });
      contactId = undefined;
    } finally {
      if (contactId) {
        // Re-confirm the prefix before deleting -- never delete by id alone without
        // re-verifying ownership.
        await service
          .read(contactId)
          .then(async (still) => {
            if (!still.name.full.startsWith(prefix)) {
              throw new Error(`拒绝清理：${still.name.full} 不以测试前缀 ${prefix} 开头`);
            }
            await service.remove(contactId!);
          })
          .catch((err: unknown) =>
            console.error(`[cleanup] 联系人 ${contactId} 清理失败，可能已残留在通讯录中：`, err),
          );
      }
    }
  });

  it('preserves an Apple item-group custom label across a round-trip', async () => {
    // What this pins down can't be settled by reasoning alone: ical.js uppercases
    // Apple's item-group prefixes on serialization (item1. becomes ITEM1.). RFC 6350
    // says group names are case-insensitive, but whether Apple's real servers actually
    // accept that has to be observed against a live account.
    const config = loadConfig(env);
    const carddav = providers.carddav;
    const cache = createContactsCache({ carddav, logger: silentLogger });
    const service = createContactService({ account: config.accounts[0]!, carddav, cache });

    const prefix = env.INTEGRATION_CONTACT_PREFIX ?? 'MCP-Test-';
    const fullName = `${prefix}label-${Date.now()}`;

    let contactId: string | undefined;
    try {
      const created = await service.create({
        name: { full: fullName },
        phones: [{ value: '+8613800000000', label: '老家座机' }],
      });
      contactId = created.contact_id;

      const read = await service.read(created.contact_id);
      expect(read.phones?.[0]?.label).toBe('老家座机');

      await service.remove(created.contact_id);
      contactId = undefined;
    } finally {
      if (contactId) {
        await service
          .read(contactId)
          .then(async (still) => {
            if (!still.name.full.startsWith(prefix)) {
              throw new Error(`拒绝清理：${still.name.full} 不以测试前缀 ${prefix} 开头`);
            }
            await service.remove(contactId!);
          })
          .catch((err: unknown) =>
            console.error(`[cleanup] 联系人 ${contactId} 清理失败，可能已残留在通讯录中：`, err),
          );
      }
    }
  });
});
