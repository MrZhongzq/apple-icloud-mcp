import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/core/config.js';
import { AppError } from '../../../src/core/errors.js';
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
    const blob = JSON.stringify(err);
    expect(blob).not.toContain(goodKey);
    expect(blob).not.toContain('scrypt$');
  });
});
