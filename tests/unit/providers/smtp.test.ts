import { describe, it, expect, vi } from 'vitest';
import type { Transporter } from 'nodemailer';
import { mapSmtpError, createSmtpProvider } from '../../../src/providers/icloud/smtp.js';
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

describe('mapSmtpError', () => {
  it('maps a 535 authentication rejection to AUTH_FAILED', () => {
    const mapped = mapSmtpError(Object.assign(new Error('Invalid login'), { responseCode: 535 }));
    expect(mapped.code).toBe('AUTH_FAILED');
    expect(mapped.hint).toContain('App 专用密码');
  });

  it('maps a 421/450 throttle to a retryable RATE_LIMITED', () => {
    const mapped = mapSmtpError(Object.assign(new Error('too many messages'), { responseCode: 421 }));
    expect(mapped.code).toBe('RATE_LIMITED');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a 550 rejection to INVALID_INPUT', () => {
    const mapped = mapSmtpError(Object.assign(new Error('no such user'), { responseCode: 550 }));
    expect(mapped.code).toBe('INVALID_INPUT');
    expect(mapped.retryable).toBe(false);
  });

  it('falls back to a retryable UPSTREAM_ERROR without leaking details', () => {
    const mapped = mapSmtpError(new Error('AUTH PLAIN abcd-efgh'));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.message).not.toContain('abcd-efgh');
  });
});

describe('createSmtpProvider.close (I9)', () => {
  it('closes the transporter once one has actually been created', async () => {
    const close = vi.fn();
    const provider = createSmtpProvider(account, {
      createTransport: () =>
        ({ close, verify: vi.fn().mockResolvedValue(undefined), sendMail: vi.fn() }) as unknown as Transporter,
    });

    await provider.verify(); // lazily creates the transporter
    await provider.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is a no-op -- never builds a transporter -- when nothing was ever sent or verified', async () => {
    const createTransport = vi.fn();
    const provider = createSmtpProvider(account, { createTransport });

    await provider.close();

    expect(createTransport).not.toHaveBeenCalled();
  });
});
