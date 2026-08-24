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

  it('keeps other address books when one fails', async () => {
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
    const books = await cache.refresh();
    expect(books.map((b) => b.name)).toEqual(['好的']);
    expect(cache.size()).toBe(1);
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

  it('returns an empty snapshot before the first refresh, without touching the network', () => {
    const provider = makeProvider();
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    expect(cache.snapshot()).toEqual([]);
    expect(provider.listAddressBooks).not.toHaveBeenCalled();
    expect(provider.fetchAll).not.toHaveBeenCalled();
  });
});
