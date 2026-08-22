import { describe, it, expect, vi } from 'vitest';
import { createSessionStore, type SessionProviders } from '../../../src/core/session.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';

const account: AccountConfig = {
  id: 'account_1',
  email: 'me@icloud.com',
  sender: 'me@icloud.com',
  label: 'me@icloud.com',
  appPassword: 'abcd-efgh-ijkl-mnop',
  capabilities: {
    mailRead: true,
    mailWrite: true,
    calendarRead: true,
    calendarWrite: true,
    remindersRead: true,
    remindersWrite: true,
    contactsRead: true,
    contactsWrite: true,
  },
};

function makeProviders(): SessionProviders & { closed: () => number } {
  let closeCount = 0;
  const providers = {
    imap: {
      close: async () => {
        closeCount += 1;
      },
    },
    smtp: {},
    caldav: {},
  } as unknown as SessionProviders;
  return Object.assign(providers, { closed: () => closeCount });
}

describe('SessionStore', () => {
  it('creates a session with a random id and returns it on get', () => {
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => makeProviders() });
    const session = store.create(account);
    expect(session.id).toHaveLength(36);
    expect(store.get(session.id).account.email).toBe('me@icloud.com');
  });

  it('throws SESSION_EXPIRED for an unknown id', () => {
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => makeProviders() });
    try {
      store.get('00000000-0000-0000-0000-000000000000');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('SESSION_EXPIRED');
      expect((e as AppError).hint).toContain('apple_login');
    }
  });

  it('expires a session once the ttl elapses', () => {
    let now = 1_000_000;
    const store = createSessionStore({
      ttlMs: 5_000,
      providerFactory: () => makeProviders(),
      now: () => now,
    });
    const session = store.create(account);
    now += 4_999;
    expect(store.get(session.id).id).toBe(session.id);
    now += 5_001;
    expect(() => store.get(session.id)).toThrowError(AppError);
  });

  it('closes the connection when a session expires on access', async () => {
    let now = 1_000_000;
    const providers = makeProviders();
    const store = createSessionStore({
      ttlMs: 5_000,
      providerFactory: () => providers,
      now: () => now,
    });
    const session = store.create(account);

    now += 5_001;
    expect(() => store.get(session.id)).toThrowError(AppError);

    // close 是 void 调用（不阻塞错误路径），因此要等微任务队列排空后再断言
    await vi.waitFor(() => expect(providers.closed()).toBe(1));
    expect(store.size()).toBe(0);
  });

  it('keeps a session alive when idle time exactly equals the ttl', () => {
    let now = 1_000_000;
    const store = createSessionStore({
      ttlMs: 5_000,
      providerFactory: () => makeProviders(),
      now: () => now,
    });
    const session = store.create(account);
    now += 5_000;
    expect(store.get(session.id).id).toBe(session.id);
  });

  it('refreshes lastActiveAt on each get', () => {
    let now = 1_000_000;
    const store = createSessionStore({
      ttlMs: 5_000,
      providerFactory: () => makeProviders(),
      now: () => now,
    });
    const session = store.create(account);
    now += 4_000;
    store.get(session.id);
    now += 4_000;
    expect(store.get(session.id).id).toBe(session.id);
  });

  it('closes the imap connection when destroyed', async () => {
    const providers = makeProviders();
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => providers });
    const session = store.create(account);
    await store.destroy(session.id);
    expect(providers.closed()).toBe(1);
    expect(store.size()).toBe(0);
  });

  it('returns false when destroying an unknown session', async () => {
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => makeProviders() });
    expect(await store.destroy('missing')).toBe(false);
  });

  it('sweeps expired sessions and reports how many were removed', async () => {
    let now = 0;
    const providers = makeProviders();
    const store = createSessionStore({
      ttlMs: 1_000,
      providerFactory: () => providers,
      now: () => now,
    });
    store.create(account);
    store.create(account);
    now = 2_000;
    expect(await store.sweep()).toBe(2);
    expect(store.size()).toBe(0);
    expect(providers.closed()).toBe(2);
  });

  it('closes every session on destroyAll', async () => {
    const providers = makeProviders();
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => providers });
    store.create(account);
    store.create(account);
    await store.destroyAll();
    expect(store.size()).toBe(0);
    expect(providers.closed()).toBe(2);
  });

  it('survives a provider that throws while closing', async () => {
    const providers = {
      imap: { close: vi.fn().mockRejectedValue(new Error('socket already gone')) },
      smtp: {},
      caldav: {},
    } as unknown as SessionProviders;
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => providers });
    const session = store.create(account);
    await expect(store.destroy(session.id)).resolves.toBe(true);
  });
});
