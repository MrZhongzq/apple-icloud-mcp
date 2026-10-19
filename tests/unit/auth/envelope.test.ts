import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateEnvelopeKeyring, type EnvelopeKeyring } from '../../../src/auth/keyring.js';
import {
  createEnvelopeOpener,
  ENVELOPE_MAX_AGE_MS,
  ENVELOPE_MAX_FUTURE_SKEW_MS,
} from '../../../src/auth/envelope.js';
import { AppError } from '../../../src/core/errors.js';
import type { Logger } from '../../../src/core/logger.js';
// 交叉验证：信封由仓库里真正发给使用者的脚本封装，服务端用自己的代码拆开。两边任何一个字节对不上，这里就红。
import { sealEnvelope } from '../../../scripts/make-envelope.mjs';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const PASSWORD = 'abcd-efgh-ijkl-mnop';
const ENV = { ICLOUD_ACCOUNT_1: 'friend@icloud.com', ICLOUD_APP_PASSWORD_1: PASSWORD };

/** 断言抛出的是 INVALID_INPUT，且消息正好是给定的那句；返回错误以便继续看 hint。 */
function expectRejected(fn: () => unknown, message: string): AppError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `应当被拒：${message}`).toBeInstanceOf(AppError);
  const err = caught as AppError;
  expect(err.code).toBe('INVALID_INPUT');
  expect(err.message).toBe(message);
  return err;
}

describe('envelope opener', () => {
  let dir: string;
  let keyring: EnvelopeKeyring;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'envelope-'));
    keyring = await loadOrCreateEnvelopeKeyring({
      path: join(dir, 'envelope-key.json.enc'),
      encryptionKey: randomBytes(32),
      logger: makeLogger(),
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports the time window constants', () => {
    expect(ENVELOPE_MAX_AGE_MS).toBe(300_000);
    expect(ENVELOPE_MAX_FUTURE_SKEW_MS).toBe(60_000);
  });

  it('opens what the script sealed and builds the account through parseAccount', () => {
    const opener = createEnvelopeOpener({ keyring });
    const { account, notices } = opener.open(sealEnvelope(keyring.publicKeyText, ENV));
    expect(account.origin).toBe('envelope');
    expect(account.email).toBe('friend@icloud.com');
    expect(account.appPassword).toBe(PASSWORD);
    expect(account.capabilities.mailWrite, '写权限默认关闭，信封里也一样').toBe(false);
    expect(notices).toEqual([]);
  });

  it('accepts surrounding whitespace and a trailing newline', () => {
    const opener = createEnvelopeOpener({ keyring });
    const env = sealEnvelope(keyring.publicKeyText, ENV);
    expect(opener.open('  ' + env + '\n').account.appPassword).toBe(PASSWORD);
  });

  it('a quoted envelope is a format error, not INTERNAL', () => {
    const opener = createEnvelopeOpener({ keyring });
    const env = sealEnvelope(keyring.publicKeyText, ENV);
    const err = expectRejected(() => opener.open('"' + env + '"'), '信封格式不对');
    expect(err.hint).toBe('把 make-envelope.mjs 输出的那一整行原样传入，不要加引号或改动');
  });

  it('garbage after the prefix is a format error too', () => {
    const opener = createEnvelopeOpener({ keyring });
    expectRejected(() => opener.open('ame1.'), '信封格式不对');
    expectRejected(() => opener.open('ame1.!!!!'), '信封格式不对');
    expectRejected(() => opener.open('ame1.' + Buffer.from('{"v":2}').toString('base64url')), '信封格式不对');
  });

  it('a tampered ciphertext cannot be decrypted', () => {
    const opener = createEnvelopeOpener({ keyring });
    const env = sealEnvelope(keyring.publicKeyText, ENV);
    const outer = JSON.parse(Buffer.from(env.slice('ame1.'.length), 'base64url').toString('utf8')) as {
      ct: string;
    };
    const ct = Buffer.from(outer.ct, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 1;
    outer.ct = ct.toString('base64url');
    const tampered = 'ame1.' + Buffer.from(JSON.stringify(outer)).toString('base64url');
    const err = expectRejected(() => opener.open(tampered), '信封无法解密');
    expect(err.hint).toBe('向服务器主人要当前的公钥，更新 MCP_ENVELOPE_PUBKEY 后重新生成信封');
  });

  it('the same envelope is refused the second time', () => {
    const opener = createEnvelopeOpener({ keyring });
    const env = sealEnvelope(keyring.publicKeyText, ENV);
    opener.open(env);
    const err = expectRejected(() => opener.open(env), '这个信封已经用过');
    expect(err.hint).toBe('重新运行 node scripts/make-envelope.mjs 生成新信封后再试一次');
  });

  it('iat 5 minutes + 1 ms old is refused; 1 minute ahead is accepted; 1 minute + 1 ms ahead is refused', () => {
    const t = 1_800_000_000_000;
    const opener = createEnvelopeOpener({ keyring, now: () => t });

    const tooOld = sealEnvelope(keyring.publicKeyText, ENV, t - ENVELOPE_MAX_AGE_MS - 1);
    const err = expectRejected(() => opener.open(tooOld), '信封已过期');
    expect(err.hint).toBe('重新运行 node scripts/make-envelope.mjs 生成新信封后再试一次');

    expect(opener.open(sealEnvelope(keyring.publicKeyText, ENV, t - ENVELOPE_MAX_AGE_MS)).account.origin).toBe(
      'envelope',
    );
    expect(opener.open(sealEnvelope(keyring.publicKeyText, ENV, t + 60_000)).account.origin).toBe('envelope');
    expectRejected(() => opener.open(sealEnvelope(keyring.publicKeyText, ENV, t + 60_001)), '信封已过期');
  });

  it('an envelope sealed for another key pair reports the key mismatch', async () => {
    const other = await loadOrCreateEnvelopeKeyring({
      path: join(dir, 'other-key.json.enc'),
      encryptionKey: randomBytes(32),
      logger: makeLogger(),
    });
    const opener = createEnvelopeOpener({ keyring });
    const err = expectRejected(() => opener.open(sealEnvelope(other.publicKeyText, ENV)), '信封是用另一把公钥加密的');
    expect(err.hint).toBe('向服务器主人要当前的公钥，更新 MCP_ENVELOPE_PUBKEY 后重新生成信封');
  });

  it('sweep forgets nonces only after their window has passed', () => {
    const iat = 1_800_000_000_000;
    let t = iat;
    const opener = createEnvelopeOpener({ keyring, now: () => t });
    const env = sealEnvelope(keyring.publicKeyText, ENV, iat);
    opener.open(env);

    t = iat + 299_999;
    expect(opener.sweep(t), '窗口还没过，一条也不能忘').toBe(0);
    expectRejected(() => opener.open(env), '这个信封已经用过');

    t = iat + 300_001;
    expect(opener.sweep(t)).toBe(1);
    // 记录已经忘了，可信封本身也过期了：拒绝理由必须换成"过期"，而不是"用过"，更不能被接受。
    expectRejected(() => opener.open(env), '信封已过期');
  });

  it('a Gmail Apple ID in the envelope comes back with mail disabled and a notice', () => {
    const opener = createEnvelopeOpener({ keyring });
    const { account, notices } = opener.open(
      sealEnvelope(keyring.publicKeyText, { ICLOUD_ACCOUNT_1: 'friend@gmail.com', ICLOUD_APP_PASSWORD_1: PASSWORD }),
    );
    expect(account.capabilities.mailRead).toBe(false);
    expect(account.capabilities.mailWrite).toBe(false);
    expect(account.capabilities.calendarRead).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('friend@gmail.com');
  });

  it('logs only the rejection category, never the envelope or its payload', () => {
    const logger = makeLogger();
    const opener = createEnvelopeOpener({ keyring, logger });
    const env = sealEnvelope(keyring.publicKeyText, ENV);
    opener.open(env);
    expectRejected(() => opener.open(env), '这个信封已经用过');
    expectRejected(() => opener.open('"' + env + '"'), '信封格式不对');

    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn.mock.calls).toEqual([
      ['envelope rejected', { reason: 'replayed' }],
      ['envelope rejected', { reason: 'malformed' }],
    ]);
    const everything = JSON.stringify([
      (logger.debug as unknown as ReturnType<typeof vi.fn>).mock.calls,
      (logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls,
      warn.mock.calls,
      (logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(env.slice(5, 40));
  });
});
