import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { decryptJson, encryptJson } from './crypto.js';

export interface EnvelopeKeyring {
  /** 给使用者的公钥文本：`amp1_` + base64url(原始公钥 32 字节)。 */
  publicKeyText: string;
  kid: string;
  publicKeyRaw: Buffer;
  privateKey: KeyObject;
}

interface KeyFile {
  v: 1;
  jwk: { kty: string; crv: string; x: string; d: string };
}

/** kid = base64url(sha256(原始公钥).subarray(0, 8))。信封里带它，服务端据此判断用的是哪把公钥。 */
export function kidOf(publicKeyRaw: Buffer): string {
  return createHash('sha256').update(publicKeyRaw).digest().subarray(0, 8).toString('base64url');
}

function buildKeyring(privateKey: KeyObject): EnvelopeKeyring {
  // JWK 的 x 本身就是 base64url 编码的 32 字节原始公钥，无需再手拆 DER。
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('x25519 public key has no x');
  const publicKeyRaw = Buffer.from(x, 'base64url');
  return { publicKeyText: `amp1_${x}`, kid: kidOf(publicKeyRaw), publicKeyRaw, privateKey };
}

/** 写法同 store.ts::writeSnapshotToDisk：临时文件 + fsync + rename，崩溃时不会留下半截密钥文件。
 *  这个文件存的是长期私钥，所以创建时就带 0600，而不是写完再 chmod（中间有一段窗口）。 */
async function writeAtomic(path: string, blob: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmpPath, 'w', 0o600);
  try {
    await fh.writeFile(blob, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function loadOrCreateEnvelopeKeyring(opts: {
  path: string;
  encryptionKey: Buffer;
  logger: Logger;
}): Promise<EnvelopeKeyring> {
  const { path, encryptionKey, logger } = opts;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const { privateKey } = generateKeyPairSync('x25519');
    const file: KeyFile = { v: 1, jwk: privateKey.export({ format: 'jwk' }) as KeyFile['jwk'] };
    await writeAtomic(path, encryptJson(file, encryptionKey));
    // 日志里不放公钥、kid 之外的任何东西：这里只说"生成了"。
    logger.info('generated a new envelope key pair');
    return buildKeyring(privateKey);
  }

  // 解密失败与载荷结构不对一律同一个报错：对运维来说都是"这个文件用不了"，处置也相同。
  try {
    const file = decryptJson<KeyFile>(raw, encryptionKey);
    if (file.v !== 1) throw new Error('unsupported version');
    return buildKeyring(createPrivateKey({ key: file.jwk, format: 'jwk' }));
  } catch {
    throw new AppError('INTERNAL', '信封密钥文件无法解密', {
      hint: `TOKEN_ENCRYPTION_KEY 可能变了。删除 ${path} 后重启会生成新的密钥对：访问密钥与令牌不受影响，但所有使用者都要换新的 MCP_ENVELOPE_PUBKEY。`,
    });
  }
}
