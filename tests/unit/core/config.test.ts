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
