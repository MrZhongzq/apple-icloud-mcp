import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createAuthStore } from '../../../src/auth/store.js';
import { createLogger } from '../../../src/core/logger.js';
import { generateToken, hashToken } from '../../../src/auth/crypto.js';

const logger = createLogger('error', () => {});
const key = randomBytes(32);
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'authstore-'));
  path = join(dir, 'nested', 'tokens.json.enc');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore() {
  return createAuthStore({ path, key, logger });
}

function tokenRecord(overrides: Partial<Parameters<ReturnType<typeof makeStore>['saveTokens']>[0]> = {}) {
  const access = generateToken();
  const refresh = generateToken();
  return {
    record: {
      family_id: 'fam-1',
      client_id: 'client-1',
      access_token_hash: hashToken(access),
      refresh_token_hash: hashToken(refresh),
      scopes: ['mcp'],
      access_expires_at: Date.now() + 3600_000,
      refresh_expires_at: Date.now() + 30 * 24 * 3600_000,
      rotated: false,
      ...overrides,
    },
    access,
    refresh,
  };
}

describe('client registration', () => {
  it('round-trips a client through a reload', async () => {
    const store = makeStore();
    await store.load();
    const saved = await store.registerClient({
      client_id: 'c1',
      client_name: 'probe',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(saved.created_at).toBeGreaterThan(0);

    const reopened = makeStore();
    await reopened.load();
    const got = await reopened.getClient('c1');
    expect(got?.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('creates the directory when it does not exist yet', async () => {
    const store = makeStore();
    await store.load();
    await store.registerClient({ client_id: 'c1', redirect_uris: ['https://x/cb'] });
    expect(existsSync(path)).toBe(true);
  });

  it('returns undefined for an unknown client', async () => {
    const store = makeStore();
    await store.load();
    expect(await store.getClient('nope')).toBeUndefined();
  });
});

describe('encryption at rest', () => {
  it('writes nothing readable to disk', async () => {
    const store = makeStore();
    await store.load();
    await store.registerClient({
      client_id: 'secret-client-id',
      client_name: 'my private connector',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('secret-client-id');
    expect(raw).not.toContain('my private connector');
    expect(raw).not.toContain('claude.ai');
  });

  it('refuses to start on a store encrypted with a different key', async () => {
    const store = makeStore();
    await store.load();
    await store.registerClient({ client_id: 'c1', redirect_uris: ['https://x/cb'] });

    const wrongKey = createAuthStore({ path, key: randomBytes(32), logger });
    await expect(wrongKey.load()).rejects.toThrow();
  });

  it('starts clean when the file does not exist', async () => {
    const store = makeStore();
    await expect(store.load()).resolves.toBeUndefined();
    expect(await store.getClient('anything')).toBeUndefined();
  });
});

describe('token storage', () => {
  it('finds a record by its access token, never by a stored plaintext', async () => {
    const store = makeStore();
    await store.load();
    const { record, access } = tokenRecord();
    await store.saveTokens(record);

    expect((await store.findByAccessToken(access))?.family_id).toBe('fam-1');
    expect(await store.findByAccessToken('some-other-token')).toBeUndefined();

    // 磁盘上不得出现原始令牌
    expect(readFileSync(path, 'utf8')).not.toContain(access);
  });

  it('finds a record by its refresh token', async () => {
    const store = makeStore();
    await store.load();
    const { record, refresh } = tokenRecord();
    await store.saveTokens(record);
    expect((await store.findByRefreshToken(refresh))?.client_id).toBe('client-1');
  });
});

describe('refresh rotation and family revocation', () => {
  it('marks the old refresh token rotated and keeps the family id', async () => {
    const store = makeStore();
    await store.load();
    const first = tokenRecord();
    await store.saveTokens(first.record);

    const second = tokenRecord({ family_id: first.record.family_id });
    await store.rotateRefresh(first.refresh, second.record);

    const old = await store.findByRefreshToken(first.refresh);
    expect(old?.rotated, '旧刷新令牌必须留在存储里并标记为已轮换 —— 删掉它就再也认不出重放').toBe(true);
    expect((await store.findByRefreshToken(second.refresh))?.rotated).toBe(false);
    expect(
      (await store.findByRefreshToken(second.refresh))?.family_id,
      '轮换后必须保留同一个 family_id —— 否则整族吊销机制形同虚设',
    ).toBe(first.record.family_id);
  });

  it('revokes every token in a family', async () => {
    const store = makeStore();
    await store.load();
    const a = tokenRecord({ family_id: 'fam-9' });
    const b = tokenRecord({ family_id: 'fam-9' });
    const other = tokenRecord({ family_id: 'fam-other' });
    await store.saveTokens(a.record);
    await store.saveTokens(b.record);
    await store.saveTokens(other.record);

    expect(await store.revokeFamily('fam-9')).toBe('fam-9');
    expect(await store.findByAccessToken(a.access)).toBeUndefined();
    expect(await store.findByAccessToken(b.access)).toBeUndefined();
    expect(await store.findByAccessToken(other.access), '别的族不能被牵连').toBeDefined();
  });

  it('revokeByToken removes the whole family, not just that one token', async () => {
    const store = makeStore();
    await store.load();
    const a = tokenRecord({ family_id: 'fam-x' });
    const b = tokenRecord({ family_id: 'fam-x' });
    await store.saveTokens(a.record);
    await store.saveTokens(b.record);

    expect(await store.revokeByToken(a.access)).toBe('fam-x');
    expect(await store.findByAccessToken(b.access), '同族的其它令牌必须一起失效').toBeUndefined();
  });

  it('returns undefined when revoking something unknown, without throwing', async () => {
    const store = makeStore();
    await store.load();
    expect(await store.revokeFamily('nope')).toBeUndefined();
    expect(await store.revokeByToken('nope')).toBeUndefined();
  });
});

describe('expiry', () => {
  it('does not return an expired access token', async () => {
    const store = makeStore();
    await store.load();
    const { record, access } = tokenRecord({ access_expires_at: Date.now() - 1000 });
    await store.saveTokens(record);
    expect(await store.findByAccessToken(access)).toBeUndefined();
  });

  it('sweeps records whose refresh token has also expired', async () => {
    const store = makeStore();
    await store.load();
    const dead = tokenRecord({
      access_expires_at: Date.now() - 10_000,
      refresh_expires_at: Date.now() - 5_000,
    });
    const alive = tokenRecord({ family_id: 'fam-alive' });
    await store.saveTokens(dead.record);
    await store.saveTokens(alive.record);

    expect(await store.sweep()).toBe(1);
    expect(await store.findByAccessToken(alive.access)).toBeDefined();
  });

  it('keeps a record whose access token expired but whose refresh token has not', async () => {
    const store = makeStore();
    await store.load();
    const { record, refresh } = tokenRecord({ access_expires_at: Date.now() - 1000 });
    await store.saveTokens(record);
    await store.sweep();
    expect(await store.findByRefreshToken(refresh), '访问令牌过期不代表该刷新').toBeDefined();
  });
});

describe('atomic writes', () => {
  it('leaves no partial file behind and survives a reload after many writes', async () => {
    const store = makeStore();
    await store.load();
    for (let i = 0; i < 25; i += 1) {
      await store.registerClient({ client_id: `c${i}`, redirect_uris: [`https://x/${i}`] });
    }
    const reopened = makeStore();
    await reopened.load();
    expect((await reopened.getClient('c24'))?.redirect_uris).toEqual(['https://x/24']);
    expect((await reopened.getClient('c0'))?.redirect_uris).toEqual(['https://x/0']);
  });

  it('reports a corrupted store instead of silently starting empty', async () => {
    const store = makeStore();
    await store.load();
    await store.registerClient({ client_id: 'c1', redirect_uris: ['https://x/cb'] });

    writeFileSync(path, 'this is not encrypted json', 'utf8');
    const reopened = makeStore();
    await expect(
      reopened.load(),
      '静默从空存储启动会让所有客户端的授权无声失效，且没人知道为什么',
    ).rejects.toThrow();
  });

  it('does not lose a write when callers do not wait for each other', async () => {
    const store = makeStore();
    await store.load();
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);

    // 并发，不逐个 await —— 这正是 HTTP 服务器同时处理多个请求时的形态
    await Promise.all(ids.map((id) => store.registerClient({ client_id: id, redirect_uris: [`https://x/${id}`] })));

    const reopened = makeStore();
    await reopened.load();
    for (const id of ids) {
      expect(await reopened.getClient(id), `${id} 成功返回却不在盘上`).toBeDefined();
    }
  });
});
