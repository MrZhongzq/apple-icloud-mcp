import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { decryptJson, encryptJson, generateToken, hashToken } from './crypto.js';

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
  /** 这族令牌是用哪把访问密钥授权的。旧快照里的令牌没有这个字段，是否放行由 provider 决定。 */
  access_key_id?: string;
}

/** 一把访问密钥。只存哈希，明文只在新建那一次返回给调用方。 */
export interface AccessKeyRecord {
  id: string;
  name: string;
  key_hash: string;
  created_at: number;
  enabled: boolean;
  last_used_at?: number;
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

  createAccessKey(name: string): Promise<{ record: AccessKeyRecord; plaintext: string }>;
  /** 按 created_at 升序。 */
  listAccessKeys(): AccessKeyRecord[];
  getAccessKey(id: string): AccessKeyRecord | undefined;
  /** 不管 enabled 与否都返回，由调用方判断。 */
  findAccessKeyByPlaintext(plaintext: string): AccessKeyRecord | undefined;
  setAccessKeyEnabled(id: string, enabled: boolean): Promise<boolean>;
  deleteAccessKey(id: string): Promise<boolean>;
  /** 删掉这把密钥名下的全部令牌记录，返回被删的 family_id（已去重）。 */
  revokeFamiliesByAccessKey(id: string): Promise<string[]>;
  /** 内存里每次都更新 last_used_at；落盘同一把密钥至少间隔 60 秒。 */
  touchAccessKey(id: string, now?: number): void;
  getSettings(): { envAccountsEnabled: boolean };
  setEnvAccountsEnabled(enabled: boolean): Promise<void>;

  /** 清掉已过期的记录，返回清理条数。 */
  sweep(now?: number): Promise<number>;
  /** 供 HTTP 入口在启动时调用一次，把磁盘内容读进内存。 */
  load(): Promise<void>;
}

/** 磁盘上的完整快照：解密/加密的对象直接就是这个形状。 */
interface StoreSnapshot {
  clients: StoredClient[];
  tokens: StoredToken[];
  // 以下两个字段是后加的：旧快照里没有，load() 按默认值处理。
  access_keys?: AccessKeyRecord[];
  settings?: { env_accounts_enabled: boolean };
}

/** last_used_at 落盘的最小间隔：每次请求都重写加密快照太贵，丢一分钟精度无所谓。 */
const TOUCH_PERSIST_INTERVAL_MS = 60_000;

export function createAuthStore(deps: { path: string; key: Buffer; logger: Logger }): AuthStore {
  const { path, key, logger } = deps;

  const clients = new Map<string, StoredClient>();
  const tokens: StoredToken[] = [];
  const byAccessHash = new Map<string, StoredToken>();
  const byRefreshHash = new Map<string, StoredToken>();
  const accessKeys = new Map<string, AccessKeyRecord>();
  const byKeyHash = new Map<string, AccessKeyRecord>();
  const lastTouchPersist = new Map<string, number>();
  let envAccountsEnabled = false;

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
      access_keys: Array.from(accessKeys.values()),
      settings: { env_accounts_enabled: envAccountsEnabled },
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
        loadAccessKeys([], false);
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
        hint: `TOKEN_ENCRYPTION_KEY 可能变了，或 ${basename(path)} 已损坏。删除这个文件会清空全部访问密钥与已授权的客户端，所有人都要重新授权；信封密钥对存放在另一个文件里，不受影响。`,
      });
    }

    clients.clear();
    for (const client of snapshot.clients) {
      clients.set(client.client_id, client);
    }
    tokens.length = 0;
    tokens.push(...snapshot.tokens);
    loadAccessKeys(snapshot.access_keys ?? [], snapshot.settings?.env_accounts_enabled ?? false);
    reindex();
  }

  function loadAccessKeys(records: AccessKeyRecord[], envEnabled: boolean): void {
    accessKeys.clear();
    byKeyHash.clear();
    lastTouchPersist.clear();
    for (const record of records) {
      accessKeys.set(record.id, record);
      byKeyHash.set(record.key_hash, record);
    }
    envAccountsEnabled = envEnabled;
  }

  async function createAccessKey(name: string): Promise<{ record: AccessKeyRecord; plaintext: string }> {
    const plaintext = `amk_${generateToken()}`;
    const record: AccessKeyRecord = {
      id: randomBytes(8).toString('hex'),
      name,
      key_hash: hashToken(plaintext),
      created_at: Date.now(),
      enabled: true,
    };
    accessKeys.set(record.id, record);
    byKeyHash.set(record.key_hash, record);
    await persist();
    return { record, plaintext };
  }

  function listAccessKeys(): AccessKeyRecord[] {
    return Array.from(accessKeys.values()).sort((a, b) => a.created_at - b.created_at);
  }

  function getAccessKey(id: string): AccessKeyRecord | undefined {
    return accessKeys.get(id);
  }

  function findAccessKeyByPlaintext(plaintext: string): AccessKeyRecord | undefined {
    return byKeyHash.get(hashToken(plaintext));
  }

  async function setAccessKeyEnabled(id: string, enabled: boolean): Promise<boolean> {
    const record = accessKeys.get(id);
    if (!record) return false;
    record.enabled = enabled;
    await persist();
    return true;
  }

  async function deleteAccessKey(id: string): Promise<boolean> {
    const record = accessKeys.get(id);
    if (!record) return false;
    accessKeys.delete(id);
    byKeyHash.delete(record.key_hash);
    lastTouchPersist.delete(id);
    await persist();
    return true;
  }

  async function revokeFamiliesByAccessKey(id: string): Promise<string[]> {
    const toRemove = tokens.filter((t) => t.access_key_id === id);
    if (toRemove.length === 0) return [];
    for (const record of toRemove) {
      removeFromIndexes(record);
      const idx = tokens.indexOf(record);
      if (idx !== -1) tokens.splice(idx, 1);
    }
    await persist();
    return Array.from(new Set(toRemove.map((t) => t.family_id)));
  }

  function touchAccessKey(id: string, now: number = Date.now()): void {
    const record = accessKeys.get(id);
    if (!record) return;
    record.last_used_at = now;
    const last = lastTouchPersist.get(id);
    if (last !== undefined && now - last < TOUCH_PERSIST_INTERVAL_MS) return;
    lastTouchPersist.set(id, now);
    // fire-and-forget：走同一条写队列；落盘失败不该让一次正常请求失败，只记错误名。
    persist().catch((err: unknown) => {
      logger.warn('failed to persist access key last_used_at', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    });
  }

  function getSettings(): { envAccountsEnabled: boolean } {
    return { envAccountsEnabled };
  }

  async function setEnvAccountsEnabled(enabled: boolean): Promise<void> {
    envAccountsEnabled = enabled;
    await persist();
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
    createAccessKey,
    listAccessKeys,
    getAccessKey,
    findAccessKeyByPlaintext,
    setAccessKeyEnabled,
    deleteAccessKey,
    revokeFamiliesByAccessKey,
    touchAccessKey,
    getSettings,
    setEnvAccountsEnabled,
    sweep,
    load,
  };
}
