import { createDecipheriv, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import { accountFromEnvelopeEnv, type AccountConfig } from '../core/config.js';
import { AppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { EnvelopeKeyring } from './keyring.js';

/**
 * 服务端拆信封。格式与 scripts/make-envelope.mjs::sealEnvelope 逐字节一致，改这里必须同时改那边
 * （tests/unit/auth/envelope.test.ts 用那个脚本封、用这里拆，两边对不上就红）。
 *
 * 信封文本：`ame1.` + base64url(JSON `{ v: 1, kid, epk, iv, ct, tag }`)。
 * 密钥：X25519(服务端私钥, epk) → HKDF-SHA256(salt = epk ‖ 服务端公钥, info) → AES-256-GCM，
 * AAD = `ame1.` + kid。载荷：`{ v: 1, nonce, iat, env }`。
 */

/** iat 最多可以比服务器时钟早这么久：使用者生成信封后有五分钟去用它。 */
export const ENVELOPE_MAX_AGE_MS = 300_000;
/** iat 最多可以比服务器时钟晚这么久：容忍沙盒与服务器之间的时钟偏差。 */
export const ENVELOPE_MAX_FUTURE_SKEW_MS = 60_000;

const ENVELOPE_PREFIX = 'ame1.';
const HKDF_INFO = 'apple-icloud-mcp envelope v1';
const MIN_NONCE_BYTES = 16;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const FORMAT_HINT = '把 make-envelope.mjs 输出的那一整行原样传入，不要加引号或改动';
const KEY_HINT = '向服务器主人要当前的公钥，更新 MCP_ENVELOPE_PUBKEY 后重新生成信封';
const PAYLOAD_HINT = '用仓库里最新的 make-envelope.mjs 重新生成';
const REGENERATE_HINT = '重新运行 node scripts/make-envelope.mjs 生成新信封后再试一次';

/** 日志里出现的只有这几个类别：信封原文与载荷里有 App 专用密码，一个字节都不能进日志。 */
type RejectReason = 'malformed' | 'wrong_key' | 'undecryptable' | 'bad_payload' | 'expired' | 'replayed';

interface Outer {
  kid: string;
  epk: Buffer;
  iv: Buffer;
  ct: Buffer;
  tag: Buffer;
}

interface Payload {
  nonce: string;
  iat: number;
  env: Record<string, unknown>;
}

export interface EnvelopeOpener {
  open(text: string): { account: AccountConfig; notices: string[] };
  /** 忘掉窗口已过的 nonce，返回忘掉了几条。由 bin/http.ts 的定时清理器调用。 */
  sweep(now?: number): number;
}

/** 严格的 base64url：Buffer.from 本身对非法字符很宽容（直接跳过），这里先用正则挡掉。 */
function decodeB64url(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return undefined;
  return Buffer.from(value, 'base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createEnvelopeOpener(deps: {
  keyring: EnvelopeKeyring;
  now?: () => number;
  logger?: Logger;
}): EnvelopeOpener {
  const { keyring, logger } = deps;
  const clock = deps.now ?? Date.now;
  /** 用过的 nonce（规范化成 base64url）→ 这条记录可以忘掉的时刻（iat + ENVELOPE_MAX_AGE_MS）。 */
  const usedNonces = new Map<string, number>();

  function reject(reason: RejectReason, message: string, hint: string): never {
    logger?.warn('envelope rejected', { reason });
    throw new AppError('INVALID_INPUT', message, { hint });
  }

  function parseOuter(text: string): Outer | undefined {
    if (!text.startsWith(ENVELOPE_PREFIX)) return undefined;
    const body = decodeB64url(text.slice(ENVELOPE_PREFIX.length));
    if (body === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      return undefined;
    }
    if (!isRecord(json) || json.v !== 1 || typeof json.kid !== 'string') return undefined;
    const epk = decodeB64url(json.epk);
    const iv = decodeB64url(json.iv);
    const ct = decodeB64url(json.ct);
    const tag = decodeB64url(json.tag);
    if (epk?.length !== 32 || iv?.length !== 12 || ct === undefined || tag?.length !== 16) return undefined;
    return { kid: json.kid, epk, iv, ct, tag };
  }

  function decrypt(outer: Outer): Buffer | undefined {
    try {
      const ephemeral = createPublicKey({
        key: { kty: 'OKP', crv: 'X25519', x: outer.epk.toString('base64url') },
        format: 'jwk',
      });
      const shared = diffieHellman({ privateKey: keyring.privateKey, publicKey: ephemeral });
      const key = Buffer.from(
        hkdfSync('sha256', shared, Buffer.concat([outer.epk, keyring.publicKeyRaw]), HKDF_INFO, 32),
      );
      const decipher = createDecipheriv('aes-256-gcm', key, outer.iv);
      decipher.setAAD(Buffer.from(ENVELOPE_PREFIX + outer.kid, 'utf8'));
      decipher.setAuthTag(outer.tag);
      return Buffer.concat([decipher.update(outer.ct), decipher.final()]);
    } catch {
      return undefined;
    }
  }

  function parsePayload(plain: Buffer): Payload | undefined {
    let json: unknown;
    try {
      json = JSON.parse(plain.toString('utf8'));
    } catch {
      return undefined;
    }
    if (!isRecord(json) || json.v !== 1) return undefined;
    const nonce = decodeB64url(json.nonce);
    if (nonce === undefined || nonce.length < MIN_NONCE_BYTES) return undefined;
    if (typeof json.iat !== 'number' || !Number.isFinite(json.iat)) return undefined;
    if (!isRecord(json.env)) return undefined;
    return { nonce: nonce.toString('base64url'), iat: json.iat, env: json.env };
  }

  return {
    open(text) {
      const outer = typeof text === 'string' ? parseOuter(text.trim()) : undefined;
      if (outer === undefined) reject('malformed', '信封格式不对', FORMAT_HINT);
      if (outer.kid !== keyring.kid) reject('wrong_key', '信封是用另一把公钥加密的', KEY_HINT);

      const plain = decrypt(outer);
      if (plain === undefined) reject('undecryptable', '信封无法解密', KEY_HINT);

      const payload = parsePayload(plain);
      if (payload === undefined) reject('bad_payload', '信封内容不完整', PAYLOAD_HINT);

      const now = clock();
      if (payload.iat < now - ENVELOPE_MAX_AGE_MS || payload.iat > now + ENVELOPE_MAX_FUTURE_SKEW_MS) {
        reject('expired', '信封已过期', REGENERATE_HINT);
      }
      if (usedNonces.has(payload.nonce)) reject('replayed', '这个信封已经用过', REGENERATE_HINT);

      // 先记 nonce 再建账号：账号字段不合法时这个信封同样作废，不能拿同一个信封反复试探。
      usedNonces.set(payload.nonce, payload.iat + ENVELOPE_MAX_AGE_MS);
      return accountFromEnvelopeEnv(payload.env);
    },

    sweep(now = clock()) {
      // 严格小于：在 iat + MAX_AGE 那一刻信封仍在窗口内（区间两端都闭），记录还必须在。
      let removed = 0;
      for (const [nonce, forgetAt] of usedNonces) {
        if (forgetAt < now) {
          usedNonces.delete(nonce);
          removed++;
        }
      }
      return removed;
    },
  };
}
