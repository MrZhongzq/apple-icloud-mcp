import { describe, it, expect, vi } from 'vitest';
import { createSessionStore } from '../../../src/core/session.js';
import type { AccountConfig } from '../../../src/core/config.js';

function account(id = 'account_1'): AccountConfig {
  return {
    id,
    label: 'a@icloud.com',
    email: 'a@icloud.com',
    sender: 'a@icloud.com',
    appPassword: 'x',
    capabilities: {
      mailRead: true,
      mailWrite: false,
      calendarRead: true,
      calendarWrite: false,
      remindersRead: true,
      remindersWrite: false,
      contactsRead: true,
      contactsWrite: false,
    },
  };
}

function makeStore() {
  const closed: string[] = [];
  const store = createSessionStore({
    ttlMs: 60_000,
    providerFactory: () =>
      ({
        imap: { close: vi.fn().mockImplementation(async () => { closed.push('imap'); }) },
        smtp: {},
        caldav: {},
        carddav: {},
      }) as never,
  });
  return { store, closed };
}

describe('destroyByToken', () => {
  it('destroys every session belonging to a token family', async () => {
    const { store } = makeStore();
    const a = store.create(account(), 'fam-1');
    const b = store.create(account(), 'fam-1');
    const other = store.create(account(), 'fam-2');

    expect(await store.destroyByToken('fam-1')).toBe(2);
    expect(() => store.get(a.id)).toThrow();
    expect(() => store.get(b.id)).toThrow();
    expect(store.get(other.id).id, '别的令牌家族不受影响').toBe(other.id);
  });

  it('closes the underlying connections, not just the map entry', async () => {
    const { store, closed } = makeStore();
    store.create(account(), 'fam-1');
    await store.destroyByToken('fam-1');
    expect(closed, '只从 Map 里删掉会留下一条还连着 iCloud 的 IMAP 连接').toContain('imap');
  });

  it('leaves stdio sessions alone, since they carry no token family', async () => {
    const { store } = makeStore();
    const s = store.create(account());
    expect(await store.destroyByToken('fam-1')).toBe(0);
    expect(store.get(s.id).id).toBe(s.id);
  });

  it('returns 0 for an unknown family without throwing', async () => {
    const { store } = makeStore();
    await expect(store.destroyByToken('nope')).resolves.toBe(0);
  });
});
