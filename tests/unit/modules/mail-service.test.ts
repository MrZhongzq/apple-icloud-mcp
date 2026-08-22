import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMailService } from '../../../src/modules/mail/service.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { ImapProvider } from '../../../src/providers/icloud/imap.js';
import type { SmtpProvider } from '../../../src/providers/icloud/smtp.js';

const source = readFileSync(join(process.cwd(), 'tests/fixtures/mail/chinese-base64.eml'));
const multipartSource = readFileSync(join(process.cwd(), 'tests/fixtures/mail/multipart-qp.eml'));

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
    listFolders: vi.fn().mockResolvedValue([
      { path: 'INBOX', name: 'INBOX', specialUse: 'inbox', total: 3, unseen: 1 },
      { path: 'Deleted Messages', name: 'Deleted Messages', specialUse: 'trash', total: 0, unseen: 0 },
    ]),
    searchUids: vi.fn().mockResolvedValue([30, 20, 10]),
    fetchMessages: vi.fn().mockResolvedValue([
      { uid: 30, date: new Date('2026-08-17T02:30:00Z'), flags: ['\\Seen'], source },
    ]),
    setFlags: vi.fn().mockResolvedValue(undefined),
    moveMessages: vi.fn().mockResolvedValue(undefined),
    expunge: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeImapWithHtml(): ImapProvider {
  return makeImap({
    fetchMessages: vi.fn().mockResolvedValue([
      { uid: 31, date: new Date('2026-08-18T09:00:00Z'), flags: [], source: multipartSource },
    ]),
  });
}

function makeSmtp(): SmtpProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({
      messageId: '<sent@icloud.com>',
      accepted: ['friend@example.com'],
      rejected: [],
    }),
  };
}

describe('MailService permissions', () => {
  it('refuses to search when mail read is disabled', async () => {
    const service = createMailService({
      account: makeAccount({ mailRead: false }),
      imap: makeImap(),
      smtp: makeSmtp(),
    });
    await expect(service.search({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('refuses to send when mail write is disabled', async () => {
    const service = createMailService({
      account: makeAccount({ mailWrite: false }),
      imap: makeImap(),
      smtp: makeSmtp(),
    });
    await expect(
      service.send({ to: ['friend@example.com'], subject: 'hi', text: 'hi' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('names the environment variable to flip in the hint', async () => {
    const service = createMailService({
      account: makeAccount({ mailWrite: false }),
      imap: makeImap(),
      smtp: makeSmtp(),
    });
    try {
      await service.remove([1]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).hint).toContain('ALLOW_MAIL_WRITE');
    }
  });
});

describe('MailService.search', () => {
  it('returns decoded summaries with a snippet', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    const result = await service.search({ limit: 1 });
    expect(result.messages[0]!.subject).toBe('测试邮件：中文主题');
    expect(result.messages[0]!.snippet).toContain('你好');
    expect(result.messages[0]!.seen).toBe(true);
  });

  it('defaults to INBOX and fetches only the requested page', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await service.search({ limit: 1 });
    expect(imap.searchUids).toHaveBeenCalledWith('INBOX', {});
    expect(imap.fetchMessages).toHaveBeenCalledWith('INBOX', [30]);
  });

  it('emits a cursor when more results remain', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    const result = await service.search({ limit: 1 });
    expect(result.nextCursor).toBe('1');
  });

  it('omits the cursor on the last page', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    const result = await service.search({ limit: 10 });
    expect(result.nextCursor).toBeUndefined();
  });

  it('continues from a cursor', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await service.search({ limit: 1, cursor: '2' });
    expect(imap.fetchMessages).toHaveBeenCalledWith('INBOX', [10]);
  });

  it('rejects a limit above the cap', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    await expect(service.search({ limit: 500 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a limit below one', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    await expect(service.search({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('MailService.read', () => {
  it('returns the decoded body and drops html unless requested', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    const mail = await service.read(30);
    expect(mail.uid).toBe(30);
    expect(mail.text).toContain('第二行。');
    expect(mail.html).toBeUndefined();
  });

  it('raises NOT_FOUND when the uid is absent', async () => {
    const imap = makeImap({ fetchMessages: vi.fn().mockResolvedValue([]) });
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await expect(service.read(999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('drops the html body when format is text', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImapWithHtml(), smtp: makeSmtp() });
    const mail = await service.read(31, 'INBOX', 'text');
    expect(mail.text).toContain('纯文本部分');
    expect(mail.html).toBeUndefined();
  });

  it('empties the text body when format is html', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImapWithHtml(), smtp: makeSmtp() });
    const mail = await service.read(31, 'INBOX', 'html');
    expect(mail.text).toBe('');
    expect(mail.html).toContain('第一段');
  });

  it('keeps both bodies when format is both', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImapWithHtml(), smtp: makeSmtp() });
    const mail = await service.read(31, 'INBOX', 'both');
    expect(mail.text).toContain('纯文本部分');
    expect(mail.html).toContain('第一段');
  });
});

describe('MailService.mark / move / remove', () => {
  it('adds and removes flags in separate calls', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await service.mark([1, 2], { seen: true, flagged: false });
    expect(imap.setFlags).toHaveBeenCalledWith('INBOX', [1, 2], ['\\Seen'], true);
    expect(imap.setFlags).toHaveBeenCalledWith('INBOX', [1, 2], ['\\Flagged'], false);
  });

  it('moves messages to the trash folder by default', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    const result = await service.remove([5]);
    expect(imap.moveMessages).toHaveBeenCalledWith('INBOX', [5], 'Deleted Messages');
    expect(imap.expunge).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 1, permanent: false });
  });

  it('expunges instead when permanent deletion is requested', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    const result = await service.remove([5], 'INBOX', true);
    expect(imap.expunge).toHaveBeenCalledWith('INBOX', [5]);
    expect(imap.moveMessages).not.toHaveBeenCalled();
    expect(result.permanent).toBe(true);
  });

  it('fails clearly when no trash folder can be discovered', async () => {
    const imap = makeImap({
      listFolders: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX', total: 0, unseen: 0 }]),
    });
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await expect(service.remove([5])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an empty uid list', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    await expect(service.mark([], { seen: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('MailService.send', () => {
  it('requires at least one body part', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    await expect(service.send({ to: ['a@b.com'], subject: 's' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('passes the message through to the smtp provider', async () => {
    const smtp = makeSmtp();
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp });
    const result = await service.send({ to: ['friend@example.com'], subject: 'hi', text: 'hi' });
    expect(smtp.send).toHaveBeenCalled();
    expect(result.accepted).toEqual(['friend@example.com']);
  });
});
