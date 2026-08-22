import { describe, it, expect } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { mapImapError, createImapProvider } from '../../../src/providers/icloud/imap.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';

const account: AccountConfig = {
  id: 'account_1',
  email: 'user@icloud.com',
  sender: 'user@icloud.com',
  label: 'user@icloud.com',
  appPassword: 'app-specific-password',
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

describe('mapImapError', () => {
  it('maps authentication failures to AUTH_FAILED with an actionable hint', () => {
    const mapped = mapImapError(Object.assign(new Error('Invalid credentials'), {
      authenticationFailed: true,
    }));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe('AUTH_FAILED');
    expect(mapped.retryable).toBe(false);
    expect(mapped.hint).toContain('App 专用密码');
  });

  it('maps network errors to a retryable UPSTREAM_ERROR', () => {
    const mapped = mapImapError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a missing mailbox to NOT_FOUND', () => {
    const mapped = mapImapError(new Error('Mailbox does not exist'));
    expect(mapped.code).toBe('NOT_FOUND');
  });

  it('never leaks the original message for unknown failures', () => {
    const mapped = mapImapError(new Error('LOGIN user pass=abcd-efgh'));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.message).not.toContain('abcd-efgh');
  });
});

describe('createImapProvider connection reuse', () => {
  it('shares one connection attempt across concurrent callers', async () => {
    let built = 0;
    let resolveConnect: (() => void) | undefined;
    const fakeClient = {
      usable: true,
      connect: () => new Promise<void>((resolve) => { resolveConnect = resolve; }),
      noop: async () => undefined,
      logout: async () => undefined,
      close: () => undefined,
    };

    const provider = createImapProvider(account, {
      createClient: () => {
        built += 1;
        return fakeClient as unknown as ImapFlow;
      },
    });

    const both = Promise.all([provider.verify(), provider.verify()]);
    resolveConnect!();
    await both;

    expect(built).toBe(1);
  });
});
