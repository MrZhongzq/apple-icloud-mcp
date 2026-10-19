import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateEnvelopeKeyring } from '../../../src/auth/keyring.js';
import { encryptJson } from '../../../src/auth/crypto.js';
import type { Logger } from '../../../src/core/logger.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('envelope keyring', () => {
  let dir: string;
  let path: string;
  const key = randomBytes(32);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keyring-'));
    path = join(dir, 'envelope-key.json.enc');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('public key text has the amp1_ shape', async () => {
    const ring = await loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger: makeLogger() });
    expect(ring.publicKeyText).toMatch(/^amp1_[A-Za-z0-9_-]{43}$/);
    expect(ring.publicKeyRaw.length).toBe(32);
  });

  it('the same file yields the same key pair across reloads', async () => {
    const a = await loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger: makeLogger() });
    const b = await loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger: makeLogger() });
    expect(b.publicKeyText).toBe(a.publicKeyText);
    expect(b.kid).toBe(a.kid);
  });

  it('logs generation without key material', async () => {
    const logger = makeLogger();
    const ring = await loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger });
    expect(logger.info).toHaveBeenCalledWith('generated a new envelope key pair');
    expect(JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(ring.publicKeyText);
  });

  it('the file on disk contains no raw key material', async () => {
    const ring = await loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger: makeLogger() });
    const d = (ring.privateKey.export({ format: 'jwk' }) as { d: string }).d;
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(d);
    expect(raw).not.toContain(Buffer.from(d, 'base64url').toString('base64'));
    expect(raw).not.toContain(Buffer.from(d, 'base64url').toString('hex'));
  });

  it('a wrong encryption key fails with the hint naming the file', async () => {
    await loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger: makeLogger() });
    const err = await loadOrCreateEnvelopeKeyring({ path, encryptionKey: randomBytes(32), logger: makeLogger() }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'INTERNAL', message: '信封密钥文件无法解密' });
    expect((err as { hint?: string }).hint).toContain(path);
  });

  it('a structurally invalid payload fails the same way', async () => {
    await writeFile(path, encryptJson({ v: 1, jwk: { kty: 'OKP' } }, key), 'utf8');
    await expect(loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger: makeLogger() })).rejects.toMatchObject({
      message: '信封密钥文件无法解密',
    });
  });

  it('deleting the file regenerates a different key pair', async () => {
    const a = await loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger: makeLogger() });
    await rm(path);
    const b = await loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger: makeLogger() });
    expect(b.publicKeyText).not.toBe(a.publicKeyText);
  });

  it.skipIf(process.platform === 'win32')('file mode is 0600 on POSIX', async () => {
    await loadOrCreateEnvelopeKeyring({ path, encryptionKey: key, logger: makeLogger() });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
