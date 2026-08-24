import { describe, it, expect, vi } from 'vitest';
import { createCardDavProvider } from '../../../src/providers/icloud/carddav.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';

const account: AccountConfig = {
  id: 'account_1',
  email: 'apple-id@gmail.com',
  sender: 'alias@icloud.com',
  label: 'apple-id@gmail.com',
  appPassword: 'xxxx-xxxx-xxxx-xxxx',
  capabilities: {
    mailRead: true,
    mailWrite: false,
    calendarRead: true,
    calendarWrite: false,
    remindersRead: true,
    remindersWrite: false,
    contactsRead: true,
    contactsWrite: true,
  },
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    fetchAddressBooks: vi.fn().mockResolvedValue([
      { url: 'https://contacts.icloud.com/1/card/', displayName: '通讯录', syncToken: 'tok-1' },
    ]),
    fetchVCards: vi.fn().mockResolvedValue([
      { url: 'https://contacts.icloud.com/1/card/a.vcf', etag: 'e1', data: 'BEGIN:VCARD\r\nEND:VCARD' },
    ]),
    createVCard: vi.fn().mockResolvedValue({ ok: true, status: 201, headers: new Headers({ ETag: 'e-new' }) }),
    updateVCard: vi.fn().mockResolvedValue({ ok: true, status: 204, headers: new Headers() }),
    deleteVCard: vi.fn().mockResolvedValue({ ok: true, status: 204, headers: new Headers() }),
    smartCollectionSyncDetailed: vi.fn().mockResolvedValue({
      url: 'https://contacts.icloud.com/1/card/',
      syncToken: 'tok-2',
      objects: { created: [], updated: [], deleted: [] },
    }),
    ...overrides,
  };
}

function providerWith(client: Record<string, unknown>) {
  return createCardDavProvider({
    account,
    createClient: vi.fn().mockResolvedValue(client) as never,
  });
}

describe('createCardDavProvider', () => {
  it('authenticates with account.email, never account.sender', async () => {
    const createClient = vi.fn().mockResolvedValue(fakeClient());
    const provider = createCardDavProvider({ account, createClient: createClient as never });
    await provider.listAddressBooks();

    const passed = createClient.mock.calls[0]![0] as { credentials: { username: string } };
    expect(passed.credentials.username).toBe('apple-id@gmail.com');
    expect(passed.credentials.username).not.toBe('alias@icloud.com');
  });

  it('lists address books and falls back to the url tail when displayName is missing', async () => {
    const provider = providerWith(
      fakeClient({
        fetchAddressBooks: vi
          .fn()
          .mockResolvedValue([{ url: 'https://contacts.icloud.com/1/card/', syncToken: 'tok-1' }]),
      }),
    );
    const books = await provider.listAddressBooks();
    expect(books).toHaveLength(1);
    expect(books[0]!.name).toBe('card');
    expect(books[0]!.syncToken).toBe('tok-1');
  });

  it('does not assume a single address book', async () => {
    const provider = providerWith(
      fakeClient({
        fetchAddressBooks: vi.fn().mockResolvedValue([
          { url: 'https://contacts.icloud.com/1/card/', displayName: '个人' },
          { url: 'https://contacts.icloud.com/1/work/', displayName: '工作' },
        ]),
      }),
    );
    const books = await provider.listAddressBooks();
    expect(books.map((b) => b.name)).toEqual(['个人', '工作']);
  });

  it('never calls addressBookQuery, which iCloud rejects', async () => {
    const addressBookQuery = vi.fn();
    const provider = providerWith(fakeClient({ addressBookQuery }));
    await provider.fetchAll('https://contacts.icloud.com/1/card/');
    expect(addressBookQuery).not.toHaveBeenCalled();
  });

  it('returns created, updated and deleted urls from an incremental sync', async () => {
    const provider = providerWith(
      fakeClient({
        smartCollectionSyncDetailed: vi.fn().mockResolvedValue({
          url: 'https://contacts.icloud.com/1/card/',
          syncToken: 'tok-3',
          objects: {
            created: [{ url: 'https://c/1.vcf', etag: 'e1', data: 'BEGIN:VCARD\r\nEND:VCARD' }],
            updated: [{ url: 'https://c/2.vcf', etag: 'e2', data: 'BEGIN:VCARD\r\nEND:VCARD' }],
            deleted: [{ url: 'https://c/3.vcf' }],
          },
        }),
      }),
    );
    const delta = await provider.syncSince('https://contacts.icloud.com/1/card/', 'tok-2');
    expect(delta.syncToken).toBe('tok-3');
    expect(delta.created.map((c) => c.url)).toEqual(['https://c/1.vcf']);
    expect(delta.updated.map((c) => c.url)).toEqual(['https://c/2.vcf']);
    expect(delta.deleted).toEqual(['https://c/3.vcf']);
  });

  it('reads the etag back when create does not return one', async () => {
    const fetchVCards = vi
      .fn()
      .mockResolvedValue([{ url: 'https://c/new.vcf', etag: 'e-readback', data: 'BEGIN:VCARD\r\nEND:VCARD' }]);
    const provider = providerWith(
      fakeClient({
        createVCard: vi.fn().mockResolvedValue({
          ok: true,
          status: 201,
          headers: new Headers({ Location: 'https://c/new.vcf' }),
        }),
        fetchVCards,
      }),
    );
    const created = await provider.create({
      bookUrl: 'https://contacts.icloud.com/1/card/',
      filename: 'new.vcf',
      data: 'BEGIN:VCARD\r\nEND:VCARD',
    });
    expect(created.url).toBeTruthy();
    expect(fetchVCards).toHaveBeenCalled();
  });

  it('maps a 412 to CONFLICT', async () => {
    const provider = providerWith(
      fakeClient({ updateVCard: vi.fn().mockResolvedValue({ ok: false, status: 412, headers: new Headers() }) }),
    );
    await expect(
      provider.update({ bookUrl: 'https://c/', url: 'https://c/a.vcf', etag: 'e1', data: 'BEGIN:VCARD\r\nEND:VCARD' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps a 403 to PERMISSION_DENIED and names a contacts tool in the hint', async () => {
    const provider = providerWith(
      fakeClient({ createVCard: vi.fn().mockResolvedValue({ ok: false, status: 403, headers: new Headers() }) }),
    );
    const err = await provider
      .create({ bookUrl: 'https://c/', filename: 'a.vcf', data: 'BEGIN:VCARD\r\nEND:VCARD' })
      .catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('PERMISSION_DENIED');
    // 共享层教训：提示不得指向别的域的工具
    expect((err as AppError).hint ?? '').not.toContain('calendar_');
    expect((err as AppError).hint ?? '').toContain('contacts_');
  });

  it('turns a rejected fetch into a retryable UPSTREAM_ERROR', async () => {
    const provider = providerWith(
      fakeClient({ fetchAddressBooks: vi.fn().mockRejectedValue(new Error('socket hang up')) }),
    );
    const err = await provider.listAddressBooks().catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('UPSTREAM_ERROR');
    expect((err as AppError).retryable).toBe(true);
  });
});
