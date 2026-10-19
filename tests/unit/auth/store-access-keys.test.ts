import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { createAuthStore, type StoredToken } from '../../../src/auth/store.js';
import { createLogger } from '../../../src/core/logger.js';
import { decryptJson, encryptJson, generateToken, hashToken } from '../../../src/auth/crypto.js';

// 只为数写入次数：rename 仍然是真的，行为一点不变。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

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
    /** 落到目标文件上的写入次数：每次落盘恰好一次 rename(tmp, path)。 */
    const writes = () => vi.mocked(fsp.rename).mock.calls.filter(([, to]) => to === path).length;
    // touch 的落盘是 fire-and-forget，没有 promise 可等。写入是串行排队的，所以在它之后再排一次
    // 落盘、等这一次完成，前面那次必然已经写完——不靠固定的 sleep 去赌磁盘够不够快。
    // 但任何一次落盘写的都是当时的整份内存快照，所以「这次 touch 有没有落盘」只能数写入次数，
    // 不能看文件内容：那个排在后面的落盘本身就会把内存里的 last_used_at 写下去。
    const flush = () => store.setEnvAccountsEnabled(false);

    let mark = writes();
    store.touchAccessKey(record.id, 0);
    await flush();
    expect(writes() - mark, '第一次 touch 落盘 + flush').toBe(2);
    expect(onDisk()).toBe(0);

    mark = writes();
    store.touchAccessKey(record.id, 30_000);
    await flush();
    expect(store.getAccessKey(record.id)?.last_used_at).toBe(30_000);
    expect(writes() - mark, '60 秒内的 touch 不落盘，只有 flush 那一次').toBe(1);

    mark = writes();
    store.touchAccessKey(record.id, 61_000);
    await flush();
    expect(writes() - mark, '隔了 60 秒以上，touch 再次落盘').toBe(2);
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
