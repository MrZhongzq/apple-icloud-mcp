import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createAuthStore, type StoredToken } from '../../../src/auth/store.js';
import { createLogger } from '../../../src/core/logger.js';
import { decryptJson, encryptJson, generateToken, hashToken } from '../../../src/auth/crypto.js';

const logger = createLogger('error', () => {});
const key = randomBytes(32);
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'authstore-ak-'));
  path = join(dir, 'tokens.json.enc');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const makeStore = () => createAuthStore({ path, key, logger });

function tokenRecord(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    family_id: generateToken(),
    client_id: 'c1',
    access_token_hash: hashToken(generateToken()),
    refresh_token_hash: hashToken(generateToken()),
    scopes: [],
    access_expires_at: Date.now() + 60_000,
    refresh_expires_at: Date.now() + 120_000,
    rotated: false,
    ...overrides,
  };
}

describe('access keys in AuthStore', () => {
  it('created key plaintext has the amk_ shape and is never persisted', async () => {
    const store = makeStore();
    const { record, plaintext } = await store.createAccessKey('alice');
    expect(plaintext).toMatch(/^amk_[A-Za-z0-9_-]{43}$/);
    expect(record.enabled).toBe(true);
    const json = JSON.stringify(decryptJson(readFileSync(path, 'utf8'), key));
    expect(json).not.toContain(plaintext);
    expect(json).toContain(hashToken(plaintext));
  });

  it('findAccessKeyByPlaintext returns the record, disabled or not', async () => {
    const store = makeStore();
    const { record, plaintext } = await store.createAccessKey('alice');
    expect(store.findAccessKeyByPlaintext(plaintext)?.id).toBe(record.id);
    expect(store.findAccessKeyByPlaintext('amk_nope')).toBeUndefined();
    await store.setAccessKeyEnabled(record.id, false);
    expect(store.findAccessKeyByPlaintext(plaintext)?.enabled).toBe(false);
    expect(await store.setAccessKeyEnabled('missing', true)).toBe(false);
  });

  it('keys and settings survive a reload', async () => {
    const store = makeStore();
    await store.createAccessKey('first');
    await store.createAccessKey('second');
    await store.setEnvAccountsEnabled(true);
    const again = makeStore();
    await again.load();
    expect(again.listAccessKeys().map((k) => k.name)).toEqual(['first', 'second']);
    expect(again.getSettings().envAccountsEnabled).toBe(true);
  });

  it('an old snapshot without access_keys or settings loads with defaults', async () => {
    const old = tokenRecord();
    const accessToken = generateToken();
    old.access_token_hash = hashToken(accessToken);
    writeFileSync(path, encryptJson({ clients: [], tokens: [old] }, key), 'utf8');
    const store = makeStore();
    await store.load();
    expect(store.listAccessKeys()).toEqual([]);
    expect(store.getSettings().envAccountsEnabled).toBe(false);
    expect((await store.findByAccessToken(accessToken))?.family_id).toBe(old.family_id);
  });

  it("revokeFamiliesByAccessKey removes only that key's families", async () => {
    const store = makeStore();
    const a = (await store.createAccessKey('a')).record;
    const b = (await store.createAccessKey('b')).record;
    const ta1 = tokenRecord({ family_id: 'fa', access_key_id: a.id });
    const ta2 = tokenRecord({ family_id: 'fa', access_key_id: a.id });
    const tb = tokenRecord({ family_id: 'fb', access_key_id: b.id });
    const legacy = tokenRecord({ family_id: 'fl' });
    for (const t of [ta1, ta2, tb, legacy]) await store.saveTokens(t);
    expect(await store.revokeFamiliesByAccessKey(a.id)).toEqual(['fa']);
    const again = makeStore();
    await again.load();
    expect(await again.revokeFamiliesByAccessKey(a.id)).toEqual([]);
    expect(await again.revokeFamily('fb')).toBe('fb');
    expect(await again.revokeFamily('fl')).toBe('fl');
  });

  it('deleteAccessKey removes the record and its hash index', async () => {
    const store = makeStore();
    const { record, plaintext } = await store.createAccessKey('a');
    expect(await store.deleteAccessKey(record.id)).toBe(true);
    expect(await store.deleteAccessKey(record.id)).toBe(false);
    expect(store.getAccessKey(record.id)).toBeUndefined();
    expect(store.findAccessKeyByPlaintext(plaintext)).toBeUndefined();
  });

  it('touchAccessKey persists at most once per 60 seconds per key', async () => {
    const store = makeStore();
    const { record } = await store.createAccessKey('a');
    const onDisk = () =>
      decryptJson<{ access_keys: { last_used_at?: number }[] }>(readFileSync(path, 'utf8'), key).access_keys[0]!
        .last_used_at;
    const settle = () => new Promise((r) => setTimeout(r, 50));

    store.touchAccessKey(record.id, 0);
    await settle();
    expect(onDisk()).toBe(0);

    store.touchAccessKey(record.id, 30_000);
    await settle();
    expect(store.getAccessKey(record.id)?.last_used_at).toBe(30_000);
    expect(onDisk()).toBe(0);

    store.touchAccessKey(record.id, 61_000);
    await settle();
    expect(onDisk()).toBe(61_000);
  });

  it('decrypt failure hint names the token store file and its consequences', async () => {
    await makeStore().createAccessKey('a');
    const wrong = createAuthStore({ path, key: randomBytes(32), logger });
    const err = await wrong.load().then(
      () => undefined,
      (e) => e as { hint?: string },
    );
    expect(err?.hint).toContain('tokens.json.enc');
    expect(err?.hint).toContain('访问密钥');
  });
});
