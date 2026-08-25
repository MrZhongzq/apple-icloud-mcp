import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { decryptJson, encryptJson, hashToken } from './crypto.js';

export interface StoredClient {
  client_id: string;
  client_secret?: string;
  /**
   * 客户端密钥的过期时刻（**秒**级 epoch，与 RFC 7591 的 `client_secret_expires_at` 同单位，
   * 而不是本文件其余时间戳用的毫秒）；0 表示永不过期，公开客户端为 undefined。
   *
   * 这个字段必须真的存下来：SDK 的客户端认证检查写作
   * `if (client.client_secret_expires_at && client.client_secret_expires_at < now)`，
   * 字段缺席时整段判断被跳过。而 `/register` 的 201 响应里这个字段是有的——注册处理器
   * 自己算好了 30 天后的时刻并放进返回体。也就是说：不存的话，服务器会告诉每个机密客户端
   * "你的密钥 30 天后过期"，然后永远认它。泄露的 client_secret 于是永久有效。
   */
  client_secret_expires_at?: number;
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

  // 所有写入串行排队，而不是各自捕获快照后并发抢跑同一个目标路径。
  // 队列本身用 .catch 吞掉失败，让某次写入失败不会把后面所有排队的写入一起卡死；
  // 失败仍然原样传给发起那次写入的调用方，因为 run（未被 catch 过）才是返回给它的 promise。
  let writeQueue: Promise<void> = Promise.resolve();

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

  /** 实际的落盘工作：调用时才读取当前内存状态并生成快照，绝不在排队之前捕获。 */
  async function writeSnapshotToDisk(): Promise<void> {
    const snapshot: StoreSnapshot = {
      clients: Array.from(clients.values()),
      tokens: [...tokens],
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

  /** 把落盘工作挂到队列尾部，串行执行，避免并发调用者各自捕获快照后互相抢跑覆盖。 */
  function persist(): Promise<void> {
    const run = writeQueue.then(() => writeSnapshotToDisk());
    writeQueue = run.catch(() => undefined);
    return run;
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
