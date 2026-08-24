import { describe, it, expect, vi } from 'vitest';
import { createContactService } from '../../../src/modules/contacts/service.js';
import { encodeRef, encodeUrl } from '../../../src/core/ids.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { ContactsCache, CachedBook } from '../../../src/modules/contacts/cache.js';
import type { CardDavProvider } from '../../../src/providers/icloud/carddav.js';
import { parseVCard } from '../../../src/parsers/vcard.js';

const BOOK = 'https://c/1/card/';

function account(overrides: Partial<AccountConfig['capabilities']> = {}): AccountConfig {
  return {
    id: 'account_1',
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
      contactsWrite: true,
      ...overrides,
    },
  };
}

function card(fn: string, extra: string[] = []): string {
  return ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + fn, 'N:' + fn + ';;;;', ...extra, 'END:VCARD'].join('\r\n');
}

function cachedBook(entries: [string, string][], readOnly = false): CachedBook {
  const cards = new Map();
  for (const [url, text] of entries) {
    cards.set(url, parseVCard(text, { collectionUrl: BOOK, resourceUrl: url }));
  }
  return { url: BOOK, name: '通讯录', readOnly, syncToken: 'tok', cards, loadedAt: Date.now() };
}

function makeCache(books: CachedBook[]): ContactsCache {
  return {
    refresh: vi.fn().mockResolvedValue({ books, failures: [] }),
    snapshot: vi.fn().mockReturnValue(books),
    invalidate: vi.fn(),
    size: vi.fn().mockReturnValue(books.reduce((n, b) => n + b.cards.size, 0)),
  };
}

function makeCardDav(overrides: Partial<CardDavProvider> = {}): CardDavProvider {
  return {
    verify: vi.fn(),
    listAddressBooks: vi.fn().mockResolvedValue([{ url: BOOK, name: '通讯录', readOnly: false }]),
    fetchAll: vi.fn(),
    syncSince: vi.fn(),
    fetchOne: vi.fn().mockResolvedValue({ url: BOOK + 'a.vcf', etag: 'etag-fresh', data: card('张三') }),
    create: vi.fn().mockResolvedValue({ url: BOOK + 'new.vcf' }),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as CardDavProvider;
}

const idOf = (url: string) => encodeRef({ collectionUrl: BOOK, resourceUrl: url });

describe('contact service permissions', () => {
  it('refuses to search when contacts read is disabled, before touching the provider', async () => {
    const cache = makeCache([]);
    const svc = createContactService({
      account: account({ contactsRead: false }),
      carddav: makeCardDav(),
      cache,
    });
    const err = await svc.search({}).catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('PERMISSION_DENIED');
    expect((err as AppError).hint).toContain('ALLOW_CONTACTS_READ_1');
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it('refuses to create when contacts write is disabled, before touching the provider', async () => {
    const carddav = makeCardDav();
    const svc = createContactService({
      account: account({ contactsWrite: false }),
      carddav,
      cache: makeCache([]),
    });
    const err = await svc
      .create({ name: { full: '张三' } })
      .catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('PERMISSION_DENIED');
    expect((err as AppError).hint).toContain('ALLOW_CONTACTS_WRITE_1');
    expect(carddav.create).not.toHaveBeenCalled();
    expect(carddav.listAddressBooks).not.toHaveBeenCalled();
  });
});

describe('contact search', () => {
  const book = cachedBook([
    [BOOK + 'a.vcf', card('张三', ['ORG:某某科技;研发部', 'EMAIL:zhang@example.com', 'TEL:+86 138 0000 0000'])],
    [BOOK + 'b.vcf', card('李四', ['ORG:另一家公司', 'EMAIL:li@other.com'])],
    [BOOK + 'c.vcf', card('王五', ['TITLE:架构师'])],
  ]);

  it('matches on name, organization, title and email', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    expect((await svc.search({ query: '张' })).contacts.map((c) => c.name.full)).toEqual(['张三']);
    expect((await svc.search({ query: '某某科技' })).contacts.map((c) => c.name.full)).toEqual(['张三']);
    expect((await svc.search({ query: '架构师' })).contacts.map((c) => c.name.full)).toEqual(['王五']);
    expect((await svc.search({ query: 'li@other' })).contacts.map((c) => c.name.full)).toEqual(['李四']);
  });

  it('matches a phone number regardless of formatting', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    const found = await svc.search({ query: '13800000000' });
    expect(found.contacts.map((c) => c.name.full)).toEqual(['张三']);
  });

  it('is case insensitive', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    expect((await svc.search({ query: 'LI@OTHER.COM' })).contacts).toHaveLength(1);
  });

  it('refreshes the cache before matching', async () => {
    const cache = makeCache([book]);
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache });
    await svc.search({ query: '张' });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  it('sorts deterministically and flags truncation', async () => {
    const many = cachedBook(
      Array.from({ length: 5 }, (_, i) => [BOOK + i + '.vcf', card('联系人' + (4 - i))] as [string, string]),
    );
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([many]) });
    const result = await svc.search({ limit: 3 });
    expect(result.contacts).toHaveLength(3);
    expect(result.truncated).toBe(true);
    const names = result.contacts.map((c) => c.name.full);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('does not flag truncation when everything fits', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    expect((await svc.search({ limit: 50 })).truncated).toBeUndefined();
  });

  it('rejects an out-of-range limit', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    await expect(svc.search({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(svc.search({ limit: 501 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('filters by address book after decoding the opaque id', async () => {
    const other = { ...cachedBook([[BOOK + 'z.vcf', card('不该出现的人')]]), url: 'https://c/1/other/', name: '另一个' };
    const svc = createContactService({
      account: account(),
      carddav: makeCardDav(),
      cache: makeCache([book, other]),
    });
    // 传入的是不透明 id，服务层必须解码后再比对 url
    const result = await svc.search({ address_book_ids: [encodeUrl(BOOK)] });
    expect(result.contacts.map((c) => c.name.full)).not.toContain('不该出现的人');
    expect(result.contacts.length).toBeGreaterThan(0);
  });

  it('rejects an address_book_id that cannot be decoded', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    await expect(svc.search({ address_book_ids: ['not-a-real-id'] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('never returns photo bytes', async () => {
    const withPhoto = cachedBook([
      [BOOK + 'p.vcf', card('有头像的人', ['PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ'])],
    ]);
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([withPhoto]) });
    const result = await svc.search({});
    expect(result.contacts[0]!.has_photo).toBe(true);
    expect(JSON.stringify(result)).not.toContain('/9j/4AAQ');
  });
});

describe('contact writes', () => {
  const book = cachedBook([[BOOK + 'a.vcf', card('张三', ['NOTE:原有备注'])]]);

  it('patches in place and preserves unmodelled properties', async () => {
    const rich = card('张三', [
      'NOTE:原有备注',
      'X-ABRELATEDNAMES;type=pref:李四',
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ',
    ]);
    const carddav = makeCardDav({
      fetchOne: vi.fn().mockResolvedValue({ url: BOOK + 'a.vcf', etag: 'etag-fresh', data: rich }),
    });
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });

    await svc.update(idOf(BOOK + 'a.vcf'), { organization: '新公司' });

    const written = (carddav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { data: string };
    expect(written.data).toContain('X-ABRELATEDNAMES');
    expect(written.data).toContain('/9j/4AAQSkZJRgABAQ');
    expect(written.data).toContain('新公司');
  });

  it('writes with the freshly read etag when the caller supplies none', async () => {
    const carddav = makeCardDav({
      fetchOne: vi
        .fn()
        .mockResolvedValue({ url: BOOK + 'a.vcf', etag: 'etag-fresh-from-server', data: card('张三') }),
    });
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    await svc.update(idOf(BOOK + 'a.vcf'), { title: '架构师' });
    const written = (carddav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { etag: string };
    expect(written.etag).toBe('etag-fresh-from-server');
  });

  it('raises CONFLICT on a stale etag without writing', async () => {
    const carddav = makeCardDav({
      fetchOne: vi.fn().mockResolvedValue({ url: BOOK + 'a.vcf', etag: 'etag-new', data: card('张三') }),
    });
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    await expect(
      svc.update(idOf(BOOK + 'a.vcf'), { title: 'x' }, { expected_etag: 'etag-old' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(carddav.update).not.toHaveBeenCalled();
  });

  it('fails a malformed contact_id before any network call', async () => {
    const carddav = makeCardDav();
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    await expect(svc.update('not-a-real-id', { title: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(carddav.fetchOne).not.toHaveBeenCalled();
  });

  it('invalidates the cached book after a write', async () => {
    const cache = makeCache([book]);
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache });
    await svc.update(idOf(BOOK + 'a.vcf'), { title: '架构师' });
    expect(cache.invalidate).toHaveBeenCalledWith(BOOK);
  });

  it('creates into the named address book', async () => {
    const carddav = makeCardDav();
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    await svc.create({ name: { full: '新人' } }, encodeUrl(BOOK));
    const args = (carddav.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { bookUrl: string };
    expect(args.bookUrl).toBe(BOOK);
  });

  it('refuses to create into a read-only address book', async () => {
    const carddav = makeCardDav({
      listAddressBooks: vi.fn().mockResolvedValue([{ url: BOOK, name: '只读', readOnly: true }]),
    });
    const svc = createContactService({ account: account(), carddav, cache: makeCache([]) });
    const err = await svc.create({ name: { full: '新人' } }, encodeUrl(BOOK)).catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('PERMISSION_DENIED');
    expect(carddav.create).not.toHaveBeenCalled();
  });

  it('deletes with the freshly read etag', async () => {
    const carddav = makeCardDav();
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    expect(await svc.remove(idOf(BOOK + 'a.vcf'))).toEqual({ deleted: true });
    const args = (carddav.remove as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { etag: string };
    expect(args.etag).toBe('etag-fresh');
  });
});

describe('contact search isolation', () => {
  it('returns other books results when one book failed to load', async () => {
    const good = cachedBook([[BOOK + 'a.vcf', card('张三')]]);
    const cache: ContactsCache = {
      refresh: vi.fn().mockResolvedValue({ books: [good], failures: [] }),
      snapshot: vi.fn().mockReturnValue([good]),
      invalidate: vi.fn(),
      size: vi.fn().mockReturnValue(1),
    };
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache });
    const result = await svc.search({});
    expect(result.contacts).toHaveLength(1);
  });

  it('surfaces a failed address book as partial_failures', async () => {
    const book = cachedBook([[BOOK + 'a.vcf', card('张三')]]);
    const cache = makeCache([book]);
    (cache.refresh as ReturnType<typeof vi.fn>).mockResolvedValue({
      books: [book],
      failures: [{ url: 'https://c/1/other/', name: '另一本', reason: 'boom' }],
    });
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache });
    const result = await svc.search({});
    expect(result.partial_failures, '通讯簿同步失败必须让调用方看见').toHaveLength(1);
    expect(result.partial_failures![0]!.name).toBe('另一本');
    expect(result.partial_failures![0]!.address_book_id).not.toContain('https://');
  });
});
