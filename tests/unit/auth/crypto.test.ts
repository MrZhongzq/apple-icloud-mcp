import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
  encryptJson,
  decryptJson,
  parseEncryptionKey,
} from '../../../src/auth/crypto.js';
import { AppError } from '../../../src/core/errors.js';
import { randomBytes } from 'node:crypto';

const key = randomBytes(32);

describe('password hashing', () => {
  it('round-trips a password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery stapler', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('salts every hash, so the same password hashes differently', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('embeds the parameters so a future tuning change can still verify old hashes', () => {
    const stored = hashPassword('x');
    const [scheme, n, r, p] = stored.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('returns false rather than throwing on a malformed stored hash', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$32768$8$1$onlyfourfields')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });
});

describe('token generation', () => {
  it('produces high-entropy, url-safe, non-repeating tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const t = generateToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t.length).toBeGreaterThanOrEqual(40);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it('hashes a token deterministically and irreversibly', () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('encryption at rest', () => {
  it('round-trips an object', () => {
    const value = { clients: [{ id: 'abc', secret: 'shh' }], n: 42 };
    expect(decryptJson(encryptJson(value, key), key)).toEqual(value);
  });

  it('uses a fresh IV every time, so identical plaintext gives different ciphertext', () => {
    const a = encryptJson({ same: true }, key);
    const b = encryptJson({ same: true }, key);
    expect(a).not.toBe(b);
    // 头一段是 IV，必须不同 —— GCM 下同密钥重用 IV 会直接泄露明文
    expect(a.split('.')[0]).not.toBe(b.split('.')[0]);
  });

  it('refuses to decrypt with the wrong key', () => {
    const blob = encryptJson({ secret: 'x' }, key);
    expect(() => decryptJson(blob, randomBytes(32))).toThrow(AppError);
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const blob = encryptJson({ secret: 'x' }, key);
    const [iv, tag, ct] = blob.split('.');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = [iv, tag, flipped.toString('base64')].join('.');
    expect(() => decryptJson(tampered, key)).toThrow(AppError);
  });

  it('does not leak the underlying crypto error message', () => {
    const err = (() => {
      try {
        decryptJson('bad.blob.here', key);
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err!.message.toLowerCase()).not.toContain('unsupported state');
    expect(err!.message.toLowerCase()).not.toContain('auth tag');
  });
});

describe('parseEncryptionKey', () => {
  it('accepts exactly 32 bytes of base64', () => {
    const raw = randomBytes(32).toString('base64');
    expect(parseEncryptionKey(raw)).toHaveLength(32);
  });

  it('rejects a key of the wrong length with an actionable hint', () => {
    const err = (() => {
      try {
        parseEncryptionKey(randomBytes(16).toString('base64'));
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err!.code).toBe('INVALID_INPUT');
    expect(err!.hint ?? '').toMatch(/32/);
  });

  it('rejects text that is not base64', () => {
    expect(() => parseEncryptionKey('!!! not base64 !!!')).toThrow(AppError);
  });
});
