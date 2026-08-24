import { describe, it, expect, vi } from 'vitest';
import { createContactsCache } from '../../../src/modules/contacts/cache.js';
import { createLogger } from '../../../src/core/logger.js';
import type { CardDavProvider } from '../../../src/providers/icloud/carddav.js';

const silentLogger = createLogger('error', () => {});

function card(fn: string, uid: string): string {
  return ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + fn, 'N:' + fn + ';;;;', 'UID:' + uid, 'END:VCARD'].join('\r\n');
}

function makeProvider(overrides: Partial<CardDavProvider> = {}): CardDavProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listAddressBooks: vi
      .fn()
      .mockResolvedValue([{ url: 'https://c/1/card/', name: '通讯录', readOnly: false, syncToken: 'tok-1' }]),
    fetchAll: vi.fn().mockResolvedValue({
      objects: [{ url: 'https://c/1/card/a.vcf', etag: 'e1', data: card('张三', 'U1') }],
      syncToken: 'tok-1',
    }),
    syncSince: vi.fn().mockResolvedValue({ syncToken: 'tok-2', created: [], updated: [], deleted: [] }),
    fetchOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  } as CardDavProvider;
}

describe('createContactsCache', () => {
  it('does a full fetch the first time and an incremental sync afterwards', async () => {
    const provider = makeProvider();
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });

    await cache.refresh();
    expect(provider.fetchAll).toHaveBeenCalledTimes(1);
    expect(provider.syncSince).not.toHaveBeenCalled();

    await cache.refresh();
    expect(provider.fetchAll).toHaveBeenCalledTimes(1);
    expect(provider.syncSince).toHaveBeenCalledTimes(1);
    expect(provider.syncSince).toHaveBeenCalledWith('https://c/1/card/', 'tok-1');
  });

  it('forwards the delta token on the refresh after that', async () => {
    const provider = makeProvider({
      syncSince: vi.fn().mockResolvedValue({ syncToken: 'tok-2', created: [], updated: [], deleted: [] }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    await cache.refresh();
    await cache.refresh();
    const calls = (provider.syncSince as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toBe('tok-1');
    expect(calls[1]![1], 'third call must use the token returned by the previous delta').toBe('tok-2');
  });

  it('applies created, updated and deleted from a delta', async () => {
    const provider = makeProvider({
      syncSince: vi.fn().mockResolvedValue({
        syncToken: 'tok-2',
        created: [{ url: 'https://c/1/card/b.vcf', etag: 'e2', data: card('李四', 'U2') }],
        updated: [{ url: 'https://c/1/card/a.vcf', etag: 'e1b', data: card('张三丰', 'U1') }],
        deleted: [],
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    await cache.refresh();

    const book = cache.snapshot()[0]!;
    expect(book.cards.size).toBe(2);
    expect(book.cards.get('https://c/1/card/a.vcf')!.name.full).toBe('张三丰');
    expect(book.cards.get('https://c/1/card/b.vcf')!.name.full).toBe('李四');
    expect(book.syncToken).toBe('tok-2');
  });

  it('removes a deleted card from the snapshot', async () => {
    const provider = makeProvider({
      syncSince: vi.fn().mockResolvedValue({
        syncToken: 'tok-2',
        created: [],
        updated: [],
        deleted: ['https://c/1/card/a.vcf'],
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    expect(cache.size()).toBe(1);
    await cache.refresh();
    expect(cache.size()).toBe(0);
  });

  it('falls back to a full fetch when the server gave no sync token', async () => {
    const provider = makeProvider({
      listAddressBooks: vi.fn().mockResolvedValue([{ url: 'https://c/1/card/', name: 'card', readOnly: false }]),
      fetchAll: vi.fn().mockResolvedValue({
        objects: [{ url: 'https://c/1/card/a.vcf', etag: 'e1', data: card('张三', 'U1') }],
        syncToken: undefined,
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    await cache.refresh();
    expect(provider.fetchAll).toHaveBeenCalledTimes(2);
    expect(provider.syncSince).not.toHaveBeenCalled();
  });

  it('drops the stored token when a delta returns none, forcing a full fetch next time', async () => {
    const provider = makeProvider({
      syncSince: vi.fn().mockResolvedValue({ created: [], updated: [], deleted: [] }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    await cache.refresh();
    expect(cache.snapshot()[0]!.syncToken).toBeUndefined();

    await cache.refresh();
    expect(provider.fetchAll, 'losing the token must fall back to a full fetch, not an incremental sync with undefined').toHaveBeenCalledTimes(2);
  });

  it('reports a failed book instead of dropping it silently, without disturbing the healthy one', async () => {
    const provider = makeProvider({
      listAddressBooks: vi.fn().mockResolvedValue([
        { url: 'https://c/1/bad/', name: '坏的', readOnly: false },
        { url: 'https://c/1/good/', name: '好的', readOnly: false },
      ]),
      fetchAll: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('bad')) throw new Error('boom');
        return { objects: [{ url: 'https://c/1/good/a.vcf', etag: 'e1', data: card('张三', 'U1') }], syncToken: 't' };
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    const { books, failures } = await cache.refresh();
    expect(books.map((b) => b.name)).toEqual(['好的']);
    expect(failures, 'a book that never synced before must not be silently dropped').toHaveLength(1);
    expect(failures[0]!.name).toBe('坏的');
    expect(failures[0]!.reason).toContain('boom');
    expect(cache.size()).toBe(1);
  });

  it('keeps a previously loaded book when a later refresh fails, and reports the failure', async () => {
    let failNow = false;
    const provider = makeProvider({
      syncSince: vi.fn().mockImplementation(async () => {
        if (failNow) throw new Error('boom');
        return { syncToken: 'tok-2', created: [], updated: [], deleted: [] };
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    expect(cache.size()).toBe(1);

    failNow = true;
    const { books, failures } = await cache.refresh();
    expect(books, 'stale but still-cached data must be served rather than dropped').toHaveLength(1);
    expect(failures, 'and the caller must still be told this book failed to sync').toHaveLength(1);
    expect(cache.size(), 'the snapshot still holds the last successful data').toBe(1);
  });

  it('keeps sibling cards when one card fails to parse', async () => {
    const provider = makeProvider({
      fetchAll: vi.fn().mockResolvedValue({
        objects: [
          { url: 'https://c/1/card/a.vcf', etag: 'e1', data: card('张三', 'U1') },
          { url: 'https://c/1/card/bad.vcf', etag: 'e2', data: 'this is not a vcard' },
          { url: 'https://c/1/card/c.vcf', etag: 'e3', data: card('王五', 'U3') },
        ],
        syncToken: 'tok-1',
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    expect(cache.size()).toBe(2);
  });

  it('re-syncs a book after invalidate', async () => {
    const provider = makeProvider();
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    cache.invalidate('https://c/1/card/');
    await cache.refresh();
    expect(provider.fetchAll).toHaveBeenCalledTimes(2);
  });

  it('keeps cached cards usable between invalidate and the next refresh', async () => {
    // invalidate must only clear the token and keep cards. Replacing it with a
    // whole-entry delete leaves all other tests green, so this has to observe
    // the map state after invalidate and before the next refresh.
    const provider = makeProvider();
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    expect(cache.size()).toBe(1);
    cache.invalidate('https://c/1/card/');
    expect(cache.size(), 'invalidate must not discard cards; stale data stays usable after a write').toBe(1);
    expect(cache.snapshot()[0]!.syncToken, 'invalidate must clear the token').toBeUndefined();
  });

  it('returns an empty snapshot before the first refresh, without touching the network', () => {
    const provider = makeProvider();
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    expect(cache.snapshot()).toEqual([]);
    expect(provider.listAddressBooks).not.toHaveBeenCalled();
    expect(provider.fetchAll).not.toHaveBeenCalled();
  });
});
