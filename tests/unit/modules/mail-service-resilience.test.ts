import { describe, it, expect, vi } from 'vitest';
import type { AccountConfig } from '../../../src/core/config.js';
import type { ImapProvider } from '../../../src/providers/icloud/imap.js';
import type { SmtpProvider } from '../../../src/providers/icloud/smtp.js';

vi.mock('../../../src/parsers/mime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/parsers/mime.js')>();
  return {
    ...actual,
    parseEmail: vi.fn().mockRejectedValue(new RangeError('Invalid code point')),
  };
});

const { createMailService } = await import('../../../src/modules/mail/service.js');

function makeAccount(overrides: Partial<AccountConfig['capabilities']> = {}): AccountConfig {
  return {
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
      ...overrides,
    },
  };
}

function makeImap(overrides: Partial<ImapProvider> = {}): ImapProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listFolders: vi.fn().mockResolvedValue([]),
    searchUids: vi.fn().mockResolvedValue([10]),
    fetchMessages: vi.fn().mockResolvedValue([
      { uid: 10, date: new Date('2026-08-17T02:30:00Z'), flags: ['\\Seen'], source: Buffer.from('bogus') },
    ]),
    setFlags: vi.fn().mockResolvedValue(undefined),
    moveMessages: vi.fn().mockResolvedValue(undefined),
    expunge: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSmtp(): SmtpProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({
      messageId: '<sent@icloud.com>',
      accepted: [],
      rejected: [],
    }),
  };
}

describe('MailService.search resilience', () => {
  it('degrades a single unparseable message instead of failing the page', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    const result = await service.search({ limit: 10 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.uid).toBe(10);
    expect(result.messages[0]!.subject).toBe('(此邮件无法解析)');
    expect(result.messages[0]!.seen).toBe(true);
  });
});
