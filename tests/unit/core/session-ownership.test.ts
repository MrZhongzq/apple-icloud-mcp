import { describe, it, expect } from 'vitest';
import { createSessionStore } from '../../../src/core/session.js';
import { AppError } from '../../../src/core/errors.js';
import { loadConfig } from '../../../src/core/config.js';

const acc = loadConfig({
  ICLOUD_ACCOUNT_1: 'me@icloud.com',
  ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
}).accounts[0]!;

function makeStore() {
  const closed: string[] = [];
  const store = createSessionStore({
    ttlMs: 60_000,
    providerFactory: () =>
      ({
        imap: { close: async () => void closed.push('imap') },
        smtp: { close: async () => void closed.push('smtp') },
        caldav: {},
        carddav: {},
      }) as never,
  });
  return { store, closed };
}

function codeOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected throw');
}

describe('session ownership', () => {
  it('get rejects a session owned by another key exactly like an unknown id', () => {
    const { store } = makeStore();
    const s = store.create(acc, 'fam', 'key-A');
    const err = codeOf(() => store.get(s.id, 'key-B'));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('SESSION_EXPIRED');
    expect(err.message).toBe('无效的 session_id');
    const unknown = codeOf(() => store.get('nope', 'key-B'));
    expect(err.hint).toBe(unknown.hint);
    expect(store.get(s.id, 'key-A').id).toBe(s.id);
  });

  it('owner-less sessions only match owner-less callers', () => {
    const { store } = makeStore();
    const s = store.create(acc);
    expect(store.get(s.id).id).toBe(s.id);
    expect(codeOf(() => store.get(s.id, 'key-A')).code).toBe('SESSION_EXPIRED');
  });

  it('a mismatched get does not refresh lastActiveAt', () => {
    let t = 1000;
    const store = createSessionStore({
      ttlMs: 60_000,
      now: () => t,
      providerFactory: () => ({ imap: { close: async () => {} }, smtp: { close: async () => {} } }) as never,
    });
    const s = store.create(acc, undefined, 'key-A');
    t = 5000;
    codeOf(() => store.get(s.id, 'key-B'));
    expect(s.lastActiveAt).toBe(1000);
  });

  it('destroy by a non-owner returns false and leaves the session alive', async () => {
    const { store, closed } = makeStore();
    const s = store.create(acc, 'fam', 'key-A');
    expect(await store.destroy(s.id, 'key-B')).toBe(false);
    expect(store.size()).toBe(1);
    expect(closed).toEqual([]);
    expect(await store.destroy(s.id, 'key-A')).toBe(true);
    expect(store.size()).toBe(0);
  });

  it('destroyMatching closes providers of every matched session', async () => {
    const { store, closed } = makeStore();
    store.create(acc, 'f1', 'key-A');
    store.create(acc, 'f2', 'key-A');
    store.create(acc, 'f3', 'key-B');
    expect(await store.destroyMatching((x) => x.ownerKeyId === 'key-A')).toBe(2);
    expect(store.size()).toBe(1);
    expect(closed.sort()).toEqual(['imap', 'imap', 'smtp', 'smtp']);
  });
});
