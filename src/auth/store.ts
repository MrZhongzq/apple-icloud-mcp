import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { decryptJson, encryptJson, hashToken } from './crypto.js';

export interface StoredClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
}

/** 一次授权产生的一族令牌。刷新令牌轮换时 family_id 不变，用于泄露时整族吊销。 */
export interface StoredToken {
  family_id: string;
  client_id: string;
  /** 只存哈希；原始令牌离开本进程后就再也拿不回来。 */
  access_token_hash: string;
  refresh_token_hash: string;
  scopes: string[];
  access_expires_at: number;
  refresh_expires_at: number;
  /** 该刷新令牌是否已被轮换掉。已轮换的令牌再次出现 = 泄露信号。 */
  rotated: boolean;
}

export interface AuthStore {
  registerClient(client: Omit<StoredClient, 'created_at'>): Promise<StoredClient>;
  getClient(clientId: string): Promise<StoredClient | undefined>;

  saveTokens(record: StoredToken): Promise<void>;
  findByAccessToken(token: string): Promise<StoredToken | undefined>;
  findByRefreshToken(token: string): Promise<StoredToken | undefined>;

  /** 轮换：把旧记录标记 rotated 并写入新记录，同一个 family_id。 */
  rotateRefresh(oldRefreshToken: string, next: StoredToken): Promise<void>;
  /** 吊销一族的全部令牌，返回被吊销的 family_id（不存在则返回 undefined）。 */
  revokeFamily(familyId: string): Promise<string | undefined>;
  revokeByToken(token: string): Promise<string | undefined>;

  /** 清掉已过期的记录，返回清理条数。 */
  sweep(now?: number): Promise<number>;
  /** 供 HTTP 入口在启动时调用一次，把磁盘内容读进内存。 */
  load(): Promise<void>;
}

/** 磁盘上的完整快照：解密/加密的对象直接就是这个形状。 */
interface StoreSnapshot {
  clients: StoredClient[];
  tokens: StoredToken[];
}

export function createAuthStore(deps: { path: string; key: Buffer; logger: Logger }): AuthStore {
  const { path, key, logger } = deps;

  const clients = new Map<string, StoredClient>();
  const tokens: StoredToken[] = [];
  const byAccessHash = new Map<string, StoredToken>();
  const byRefreshHash = new Map<string, StoredToken>();

  function reindex(): void {
    byAccessHash.clear();
    byRefreshHash.clear();
    for (const record of tokens) {
      byAccessHash.set(record.access_token_hash, record);
      byRefreshHash.set(record.refresh_token_hash, record);
    }
  }

  function removeFromIndexes(record: StoredToken): void {
    if (byAccessHash.get(record.access_token_hash) === record) byAccessHash.delete(record.access_token_hash);
    if (byRefreshHash.get(record.refresh_token_hash) === record) byRefreshHash.delete(record.refresh_token_hash);
  }

  async function persist(): Promise<void> {
    const snapshot: StoreSnapshot = {
      clients: Array.from(clients.values()),
      tokens,
    };
    const blob = encryptJson(snapshot, key);
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(blob, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmpPath, path);
    } catch (err) {
      // 尽力清理临时文件，避免留下垃圾；rename 失败本身仍然要向上抛出。
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async function load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        clients.clear();
        tokens.length = 0;
        reindex();
        return;
      }
      throw err;
    }

    let snapshot: StoreSnapshot;
    try {
      snapshot = decryptJson<StoreSnapshot>(raw, key);
    } catch {
      throw new AppError('INTERNAL', '令牌存储无法解密', {
        hint: 'TOKEN_ENCRYPTION_KEY 可能变了，或存储文件已损坏。删除该文件会让所有客户端重新授权。',
      });
    }

    clients.clear();
    for (const client of snapshot.clients) {
      clients.set(client.client_id, client);
    }
    tokens.length = 0;
    tokens.push(...snapshot.tokens);
    reindex();
  }

  async function registerClient(client: Omit<StoredClient, 'created_at'>): Promise<StoredClient> {
    const saved: StoredClient = { ...client, created_at: Date.now() };
    clients.set(saved.client_id, saved);
    await persist();
    return saved;
  }

  async function getClient(clientId: string): Promise<StoredClient | undefined> {
    return clients.get(clientId);
  }

  async function saveTokens(record: StoredToken): Promise<void> {
    tokens.push(record);
    byAccessHash.set(record.access_token_hash, record);
    byRefreshHash.set(record.refresh_token_hash, record);
    await persist();
  }

  function liveByAccessHash(hash: string, now: number): StoredToken | undefined {
    const record = byAccessHash.get(hash);
    if (!record) return undefined;
    if (record.access_expires_at <= now) return undefined;
    return record;
  }

  function liveByRefreshHash(hash: string, now: number): StoredToken | undefined {
    const record = byRefreshHash.get(hash);
    if (!record) return undefined;
    if (record.refresh_expires_at <= now) return undefined;
    return record;
  }

  async function findByAccessToken(token: string): Promise<StoredToken | undefined> {
    return liveByAccessHash(hashToken(token), Date.now());
  }

  async function findByRefreshToken(token: string): Promise<StoredToken | undefined> {
    return liveByRefreshHash(hashToken(token), Date.now());
  }

  async function rotateRefresh(oldRefreshToken: string, next: StoredToken): Promise<void> {
    const hash = hashToken(oldRefreshToken);
    const old = byRefreshHash.get(hash);
    if (old) old.rotated = true;
    tokens.push(next);
    byAccessHash.set(next.access_token_hash, next);
    byRefreshHash.set(next.refresh_token_hash, next);
    await persist();
  }

  async function revokeFamily(familyId: string): Promise<string | undefined> {
    const toRemove = tokens.filter((t) => t.family_id === familyId);
    if (toRemove.length === 0) return undefined;
    for (const record of toRemove) {
      removeFromIndexes(record);
      const idx = tokens.indexOf(record);
      if (idx !== -1) tokens.splice(idx, 1);
    }
    await persist();
    return familyId;
  }

  async function revokeByToken(token: string): Promise<string | undefined> {
    const hash = hashToken(token);
    const record = byAccessHash.get(hash) ?? byRefreshHash.get(hash);
    if (!record) return undefined;
    return revokeFamily(record.family_id);
  }

  async function sweep(now: number = Date.now()): Promise<number> {
    const dead = tokens.filter((t) => t.access_expires_at <= now && t.refresh_expires_at <= now);
    if (dead.length === 0) return 0;
    for (const record of dead) {
      removeFromIndexes(record);
      const idx = tokens.indexOf(record);
      if (idx !== -1) tokens.splice(idx, 1);
    }
    await persist();
    logger.debug('swept expired token records', { count: dead.length });
    return dead.length;
  }

  return {
    registerClient,
    getClient,
    saveTokens,
    findByAccessToken,
    findByRefreshToken,
    rotateRefresh,
    revokeFamily,
    revokeByToken,
    sweep,
    load,
  };
}
