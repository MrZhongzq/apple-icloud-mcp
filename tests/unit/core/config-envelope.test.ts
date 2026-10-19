import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  loadConfig,
  loadHttpConfig,
  accountFromEnvelopeEnv,
  capabilityHint,
  ENVELOPE_ENV_KEYS,
} from '../../../src/core/config.js';
import { hashPassword } from '../../../src/auth/crypto.js';

const okEnv = { ICLOUD_ACCOUNT_1: 'x@icloud.com', ICLOUD_APP_PASSWORD_1: 'p' };

describe('loadConfig zero accounts', () => {
  it('loadConfig still refuses zero accounts by default', () => {
    expect(() => loadConfig({})).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('loadConfig accepts zero accounts when allowed', () => {
    expect(loadConfig({}, { allowNoAccounts: true }).accounts).toEqual([]);
  });
});

describe('accountFromEnvelopeEnv', () => {
  it('exposes exactly the 12 whitelisted keys', () => {
    expect(ENVELOPE_ENV_KEYS).toHaveLength(12);
  });

  it('applies the iCloud sender guard', () => {
    const { account, notices } = accountFromEnvelopeEnv({
      ICLOUD_ACCOUNT_1: 'x@gmail.com',
      ICLOUD_APP_PASSWORD_1: 'p',
      ALLOW_MAIL_READ_1: 'true',
    });
    expect(account.capabilities.mailRead).toBe(false);
    expect(notices.length).toBe(1);
  });

  it('keeps write defaults off', () => {
    const { account } = accountFromEnvelopeEnv(okEnv);
    expect(account.capabilities.mailWrite).toBe(false);
    expect(account.capabilities.calendarWrite).toBe(false);
    expect(account.capabilities.remindersWrite).toBe(false);
    expect(account.capabilities.contactsWrite).toBe(false);
  });

  it('rejects a malformed boolean', () => {
    expect(() => accountFromEnvelopeEnv({ ...okEnv, ALLOW_CALENDAR_WRITE_1: 'yess' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('rejects an envelope without account info', () => {
    expect(() => accountFromEnvelopeEnv({})).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('ignores non-whitelisted and other-slot keys and non-string values', () => {
    const plain = accountFromEnvelopeEnv(okEnv);
    const noisy = accountFromEnvelopeEnv({
      ...okEnv,
      ICLOUD_ACCOUNT_2: 'y@icloud.com',
      LOG_LEVEL: 'debug',
      PUBLIC_URL: 'https://evil.example',
      ALLOW_MAIL_WRITE_1: true,
    });
    expect(noisy.account).toEqual(plain.account);
    expect(noisy.notices).toEqual(plain.notices);
  });

  it('marks origin envelope with id account_1', () => {
    const { account } = accountFromEnvelopeEnv(okEnv);
    expect(account.origin).toBe('envelope');
    expect(account.id).toBe('account_1');
  });
});

describe('capabilityHint', () => {
  it('differs by origin', () => {
    const env = { ...accountFromEnvelopeEnv(okEnv).account };
    const fromEnv = loadConfig({ ...okEnv, ICLOUD_ACCOUNT_2: 'y@icloud.com', ICLOUD_APP_PASSWORD_2: 'p' })
      .accounts[1]!;
    expect(capabilityHint(fromEnv, 'ALLOW_MAIL_READ')).toBe('设置环境变量 ALLOW_MAIL_READ_2=true 后重启服务');
    expect(capabilityHint(env, 'ALLOW_MAIL_READ')).toBe(
      '在你自己的 .env 里把 ALLOW_MAIL_READ_1 设为 true，重新生成信封后再登录',
    );
  });
});

describe('loadHttpConfig envelopeKeyPath', () => {
  const base = {
    PUBLIC_URL: 'https://mcp.example.com',
    ADMIN_PASSWORD_HASH: hashPassword('pw'),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('derives envelopeKeyPath next to the token store', () => {
    const cfg = loadHttpConfig({ ...base, TOKEN_STORE_PATH: '/data/tokens.json.enc' });
    expect(cfg.envelopeKeyPath).toBe(path.join('/data', 'envelope-key.json.enc'));
  });

  it('lets ENVELOPE_KEY_PATH override', () => {
    const cfg = loadHttpConfig({ ...base, ENVELOPE_KEY_PATH: '/elsewhere/k.enc' });
    expect(cfg.envelopeKeyPath).toBe('/elsewhere/k.enc');
  });
});
