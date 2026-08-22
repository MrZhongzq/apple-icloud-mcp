import { describe, it, expect } from 'vitest';
import { loadConfig, findAccount } from '../../../src/core/config.js';
import { AppError } from '../../../src/core/errors.js';

const base = {
  ICLOUD_ACCOUNT_1: 'me@icloud.com',
  ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
};

describe('loadConfig', () => {
  it('applies read-allowed / write-denied defaults', () => {
    const cfg = loadConfig({ ...base });
    const acc = cfg.accounts[0]!;
    expect(acc.capabilities.mailRead).toBe(true);
    expect(acc.capabilities.mailWrite).toBe(false);
    expect(acc.capabilities.calendarRead).toBe(true);
    expect(acc.capabilities.calendarWrite).toBe(false);
  });

  it('defaults sender and label to the account email', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.accounts[0]!.sender).toBe('me@icloud.com');
    expect(cfg.accounts[0]!.label).toBe('me@icloud.com');
  });

  it('keeps sender distinct when configured', () => {
    const cfg = loadConfig({ ...base, ICLOUD_SENDER_1: 'alias@icloud.com', ICLOUD_LABEL_1: 'personal' });
    expect(cfg.accounts[0]!.email).toBe('me@icloud.com');
    expect(cfg.accounts[0]!.sender).toBe('alias@icloud.com');
    expect(cfg.accounts[0]!.label).toBe('personal');
  });

  it('forces mail capabilities off when sender falls back to a non-iCloud email, even with ALLOW_MAIL_* explicitly true', () => {
    const cfg = loadConfig({
      ICLOUD_ACCOUNT_1: 'me@gmail.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ALLOW_MAIL_READ_1: 'true',
      ALLOW_MAIL_WRITE_1: 'true',
    });
    const acc = cfg.accounts[0]!;
    expect(acc.capabilities.mailRead).toBe(false);
    expect(acc.capabilities.mailWrite).toBe(false);
    // calendar capabilities must be untouched by the mail domain gate
    expect(acc.capabilities.calendarRead).toBe(true);
    expect(acc.capabilities.calendarWrite).toBe(false);
    expect(cfg.notices.some((n) => n.includes('me@gmail.com'))).toBe(true);
  });

  it('keeps mail capabilities and records no notice for an explicit iCloud sender', () => {
    const cfg = loadConfig({
      ICLOUD_ACCOUNT_1: 'me@gmail.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ICLOUD_SENDER_1: 'alias@icloud.com',
      ALLOW_MAIL_READ_1: 'true',
      ALLOW_MAIL_WRITE_1: 'true',
    });
    const acc = cfg.accounts[0]!;
    expect(acc.capabilities.mailRead).toBe(true);
    expect(acc.capabilities.mailWrite).toBe(true);
    expect(cfg.notices).toHaveLength(0);
  });

  it('keeps mail capabilities for an explicit @icloud.com.cn sender', () => {
    const cfg = loadConfig({
      ICLOUD_ACCOUNT_1: 'me@gmail.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ICLOUD_SENDER_1: 'alias@icloud.com.cn',
      ALLOW_MAIL_READ_1: 'true',
    });
    const acc = cfg.accounts[0]!;
    expect(acc.capabilities.mailRead).toBe(true);
    expect(cfg.notices).toHaveLength(0);
  });

  it('does not treat a domain that merely ends with a matching suffix (notme.com) as iCloud', () => {
    const cfg = loadConfig({
      ICLOUD_ACCOUNT_1: 'me@notme.com',
      ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
      ALLOW_MAIL_READ_1: 'true',
    });
    const acc = cfg.accounts[0]!;
    expect(acc.capabilities.mailRead).toBe(false);
    expect(acc.capabilities.mailWrite).toBe(false);
    expect(cfg.notices.some((n) => n.includes('me@notme.com'))).toBe(true);
  });

  it('parses accounts 2..5 without any enable flag', () => {
    const cfg = loadConfig({
      ...base,
      ICLOUD_ACCOUNT_3: 'work@icloud.com',
      ICLOUD_APP_PASSWORD_3: 'wxyz-wxyz-wxyz-wxyz',
    });
    expect(cfg.accounts.map((a) => a.email)).toEqual(['me@icloud.com', 'work@icloud.com']);
    expect(cfg.accounts[1]!.id).toBe('account_3');
  });

  it('strips surrounding whitespace but preserves inner characters', () => {
    const cfg = loadConfig({ ...base, ICLOUD_APP_PASSWORD_1: '  abcd-efgh-ijkl-mnop' });
    expect(cfg.accounts[0]!.appPassword).toBe('abcd-efgh-ijkl-mnop');
  });

  it('maps legacy lowercase names and records a deprecation', () => {
    const cfg = loadConfig({
      icloud_account: 'old@icloud.com',
      icloud_app_pass: 'abcd-efgh-ijkl-mnop',
      allow_mail_write: 'true',
    });
    expect(cfg.accounts[0]!.email).toBe('old@icloud.com');
    expect(cfg.accounts[0]!.capabilities.mailWrite).toBe(true);
    expect(cfg.deprecations.join(' ')).toContain('icloud_account');
  });

  it('rejects a password without an account', () => {
    expect(() => loadConfig({ ICLOUD_APP_PASSWORD_1: 'abcd' })).toThrowError(AppError);
  });

  it('rejects an empty configuration with an actionable hint', () => {
    try {
      loadConfig({});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('INVALID_INPUT');
      expect((e as AppError).hint).toContain('ICLOUD_ACCOUNT_1');
    }
  });

  it('rejects a non-numeric session TTL', () => {
    expect(() => loadConfig({ ...base, SESSION_TTL_MINUTES: 'soon' })).toThrowError(AppError);
  });

  it('rejects an unrecognised boolean', () => {
    expect(() => loadConfig({ ...base, ALLOW_MAIL_WRITE_1: 'maybe' })).toThrowError(AppError);
  });

  it('rejects an account without a password and points at the Apple ID page', () => {
    try {
      loadConfig({ ICLOUD_ACCOUNT_1: 'me@icloud.com' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_INPUT');
      expect((e as AppError).hint).toContain('appleid.apple.com');
    }
  });

  it('rejects a malformed account email', () => {
    expect(() =>
      loadConfig({ ICLOUD_ACCOUNT_1: 'not-an-email', ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop' }),
    ).toThrowError(AppError);
  });

  it('rejects an unrecognised LOG_LEVEL', () => {
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'chatty' })).toThrowError(AppError);
  });

  it('rejects a non-positive session TTL', () => {
    expect(() => loadConfig({ ...base, SESSION_TTL_MINUTES: '0' })).toThrowError(AppError);
  });

  it('lets an explicitly set new name win over its legacy equivalent', () => {
    const cfg = loadConfig({
      icloud_account: 'legacy@icloud.com',
      icloud_app_pass: 'abcd-efgh-ijkl-mnop',
      ICLOUD_ACCOUNT_1: 'modern@icloud.com',
    });
    expect(cfg.accounts[0]!.email).toBe('modern@icloud.com');
  });

  it('maps legacy multi-account names for accounts 2-5', () => {
    const cfg = loadConfig({
      ...base,
      icloud_account2: 'work@icloud.com',
      icloud_app_pass2: 'wxyz-wxyz-wxyz-wxyz',
      allow_calendar2_write: 'true',
    });
    expect(cfg.accounts.map((a) => a.email)).toEqual(['me@icloud.com', 'work@icloud.com']);
    expect(cfg.accounts[1]!.capabilities.calendarWrite).toBe(true);
    expect(cfg.deprecations.join(' ')).toContain('icloud_account2');
  });

  it('records a deprecation for the obsolete multiple_account_enable flag', () => {
    const cfg = loadConfig({ ...base, multiple_account_enable: '1' });
    expect(cfg.deprecations.join(' ')).toContain('multiple_account_enable');
    expect(cfg.accounts).toHaveLength(1);
  });
});

describe('findAccount', () => {
  it('returns the only account when no email is given', () => {
    const cfg = loadConfig({ ...base });
    expect(findAccount(cfg).email).toBe('me@icloud.com');
  });

  it('requires an explicit email when several accounts exist', () => {
    const cfg = loadConfig({
      ...base,
      ICLOUD_ACCOUNT_2: 'work@icloud.com',
      ICLOUD_APP_PASSWORD_2: 'abcd-efgh-ijkl-mnop',
    });
    expect(() => findAccount(cfg)).toThrowError(AppError);
    expect(findAccount(cfg, 'work@icloud.com').id).toBe('account_2');
  });

  it('lists configured accounts when the email is unknown', () => {
    const cfg = loadConfig({ ...base });
    try {
      findAccount(cfg, 'nobody@icloud.com');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('NOT_FOUND');
      expect((e as AppError).hint).toContain('me@icloud.com');
    }
  });
});
