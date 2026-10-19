#!/usr/bin/env node
// 信封生成器：在 Claude Routine 的云端沙盒里跑一次，把 .env / 环境变量里账号 1 的 iCloud 变量
// 封进一个只有服务端私钥能打开的信封，交给 apple_login({ envelope }) 远程登录。
//
// 用法（仓库根目录，不需要 npm ci，不需要 build）：
//   node scripts/make-envelope.mjs                       # 读当前目录的 .env（若有）+ 进程环境
//   node scripts/make-envelope.mjs --env-file <路径>      # 读指定文件 + 进程环境
//
// 合并规则同 dotenv：进程环境里已有的变量优先于文件。服务端公钥取自 MCP_ENVELOPE_PUBKEY（amp1_…）。
// 只装 12 个白名单变量（ICLOUD_ACCOUNT_1 等），其余一律不进信封。
//
// 绝不打印凭据：stdout 只有一行信封（ame1.…），stderr 只有一行中文失败原因——
// 原因里只出现变量名，永远不出现变量的值（App 专用密码、公钥文本都不例外）。
// 退出码：0 成功；1 任何失败。
//
// Node 怪癖（Node 24 上实测）：node 会扫描整条命令行里的 --env-file，连脚本之后的参数也算。文件存在时它什么也不做，
// 交给本脚本解析；文件不存在时它抢先以退出码 9 报 "<路径>: not found"，本脚本根本没机会运行
// （只报路径，不泄露任何值）。想让这种情况也走本脚本的退出码 1，写成：
//   node scripts/make-envelope.mjs -- --env-file <路径>
//
// 零依赖：只用 node:* 内置模块，不 import 仓库里的任何文件。信封格式与服务端
// （src/auth/）逐字节一致，改这里必须同时改那边。

import {
  createCipheriv,
  createPublicKey,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PUBKEY_PREFIX = 'amp1_';
const ENVELOPE_PREFIX = 'ame1.';
const HKDF_INFO = 'apple-icloud-mcp envelope v1';
const PUBKEY_ERROR = 'MCP_ENVELOPE_PUBKEY 格式不对（应以 amp1_ 开头）';

/** 与服务端 src/core/config.ts::ENVELOPE_ENV_KEYS 完全相同的 12 个变量（测试里对照校验）。 */
const ENVELOPE_ENV_KEYS = [
  'ICLOUD_ACCOUNT_1',
  'ICLOUD_APP_PASSWORD_1',
  'ICLOUD_SENDER_1',
  'ICLOUD_LABEL_1',
  'ALLOW_MAIL_READ_1',
  'ALLOW_MAIL_WRITE_1',
  'ALLOW_CALENDAR_READ_1',
  'ALLOW_CALENDAR_WRITE_1',
  'ALLOW_REMINDERS_READ_1',
  'ALLOW_REMINDERS_WRITE_1',
  'ALLOW_CONTACTS_READ_1',
  'ALLOW_CONTACTS_WRITE_1',
];
const REQUIRED_KEYS = ['ICLOUD_ACCOUNT_1', 'ICLOUD_APP_PASSWORD_1'];
const OTHER_ACCOUNT_KEYS = ['ICLOUD_ACCOUNT_2', 'ICLOUD_ACCOUNT_3', 'ICLOUD_ACCOUNT_4', 'ICLOUD_ACCOUNT_5'];

/** 自己抛出的错误：消息是写好的中文、只含变量名，可以原样打到 stderr。 */
class EnvelopeError extends Error {}

/** 与服务端 core/config.ts::clean 同一条规则：去掉首尾空白，空串视为没设置。 */
function clean(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------- .env 解析 ----------

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 解析一个值：一对 "…" / '…' 会被去掉（其中的 # 保留）；未加引号的值在 " #" 处截断为行内注释，再去首尾空白。 */
function parseValue(raw) {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    // 只有闭合引号之后是空的或是行内注释时才算一对引号；否则按未加引号处理。
    if (close > 0 && /^(\s+#.*)?\s*$/.test(value.slice(close + 1))) return value.slice(1, close);
  }
  const hash = value.indexOf(' #');
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

export function parseDotenv(text) {
  const out = {};
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    out[key] = parseValue(stripped.slice(eq + 1));
  }
  return out;
}

// ---------- 白名单 ----------

export function collectEnvelopeEnv(source) {
  for (const key of REQUIRED_KEYS) {
    if (clean(source[key]) === undefined) throw new EnvelopeError(`缺少环境变量 ${key}`);
  }
  if (OTHER_ACCOUNT_KEYS.some((key) => clean(source[key]) !== undefined)) {
    throw new EnvelopeError('配置了多个账号：信封一次只装一个账号（_1）');
  }
  const env = {};
  for (const key of ENVELOPE_ENV_KEYS) {
    const value = clean(source[key]);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// ---------- 封装 ----------

function parsePublicKey(publicKeyText) {
  if (typeof publicKeyText !== 'string') throw new EnvelopeError(PUBKEY_ERROR);
  const text = publicKeyText.trim();
  if (!text.startsWith(PUBKEY_PREFIX)) throw new EnvelopeError(PUBKEY_ERROR);
  const x = text.slice(PUBKEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) throw new EnvelopeError(PUBKEY_ERROR);
  const raw = Buffer.from(x, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== x) throw new EnvelopeError(PUBKEY_ERROR);
  let key;
  try {
    key = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
  } catch {
    throw new EnvelopeError(PUBKEY_ERROR);
  }
  return { raw, key };
}

export function sealEnvelope(publicKeyText, env, now = Date.now()) {
  const server = parsePublicKey(publicKeyText);
  const kid = createHash('sha256').update(server.raw).digest().subarray(0, 8).toString('base64url');

  const ephemeral = generateKeyPairSync('x25519');
  const epk = ephemeral.publicKey.export({ format: 'jwk' }).x;
  const epkRaw = Buffer.from(epk, 'base64url');

  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: server.key });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epkRaw, server.raw]), HKDF_INFO, 32));

  const payload = { v: 1, nonce: randomBytes(16).toString('base64url'), iat: now, env };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(ENVELOPE_PREFIX + kid, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const outer = {
    v: 1,
    kid,
    epk,
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: tag.toString('base64url'),
  };
  return ENVELOPE_PREFIX + Buffer.from(JSON.stringify(outer), 'utf8').toString('base64url');
}

// ---------- 主流程 ----------

function parseArgs(argv) {
  let envFile;
  // 允许开头一个 `--`（标准的选项结束符）。原因见文件头的 Node 怪癖说明。
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i++) {
    // 不回显参数本身：万一有人把密码当参数传进来，也不能出现在 stderr。
    if (args[i] !== '--env-file' || envFile !== undefined) {
      throw new EnvelopeError('参数不对：只接受 --env-file <路径>');
    }
    const next = args[i + 1];
    if (next === undefined || next === '') throw new EnvelopeError('参数不对：--env-file 后面要跟文件路径');
    envFile = next;
    i++;
  }
  return { envFile };
}

function readEnvFile(path, explicit) {
  try {
    return parseDotenv(readFileSync(path, 'utf8'));
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? `（${err.code}）` : '';
    throw new EnvelopeError(explicit ? `读不了 --env-file 指定的文件 ${path}${code}` : `读不了当前目录下的 .env${code}`);
  }
}

function main() {
  const { envFile } = parseArgs(process.argv.slice(2));
  let fileVars = {};
  if (envFile !== undefined) {
    fileVars = readEnvFile(envFile, true);
  } else {
    const local = join(process.cwd(), '.env');
    if (existsSync(local)) fileVars = readEnvFile(local, false);
  }

  // 同 dotenv：进程环境里已经有的变量（哪怕是空串）不被文件覆盖。
  const merged = { ...fileVars };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }

  const env = collectEnvelopeEnv(merged);
  const publicKeyText = clean(merged.MCP_ENVELOPE_PUBKEY);
  if (publicKeyText === undefined) throw new EnvelopeError('缺少环境变量 MCP_ENVELOPE_PUBKEY');
  return sealEnvelope(publicKeyText, env);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  // 仓库位于符号链接下时，import.meta.url 是解析后的真实路径，而 argv[1] 不是。
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.stdout.write(main() + '\n');
    process.exitCode = 0;
  } catch (err) {
    // 只打印自己写好的中文原因；意料之外的错误只报类型，不报消息——消息里可能带着别的东西。
    const reason =
      err instanceof EnvelopeError ? err.message : `生成信封失败（${(err && (err.code || err.name)) || '未知错误'}）`;
    process.stderr.write(`make-envelope：${reason}\n`);
    process.exitCode = 1;
  }
}
