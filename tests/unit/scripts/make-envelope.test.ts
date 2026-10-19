import { spawnSync } from 'node:child_process';
import { createDecipheriv, createPublicKey, diffieHellman, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kidOf, loadOrCreateEnvelopeKeyring } from '../../../src/auth/keyring.js';
import type { EnvelopeKeyring } from '../../../src/auth/keyring.js';
import { createEnvelopeOpener } from '../../../src/auth/envelope.js';
import { ENVELOPE_ENV_KEYS } from '../../../src/core/config.js';
import type { Logger } from '../../../src/core/logger.js';
import { collectEnvelopeEnv, parseDotenv, sealEnvelope } from '../../../scripts/make-envelope.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'make-envelope.mjs');
// 只用假值：这些测试绝不读仓库里真实的 .env。
const FAKE_PASSWORD = 'fake-pass-wxyz-0000';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

interface Outer {
  v: number;
  kid: string;
  epk: string;
  iv: string;
  ct: string;
  tag: string;
}

function decodeOuter(envelope: string): Outer {
  if (!envelope.startsWith('ame1.')) throw new Error('missing ame1. prefix');
  return JSON.parse(Buffer.from(envelope.slice('ame1.'.length), 'base64url').toString('utf8')) as Outer;
}

function encodeOuter(outer: Outer): string {
  return 'ame1.' + Buffer.from(JSON.stringify(outer), 'utf8').toString('base64url');
}

/** 严格按 Global Constraints 的信封格式解密；不依赖 Task 10 的服务端实现，两边由此交叉验证。 */
function openForTest(envelope: string, privateKey: KeyObject, serverPublicRaw: Buffer): Record<string, unknown> {
  const outer = decodeOuter(envelope);
  if (outer.v !== 1) throw new Error('bad outer version');
  const epkRaw = Buffer.from(outer.epk, 'base64url');
  const epk = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: outer.epk }, format: 'jwk' });
  const shared = diffieHellman({ privateKey, publicKey: epk });
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([epkRaw, serverPublicRaw]), 'apple-icloud-mcp envelope v1', 32),
  );
  const iv = Buffer.from(outer.iv, 'base64url');
  if (iv.length !== 12) throw new Error('iv must be 12 bytes');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from('ame1.' + outer.kid, 'utf8'));
  decipher.setAuthTag(Buffer.from(outer.tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(outer.ct, 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
}

/** 子进程只拿到最小的环境：去掉测试进程自己可能带着的 iCloud/信封变量，免得"进程环境优先"把它们带进来。 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ICLOUD_|ALLOW_|MCP_ENVELOPE_)/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function runScript(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, env, encoding: 'utf8' });
}

describe('parseDotenv', () => {
  it('parseDotenv handles CRLF, quotes, export and comments', () => {
    const parsed = parseDotenv(
      '# c\r\nexport ICLOUD_ACCOUNT_1="a@icloud.com"\r\nICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop  # note\r\n',
    );
    expect(parsed).toEqual({ ICLOUD_ACCOUNT_1: 'a@icloud.com', ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop' });
    for (const v of Object.values(parsed)) expect(v).not.toContain('\r');
  });

  it('strips single quotes, keeps # inside quotes, and skips blank lines', () => {
    const parsed = parseDotenv("\n\nA='x # y'\nB = plain value \nC=\n  # indented comment\nD=a#b\n");
    expect(parsed).toEqual({ A: 'x # y', B: 'plain value', C: '', D: 'a#b' });
  });

  // dotenv 与 Node 的 --env-file 对 `KEY=   # note` 都给空串：等号后面只有注释，就是没写值。
  it('an unquoted value that is only a comment is empty', () => {
    const parsed = parseDotenv('A=   # note\nB=# note\nC=\t# note\n');
    expect(parsed).toEqual({ A: '', B: '', C: '' });
  });

  it('a tab before # starts an inline comment, the same as a space', () => {
    const parsed = parseDotenv('A=value\t# note\nB=value \t # note\n');
    expect(parsed).toEqual({ A: 'value', B: 'value' });
  });
});

describe('collectEnvelopeEnv', () => {
  const base = { ICLOUD_ACCOUNT_1: 'a@icloud.com', ICLOUD_APP_PASSWORD_1: FAKE_PASSWORD };

  it('collectEnvelopeEnv keeps only whitelisted _1 keys', () => {
    const out = collectEnvelopeEnv({
      ...base,
      ICLOUD_SENDER_1: 'b@icloud.com',
      ALLOW_MAIL_WRITE_1: 'true',
      ICLOUD_LABEL_1: '',
      ALLOW_CALENDAR_WRITE_1: undefined,
      MCP_ENVELOPE_PUBKEY: 'amp1_x',
      LOG_LEVEL: 'debug',
      PATH: '/usr/bin',
    });
    expect(out).toEqual({ ...base, ICLOUD_SENDER_1: 'b@icloud.com', ALLOW_MAIL_WRITE_1: 'true' });
  });

  it('whitelist matches the server-side ENVELOPE_ENV_KEYS exactly', () => {
    const all = Object.fromEntries(ENVELOPE_ENV_KEYS.map((k) => [k, `v-${k}`]));
    const out = collectEnvelopeEnv({ ...all, ICLOUD_ACCOUNT_6: 'x', ALLOW_MAIL_READ_2: 'true' });
    expect(Object.keys(out).sort()).toEqual([...ENVELOPE_ENV_KEYS].sort());
    expect(ENVELOPE_ENV_KEYS).toHaveLength(12);
  });

  it('requires account and app password', () => {
    expect(() => collectEnvelopeEnv({ ICLOUD_APP_PASSWORD_1: FAKE_PASSWORD })).toThrow(
      '缺少环境变量 ICLOUD_ACCOUNT_1',
    );
    expect(() => collectEnvelopeEnv({ ICLOUD_ACCOUNT_1: 'a@icloud.com', ICLOUD_APP_PASSWORD_1: '  ' })).toThrow(
      '缺少环境变量 ICLOUD_APP_PASSWORD_1',
    );
  });

  it('collectEnvelopeEnv refuses a second account', () => {
    for (const n of [2, 3, 4, 5]) {
      expect(() => collectEnvelopeEnv({ ...base, [`ICLOUD_ACCOUNT_${n}`]: 'c@icloud.com' })).toThrow(
        '配置了多个账号：信封一次只装一个账号（_1）',
      );
    }
  });
});

describe('sealEnvelope', () => {
  let dir: string;
  let ring: EnvelopeKeyring;
  const env = { ICLOUD_ACCOUNT_1: 'a@icloud.com', ICLOUD_APP_PASSWORD_1: FAKE_PASSWORD };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'make-envelope-'));
    ring = await loadOrCreateEnvelopeKeyring({
      path: join(dir, 'envelope-key.json.enc'),
      encryptionKey: randomBytes(32),
      logger: makeLogger(),
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sealEnvelope output decrypts to the same env with a fresh 16-byte nonce and the given iat', () => {
    const iat = 1_760_000_000_000;
    const a = sealEnvelope(ring.publicKeyText, env, iat);
    const b = sealEnvelope(ring.publicKeyText, env, iat);
    expect(a).toMatch(/^ame1\.[A-Za-z0-9_-]+$/);

    const pa = openForTest(a, ring.privateKey, ring.publicKeyRaw);
    const pb = openForTest(b, ring.privateKey, ring.publicKeyRaw);
    expect(pa).toMatchObject({ v: 1, iat, env });
    expect(Object.keys(pa).sort()).toEqual(['env', 'iat', 'nonce', 'v']);
    expect(Buffer.from(pa.nonce as string, 'base64url').length).toBe(16);
    expect(pa.nonce).not.toBe(pb.nonce);

    const outer = decodeOuter(a);
    expect(Object.keys(outer).sort()).toEqual(['ct', 'epk', 'iv', 'kid', 'tag', 'v']);
    expect(Buffer.from(outer.epk, 'base64url').length).toBe(32);
    expect(Buffer.from(outer.tag, 'base64url').length).toBe(16);
    // 每次一把新的临时密钥。
    expect(outer.epk).not.toBe(decodeOuter(b).epk);
  });

  it('defaults iat to now', () => {
    const before = Date.now();
    const payload = openForTest(sealEnvelope(ring.publicKeyText, env), ring.privateKey, ring.publicKeyRaw);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(Date.now());
  });

  it('sealEnvelope binds the kid', () => {
    const envelope = sealEnvelope(ring.publicKeyText, env);
    const outer = decodeOuter(envelope);
    expect(outer.kid).toBe(kidOf(ring.publicKeyRaw));
    expect(outer.kid).toBe(ring.kid);

    const tampered = encodeOuter({ ...outer, kid: kidOf(randomBytes(32)) });
    expect(() => openForTest(tampered, ring.privateKey, ring.publicKeyRaw)).toThrow();
  });

  it('rejects a malformed public key without echoing it', () => {
    for (const bad of ['', 'amp1_', 'amp2_' + ring.publicKeyText.slice(5), ring.publicKeyText.slice(5), 'amp1_!!!']) {
      expect(() => sealEnvelope(bad, env)).toThrow('MCP_ENVELOPE_PUBKEY 格式不对（应以 amp1_ 开头）');
    }
  });
});

describe('make-envelope as a child process', () => {
  let dir: string;
  let envFile: string;
  let ring: EnvelopeKeyring;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'make-envelope-cli-'));
    envFile = join(dir, 'routine.env');
    ring = await loadOrCreateEnvelopeKeyring({
      path: join(dir, 'envelope-key.json.enc'),
      encryptionKey: randomBytes(32),
      logger: makeLogger(),
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeEnv(lines: string[]): Promise<void> {
    await writeFile(envFile, lines.join('\r\n') + '\r\n', 'utf8');
  }

  it('the script as a child process prints exactly one envelope line and nothing else', async () => {
    await writeEnv([
      `MCP_ENVELOPE_PUBKEY=${ring.publicKeyText}`,
      'ICLOUD_ACCOUNT_1=a@icloud.com',
      `ICLOUD_APP_PASSWORD_1=${FAKE_PASSWORD}`,
      'ALLOW_MAIL_WRITE_1=true',
    ]);
    const r = runScript(['--env-file', envFile], childEnv());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ame1\.[A-Za-z0-9_-]+\n$/);

    const payload = openForTest(r.stdout.trimEnd(), ring.privateKey, ring.publicKeyRaw);
    expect(payload.env).toEqual({
      ICLOUD_ACCOUNT_1: 'a@icloud.com',
      ICLOUD_APP_PASSWORD_1: FAKE_PASSWORD,
      ALLOW_MAIL_WRITE_1: 'true',
    });
  });

  // 上面那条用测试自己写的 openForTest 拆，envelope.test.ts 用 import 进来的 sealEnvelope 封；
  // 这条把两端真正的样子接在一起：真的脚本作为子进程跑（参数解析、.env 读取、stdout 那一行），
  // 输出原样交给服务端真正的 createEnvelopeOpener，账号要原样回来。
  it('what the script prints opens with the real server-side opener', async () => {
    await writeEnv([
      `MCP_ENVELOPE_PUBKEY=${ring.publicKeyText}`,
      'ICLOUD_ACCOUNT_1=a@icloud.com',
      `ICLOUD_APP_PASSWORD_1=${FAKE_PASSWORD}`,
      'ICLOUD_LABEL_1=routine',
      'ALLOW_CALENDAR_WRITE_1=true',
    ]);
    const r = runScript(['--env-file', envFile], childEnv());
    expect(r.status, r.stderr).toBe(0);

    const opener = createEnvelopeOpener({ keyring: ring, logger: makeLogger() });
    const { account, notices } = opener.open(r.stdout);
    expect(account).toMatchObject({
      email: 'a@icloud.com',
      sender: 'a@icloud.com',
      label: 'routine',
      appPassword: FAKE_PASSWORD,
      origin: 'envelope',
    });
    expect(account.capabilities).toMatchObject({ calendarWrite: true, mailWrite: false });
    expect(notices).toEqual([]);
  });

  it('the script never echoes the password, on success or failure', async () => {
    await writeEnv([
      `MCP_ENVELOPE_PUBKEY=${ring.publicKeyText}`,
      'ICLOUD_ACCOUNT_1=a@icloud.com',
      `ICLOUD_APP_PASSWORD_1=${FAKE_PASSWORD}`,
    ]);
    const ok = runScript(['--env-file', envFile], childEnv());
    expect(ok.status).toBe(0);
    expect(ok.stdout).not.toContain(FAKE_PASSWORD);
    expect(ok.stderr).not.toContain(FAKE_PASSWORD);

    await writeEnv(['ICLOUD_ACCOUNT_1=a@icloud.com', `ICLOUD_APP_PASSWORD_1=${FAKE_PASSWORD}`]);
    const missing = runScript(['--env-file', envFile], childEnv());
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('MCP_ENVELOPE_PUBKEY');
    expect(missing.stderr).not.toContain(FAKE_PASSWORD);
    expect(missing.stderr.trimEnd().split('\n')).toHaveLength(1);
  });

  it('reports a malformed public key without printing its value', async () => {
    const badKey = 'not-a-key-SENTINEL';
    await writeEnv([
      `MCP_ENVELOPE_PUBKEY=${badKey}`,
      'ICLOUD_ACCOUNT_1=a@icloud.com',
      `ICLOUD_APP_PASSWORD_1=${FAKE_PASSWORD}`,
    ]);
    const r = runScript(['--env-file', envFile], childEnv());
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('MCP_ENVELOPE_PUBKEY 格式不对（应以 amp1_ 开头）');
    expect(r.stderr).not.toContain('SENTINEL');
    expect(r.stderr).not.toContain(FAKE_PASSWORD);
  });

  it('fails with exit 1 on a second account, a missing file, or an unknown argument', async () => {
    await writeEnv([
      `MCP_ENVELOPE_PUBKEY=${ring.publicKeyText}`,
      'ICLOUD_ACCOUNT_1=a@icloud.com',
      `ICLOUD_APP_PASSWORD_1=${FAKE_PASSWORD}`,
      'ICLOUD_ACCOUNT_2=c@icloud.com',
    ]);
    const multi = runScript(['--env-file', envFile], childEnv());
    expect(multi.status).toBe(1);
    expect(multi.stderr).toContain('配置了多个账号');
    expect(multi.stdout).toBe('');

    // 不带 `--` 时，有的 Node 版本会自己扫到脚本之后的 --env-file，文件不存在就抢先以 9 退出。
    // 那条路不归脚本管，这里只要求它失败、stdout 为空、不泄露密码。
    const missing = join(dir, 'does-not-exist.env');
    const noFile = runScript(['--env-file', missing], childEnv());
    expect(noFile.status).not.toBe(0);
    expect(noFile.stdout).toBe('');
    expect(noFile.stderr).not.toContain(FAKE_PASSWORD);

    // 带 `--` 时一定轮到脚本自己报错：退出码 1、中文原因。
    const noFileOwn = runScript(['--', '--env-file', missing], childEnv());
    expect(noFileOwn.status).toBe(1);
    expect(noFileOwn.stdout).toBe('');
    expect(noFileOwn.stderr).toContain('读不了 --env-file 指定的文件');

    const separated = runScript(['--', '--env-file', envFile], childEnv());
    expect(separated.status).toBe(1);
    expect(separated.stderr).toContain('配置了多个账号');

    const unknown = runScript(['--env-file', envFile, '--verbose'], childEnv());
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe('');

    const dangling = runScript(['--env-file'], childEnv());
    expect(dangling.status).toBe(1);
    expect(dangling.stdout).toBe('');
  });

  it('process env wins over the file', async () => {
    await writeEnv([
      `MCP_ENVELOPE_PUBKEY=${ring.publicKeyText}`,
      'ICLOUD_ACCOUNT_1=file@icloud.com',
      `ICLOUD_APP_PASSWORD_1=${FAKE_PASSWORD}`,
    ]);
    const r = runScript(['--env-file', envFile], childEnv({ ICLOUD_ACCOUNT_1: 'proc@icloud.com' }));
    expect(r.status).toBe(0);
    const payload = openForTest(r.stdout.trimEnd(), ring.privateKey, ring.publicKeyRaw);
    expect((payload.env as Record<string, string>).ICLOUD_ACCOUNT_1).toBe('proc@icloud.com');
    expect((payload.env as Record<string, string>).ICLOUD_APP_PASSWORD_1).toBe(FAKE_PASSWORD);
  });

  it('reads the public key from the process env when the file lacks it', async () => {
    await writeEnv(['ICLOUD_ACCOUNT_1=a@icloud.com', `ICLOUD_APP_PASSWORD_1=${FAKE_PASSWORD}`]);
    const r = runScript(['--env-file', envFile], childEnv({ MCP_ENVELOPE_PUBKEY: ring.publicKeyText }));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(openForTest(r.stdout.trimEnd(), ring.privateKey, ring.publicKeyRaw).env).toMatchObject({
      ICLOUD_ACCOUNT_1: 'a@icloud.com',
    });
  });

  it('falls back to .env in the working directory when no --env-file is given', async () => {
    // cwd 是临时目录，不是仓库根，所以绝不会读到仓库里真实的 .env。
    await writeFile(
      join(dir, '.env'),
      [`MCP_ENVELOPE_PUBKEY=${ring.publicKeyText}`, 'ICLOUD_ACCOUNT_1=cwd@icloud.com', `ICLOUD_APP_PASSWORD_1=${FAKE_PASSWORD}`].join(
        '\n',
      ),
      'utf8',
    );
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, env: childEnv(), encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(openForTest(r.stdout.trimEnd(), ring.privateKey, ring.publicKeyRaw).env).toMatchObject({
      ICLOUD_ACCOUNT_1: 'cwd@icloud.com',
    });
  });
});
