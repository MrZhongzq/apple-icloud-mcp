import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AppError } from '../core/errors.js';

/** scrypt 参数：N=2**15, r=8, p=1, keylen=32。写死在这里，同时也编码进哈希串本身，
 *  这样将来调参也不会让旧哈希失效。 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;
// scrypt 所需内存约为 128 * N * r 字节：128*32768*8 = 32MiB，正好等于 Node 的默认 maxmem（32MiB），
// 会被判定为"超出限制"。显式给足余量，避免这个刚好卡在默认上限上的假失败。
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** 返回 "scrypt$N$r$p$<salt base64url>$<hash base64url>"。 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/** 任何解析失败都返回 false，绝不抛异常——调用方是登录端点，抛异常和"密码错误"在那里语义不同。 */
export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
    if (scheme !== 'scrypt') return false;
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (n <= 0 || r <= 0 || p <= 0) return false;
    const salt = Buffer.from(saltB64 as string, 'base64url');
    const expected = Buffer.from(hashB64 as string, 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = scryptSync(plain, salt, expected.length, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
    // 长度不同时直接返回 false：timingSafeEqual 长度不等会抛，且长度本身不是秘密（固定为公开的 keylen）。
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 32 字节随机 token，base64url 编码，供 OAuth 授权码/访问令牌等使用。 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** token 的 SHA-256（hex），用于只存哈希、不存明文。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** AES-256-GCM 加密任意可 JSON 序列化的值。每次调用都生成新的随机 IV——
 *  同一密钥下重用 IV 会直接泄露明文异或值，这是 GCM 最致命的误用。
 *  输出格式："<iv base64>.<authTag base64>.<ciphertext base64>"。 */
export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString('base64')).join('.');
}

/** 解密 encryptJson 的输出。任何失败（密钥错、格式错、认证标签不匹配、篡改）都统一转成
 *  一个不带原始 crypto 异常信息的 AppError——异常消息可能暗示密钥是否正确，绝不外泄。 */
export function decryptJson<T>(blob: string, key: Buffer): T {
  try {
    const parts = blob.split('.');
    if (parts.length !== 3) throw new Error('malformed blob');
    const [ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64 as string, 'base64');
    const tag = Buffer.from(tagB64 as string, 'base64');
    const ciphertext = Buffer.from(ctB64 as string, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    throw new AppError('INTERNAL', '令牌存储无法解密');
  }
}

/** 校验 TOKEN_ENCRYPTION_KEY：必须是合法 base64，且解码后恰好 32 字节（AES-256 的密钥长度）。 */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
  if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !BASE64_PATTERN.test(trimmed)) {
    throw new AppError('INVALID_INPUT', 'TOKEN_ENCRYPTION_KEY 不是合法的 base64', {
      hint: '需要 32 字节（256 位）密钥的 base64 编码，可用 openssl rand -base64 32 生成',
    });
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new AppError('INVALID_INPUT', `TOKEN_ENCRYPTION_KEY 解码后长度不对：${key.length} 字节`, {
      hint: '必须恰好 32 字节（256 位），可用 openssl rand -base64 32 生成',
    });
  }
  return key;
}
