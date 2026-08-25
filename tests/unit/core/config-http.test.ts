import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/core/config.js';
import { AppError } from '../../../src/core/errors.js';
import { expectNoSecretLeak } from '../../helpers/no-secret-leak.js';
import { hashPassword, verifyPassword } from '../../../src/auth/crypto.js';
import { randomBytes } from 'node:crypto';

const goodKey = randomBytes(32).toString('base64');
const base = {
  PUBLIC_URL: 'https://mcp.example.com',
  ADMIN_PASSWORD_HASH: 'scrypt$32768$8$1$c2FsdA$aGFzaA',
  TOKEN_ENCRYPTION_KEY: goodKey,
};

describe('loadHttpConfig', () => {
  it('defaults the port and the store path', () => {
    const cfg = loadHttpConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(17733);
    expect(cfg.tokenStorePath).toContain('tokens.json.enc');
    expect(cfg.publicUrl.origin).toBe('https://mcp.example.com');
  });

  it('requires PUBLIC_URL, and names it in the hint', () => {
    const err = (() => {
      try {
        loadHttpConfig({ ...base, PUBLIC_URL: undefined } as NodeJS.ProcessEnv);
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err!.code).toBe('INVALID_INPUT');
    expect(err!.message + (err!.hint ?? '')).toContain('PUBLIC_URL');
  });

  it('requires ADMIN_PASSWORD_HASH', () => {
    expect(() =>
      loadHttpConfig({ ...base, ADMIN_PASSWORD_HASH: undefined } as NodeJS.ProcessEnv),
    ).toThrow(AppError);
  });

  it('rejects a malformed ADMIN_PASSWORD_HASH at load time, instead of only failing at login', () => {
    const err = (() => {
      try {
        loadHttpConfig({ ...base, ADMIN_PASSWORD_HASH: 'correct horse battery staple' } as NodeJS.ProcessEnv);
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err!.code).toBe('INVALID_INPUT');
  });

  it('still accepts the well-formed hash fixture the other tests rely on', () => {
    expect(() => loadHttpConfig({ ...base } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('trims a whitespace-padded ADMIN_PASSWORD_HASH so the loaded value still verifies the original password', () => {
    // Simulates the ordinary paste accidents that produce padding: a leading space from
    // ".env" syntax like "ADMIN_PASSWORD_HASH= <value>", and trailing space picked up when
    // copying out of a terminal. The property that matters is not "load succeeds" but that
    // the loaded hash can still authenticate the password it was generated from.
    const plain = 'correct horse battery staple';
    const stored = hashPassword(plain);
    const padded = '  ' + stored + '  ';
    const cfg = loadHttpConfig({ ...base, ADMIN_PASSWORD_HASH: padded } as NodeJS.ProcessEnv);
    expect(verifyPassword(plain, cfg.adminPasswordHash)).toBe(true);
  });

  it('trims a whitespace-padded TOKEN_ENCRYPTION_KEY to a usable 32-byte key', () => {
    const cfg = loadHttpConfig({ ...base, TOKEN_ENCRYPTION_KEY: '  ' + goodKey + '  ' } as NodeJS.ProcessEnv);
    expect(cfg.encryptionKey).toHaveLength(32);
  });

  it('trims a whitespace-padded PUBLIC_URL', () => {
    const cfg = loadHttpConfig({ ...base, PUBLIC_URL: '  https://mcp.example.com  ' } as NodeJS.ProcessEnv);
    expect(cfg.publicUrl.origin).toBe('https://mcp.example.com');
  });

  it('requires TOKEN_ENCRYPTION_KEY and validates its length', () => {
    expect(() =>
      loadHttpConfig({ ...base, TOKEN_ENCRYPTION_KEY: undefined } as NodeJS.ProcessEnv),
    ).toThrow(AppError);
    expect(() =>
      loadHttpConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=' } as NodeJS.ProcessEnv),
    ).toThrow(AppError);
  });

  it('rejects a PUBLIC_URL that is not https, since OAuth metadata requires it', () => {
    const err = (() => {
      try {
        loadHttpConfig({ ...base, PUBLIC_URL: 'http://mcp.example.com' } as NodeJS.ProcessEnv);
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err!.code).toBe('INVALID_INPUT');
    expect(err!.hint ?? '').toMatch(/https/i);
  });

  it('allows http on localhost, so a developer can try it without a certificate', () => {
    expect(() =>
      loadHttpConfig({ ...base, PUBLIC_URL: 'http://localhost:17733' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  // 默认必须是 false：端口直接暴露时 X-Forwarded-For 是调用方自己写的，默认信它等于
  // 默认让任何人自选限流桶。要开是部署方的显式声明（本仓库的 compose 就显式开着）。
  it('leaves TRUST_PROXY off unless it is set, and accepts the usual boolean spellings', () => {
    expect(loadHttpConfig({ ...base } as NodeJS.ProcessEnv).trustProxy).toBe(false);
    expect(loadHttpConfig({ ...base, TRUST_PROXY: 'true' } as NodeJS.ProcessEnv).trustProxy).toBe(true);
    expect(loadHttpConfig({ ...base, TRUST_PROXY: '1' } as NodeJS.ProcessEnv).trustProxy).toBe(true);
    expect(loadHttpConfig({ ...base, TRUST_PROXY: 'false' } as NodeJS.ProcessEnv).trustProxy).toBe(false);
  });

  it('refuses an unrecognizable TRUST_PROXY instead of silently treating it as off', () => {
    expect(() =>
      loadHttpConfig({ ...base, TRUST_PROXY: 'maybe' } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => loadHttpConfig({ ...base, PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow(AppError);
    expect(() => loadHttpConfig({ ...base, PORT: '0' } as NodeJS.ProcessEnv)).toThrow(AppError);
    expect(() => loadHttpConfig({ ...base, PORT: '70000' } as NodeJS.ProcessEnv)).toThrow(AppError);
  });

  it('never puts the encryption key or the password hash into an error message', () => {
    const err = (() => {
      try {
        loadHttpConfig({ ...base, PUBLIC_URL: 'not a url' } as NodeJS.ProcessEnv);
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    // 不能只查 JSON.stringify：Error.prototype.message 不可枚举，序列化时整个看不见，
    // 于是「把密钥写进 message」这种最直接的泄露会让这条测试永远绿。
    expectNoSecretLeak(err, [goodKey, base.ADMIN_PASSWORD_HASH]);
  });

  it('would actually catch a secret leaked through the non-enumerable message channel', () => {
    // 守住上一条测试的检查手段本身：把密钥塞进 message 造一个假错误，
    // expectNoSecretLeak 必须抓到它。否则「不泄露」的保证只是看起来存在。
    const fake = new AppError('INVALID_INPUT', `密钥有问题：${goodKey}`);
    expect(() => expectNoSecretLeak(fake, [goodKey])).toThrow();
    expect(JSON.stringify(fake), 'message 确实不可枚举，这正是旧写法失明的原因').not.toContain(goodKey);
  });
});
