#!/usr/bin/env node
// 云端沙盒网络探针：在 Claude Routine / Claude Code 云环境里跑一次，回答「这个沙盒能不能连上 iCloud、走哪条路」。
//
// 用法（仓库根目录，不需要 npm ci，不需要 build）：
//   node scripts/probe-network.mjs
//
// 它只做连通性与协议握手——IMAP 问候、SMTP EHLO/STARTTLS、CalDAV/CardDAV 未认证的 PROPFIND——
// 不登录、不发信、不读取任何 iCloud 凭据的值。ICLOUD_* 变量只报告「设没设」。
// 代理变量的 URL 里可能带令牌，所以任何输出里都只出现 scheme://host:port。
//
// 测的是三条路，对应 CLI 可能的三种改法：
//   直连            —— 现有代码不改就能用
//   经代理 CONNECT  —— 需要给 imapflow / nodemailer 接上 proxy 选项
//   fetch           —— CalDAV/CardDAV 今天走的就是原生 fetch；再测一遍带 NODE_USE_ENV_PROXY=1 的
// 退出码恒为 0（探针本身崩溃除外）：它是诊断工具，结论在输出里，不在退出码里。

import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;
const TIMEOUT_MS = 10_000;

const TARGETS = [
  { name: 'imap', host: 'imap.mail.me.com', port: 993, kind: 'imap-tls' },
  { name: 'smtp', host: 'smtp.mail.me.com', port: 587, kind: 'smtp-starttls' },
  { name: 'caldav', host: 'caldav.icloud.com', port: 443, kind: 'https', method: 'PROPFIND', path: '/' },
  { name: 'carddav', host: 'contacts.icloud.com', port: 443, kind: 'https', method: 'PROPFIND', path: '/' },
  // 对照组：默认白名单里一定有 npm。它若也不通，说明是探针的连法不适用这个环境，上面的 iCloud 结论不可信。
  { name: 'npm', host: 'registry.npmjs.org', port: 443, kind: 'https', method: 'GET', path: '/-/ping' },
];

class ProbeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---------- 环境 ----------

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function readProxy() {
  const raw = pickEnv('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { unusable: '代理变量不是合法 URL（值不打印）' };
  }
  const hasAuth = Boolean(u.username || u.password);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const display = `${u.protocol}//${u.hostname}:${port}${hasAuth ? '（带认证信息，已隐去）' : ''}`;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { display, unusable: `代理协议是 ${u.protocol}，本探针只会 HTTP CONNECT` };
  }
  return {
    protocol: u.protocol,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port,
    display,
    auth: hasAuth
      ? Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
      : undefined,
  };
}

const ICLOUD_MAIL_DOMAINS = new Set(['icloud.com', 'me.com', 'mac.com', 'icloud.com.cn']);

function credentialReport() {
  const state = (n) => (pickEnv(n) ? '已设置' : '未设置');
  const parts = ['ICLOUD_ACCOUNT_1', 'ICLOUD_APP_PASSWORD_1', 'ICLOUD_SENDER_1'].map((n) => `${n} ${state(n)}`);
  // 与 core/config.ts 同一条规则：邮件用 sender 登录，sender 缺省回落到 email，域名须精确匹配。只报是否，不报值。
  const sender = pickEnv('ICLOUD_SENDER_1') ?? pickEnv('ICLOUD_ACCOUNT_1');
  if (sender) {
    const domain = sender.slice(sender.lastIndexOf('@') + 1).toLowerCase();
    parts.push(
      ICLOUD_MAIL_DOMAINS.has(domain)
        ? '邮件登录名是 iCloud 域名'
        : '邮件登录名不是 iCloud 域名（邮件工具会被自动禁用，需设置 ICLOUD_SENDER_1）',
    );
  }
  return parts.join(' · ');
}

// ---------- 套接字读取 ----------

/** 在一个套接字上按需等待「够用的一段数据」，并把多余的字节留给下一次等待。 */
class Reader {
  constructor(socket, initial = '') {
    this.socket = socket;
    this.buf = initial;
    this.waiter = null;
    this.failure = null;
    this.onData = (chunk) => {
      this.buf += chunk.toString('latin1');
      this.check();
    };
    this.onError = (err) => this.fail(err);
    this.onClose = () => this.fail(new ProbeError(`对端关闭了连接（已收到：${preview(this.buf) || '无'}）`, 'closed'));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  until(test) {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.waiter = { test, resolve, reject };
      this.check();
    });
  }

  check() {
    if (!this.waiter) return;
    const r = this.waiter.test(this.buf);
    if (!r) return;
    const w = this.waiter;
    this.waiter = null;
    this.buf = this.buf.slice(r.consumed);
    w.resolve(r.value);
  }

  fail(err) {
    this.failure ??= err;
    if (!this.waiter) return;
    const w = this.waiter;
    this.waiter = null;
    w.reject(err);
  }

  /** TLS 升级前必须摘掉监听，否则握手字节会被这里吃掉。返回尚未消费的字节。 */
  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    return this.buf;
  }
}

function stripCR(line) {
  return line.endsWith(CR) ? line.slice(0, -1) : line;
}

function firstLine(buf) {
  const i = buf.indexOf(LF);
  if (i < 0) return undefined;
  return { value: stripCR(buf.slice(0, i)), consumed: i + 1 };
}

function httpHead(buf) {
  const i = buf.indexOf(CRLF + CRLF);
  if (i < 0) return undefined;
  return { value: buf.slice(0, i), consumed: i + 4 };
}

/** SMTP 回复可能是多行（250-xxx … 250 xxx），以「三位数字 + 空格」的那一行结束。 */
function smtpReply(buf) {
  const lines = [];
  let pos = 0;
  for (;;) {
    const i = buf.indexOf(LF, pos);
    if (i < 0) return undefined;
    const line = stripCR(buf.slice(pos, i));
    lines.push(line);
    pos = i + 1;
    if (/^\d{3}( |$)/.test(line)) return { value: { code: Number(line.slice(0, 3)), lines }, consumed: pos };
  }
}

function preview(s, max = 70) {
  const flat = s.replace(/[\r\n]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------- 建连 ----------

async function connectTcp(ctx, host, port) {
  const s = ctx.track(net.connect({ host, port }));
  await once(s, 'connect');
  return s;
}

/** 返回一条到 target 的原始字节通道：直连，或经代理 CONNECT 隧道。rest 是隧道建立时顺带收到的字节。 */
async function openRaw(ctx, target, via, proxy) {
  if (via === 'direct') return { socket: await connectTcp(ctx, target.host, target.port), rest: '' };

  let s = await connectTcp(ctx, proxy.host, proxy.port);
  if (proxy.protocol === 'https:') {
    s = ctx.track(tls.connect({ socket: s, servername: proxy.host }));
    await once(s, 'secureConnect');
  }
  const reader = new Reader(s);
  const head = reader.until(httpHead);
  const authority = `${target.host}:${target.port}`;
  s.write(
    `CONNECT ${authority} HTTP/1.1${CRLF}Host: ${authority}${CRLF}` +
      (proxy.auth ? `Proxy-Authorization: Basic ${proxy.auth}${CRLF}` : '') +
      CRLF,
  );
  const response = await head;
  const statusLine = stripCR(response.split(LF)[0] ?? '');
  const status = Number(statusLine.split(' ')[1]);
  if (status !== 200) throw new ProbeError(`代理拒绝了 CONNECT：${preview(statusLine)}`, `proxy-${status || '?'}`);
  return { socket: s, rest: reader.detach() };
}

async function upgradeTls(ctx, socket, servername, alpn) {
  const t = ctx.track(tls.connect({ socket, servername, ...(alpn ? { ALPNProtocols: alpn } : {}) }));
  await once(t, 'secureConnect');
  const cert = t.getPeerCertificate();
  const issuer = cert?.issuer?.O ?? cert?.issuer?.CN ?? '未知';
  return { tls: t, cert: `证书签发者 ${issuer}` };
}

// ---------- 三种协议的握手 ----------

async function probeImap(ctx, target, raw) {
  const { tls: t, cert } = await upgradeTls(ctx, raw.socket, target.host);
  const r = new Reader(t);
  const greeting = await r.until(firstLine);
  t.write(`a1 LOGOUT${CRLF}`);
  return { ok: greeting.startsWith('* OK'), detail: `${cert} · 问候：${preview(greeting)}` };
}

async function probeSmtp(ctx, target, raw) {
  const r = new Reader(raw.socket, raw.rest);
  const hello = await r.until(smtpReply);
  if (hello.code !== 220) return { ok: false, detail: `问候不是 220：${preview(hello.lines.join(' '))}` };

  let reply = r.until(smtpReply);
  raw.socket.write(`EHLO probe.invalid${CRLF}`);
  const ehlo = await reply;
  if (!ehlo.lines.some((l) => /STARTTLS/i.test(l))) return { ok: false, detail: 'EHLO 回复里没有 STARTTLS' };

  reply = r.until(smtpReply);
  raw.socket.write(`STARTTLS${CRLF}`);
  const ready = await reply;
  if (ready.code !== 220) return { ok: false, detail: `STARTTLS 被拒：${preview(ready.lines.join(' '))}` };
  r.detach();

  const { tls: t, cert } = await upgradeTls(ctx, raw.socket, target.host);
  const r2 = new Reader(t);
  reply = r2.until(smtpReply);
  t.write(`EHLO probe.invalid${CRLF}`);
  const ehlo2 = await reply;
  t.write(`QUIT${CRLF}`);
  return { ok: ehlo2.code === 250, detail: `${cert} · STARTTLS 后 EHLO ${ehlo2.code}` };
}

async function probeHttps(ctx, target, raw) {
  const { tls: t, cert } = await upgradeTls(ctx, raw.socket, target.host, ['http/1.1']);
  const r = new Reader(t);
  const status = r.until(firstLine);
  t.write(
    `${target.method} ${target.path} HTTP/1.1${CRLF}Host: ${target.host}${CRLF}` +
      `Depth: 0${CRLF}Content-Length: 0${CRLF}User-Agent: apple-icloud-mcp-probe${CRLF}Connection: close${CRLF}${CRLF}`,
  );
  const line = await status;
  const code = Number(line.split(' ')[1]);
  // 未带凭据，iCloud 回 401 是预期——要证明的只是「服务器那头真的是它、并且答话了」。
  return { ok: code > 0 && code < 500, detail: `${cert} · ${preview(line)}` };
}

const HANDSHAKES = { 'imap-tls': probeImap, 'smtp-starttls': probeSmtp, https: probeHttps };

// ---------- 执行与超时 ----------

function explain(err) {
  const code = err?.code ?? '';
  const msg = err?.message ?? String(err);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `DNS 解析不了（${code}）`;
  if (code === 'ECONNREFUSED') return '连接被拒（ECONNREFUSED）';
  if (code === 'ECONNRESET') return '连接被重置（ECONNRESET）';
  if (code === 'ETIMEDOUT' || code === 'timeout') return '超时（多半是出网被静默丢包）';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return `网络不可达（${code}）`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_|DEPTH_ZERO/.test(code)) return `TLS 证书不受信任（${code}）——中间有东西在改写 TLS，可能需要 NODE_EXTRA_CA_CERTS`;
  if (code === 'proxy-403') return `${msg}（多半是不在域名白名单里，或代理不放行这个端口）`;
  if (code === 'proxy-407') return `${msg}（代理要求认证）`;
  return code ? `${msg}（${code}）` : msg;
}

async function withDeadline(fn) {
  const sockets = [];
  // 每个套接字挂一个空的 error 监听：读取器摘掉监听、TLS 接管之前的空档里，一个迟到的 ECONNRESET
  // 不该把整个探针进程打崩。真正的错误仍由 once()/Reader 各自的监听接住。
  const ctx = { track: (s) => (sockets.push(s), s.on('error', () => {}), s) };
  let timer;
  try {
    return await Promise.race([
      fn(ctx),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProbeError(`${TIMEOUT_MS / 1000} 秒内没有完成`, 'timeout')), TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    return { ok: false, detail: explain(err), code: err?.code };
  } finally {
    clearTimeout(timer);
    for (const s of sockets) s.destroy();
  }
}

function probeRaw(target, via, proxy) {
  return withDeadline(async (ctx) => {
    const raw = await openRaw(ctx, target, via, proxy);
    return HANDSHAKES[target.kind](ctx, target, raw);
  });
}

async function probeDns(host) {
  try {
    const addrs = await dns.lookup(host, { all: true });
    return { ok: true, detail: addrs.map((a) => a.address).slice(0, 3).join(', ') };
  } catch (err) {
    return { ok: false, detail: explain(err) };
  }
}

async function fetchProbe(target) {
  try {
    const res = await fetch(`https://${target.host}${target.path}`, {
      method: target.method,
      headers: { Depth: '0', 'User-Agent': 'apple-icloud-mcp-probe' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: res.status < 500, detail: `HTTP ${res.status}` };
  } catch (err) {
    const cause = err?.cause;
    return { ok: false, detail: explain(cause?.code ? cause : err) };
  }
}

const HTTPS_TARGETS = TARGETS.filter((t) => t.kind === 'https');

/** 子进程里带 NODE_USE_ENV_PROXY=1 再跑一遍 fetch：这个开关只在进程启动时读，同进程里测不出来。 */
function fetchWithEnvProxy() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fetch-only'], {
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS * 2 + 5000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split(LF).pop() ?? ''));
      } catch {
        resolve(Object.fromEntries(HTTPS_TARGETS.map((t) => [t.name, { ok: false, detail: '子进程没有给出结果' }])));
      }
    });
  });
}

// ---------- 主流程 ----------

if (process.argv.includes('--fetch-only')) {
  const results = await Promise.all(HTTPS_TARGETS.map(fetchProbe));
  process.stdout.write(JSON.stringify(Object.fromEntries(HTTPS_TARGETS.map((t, i) => [t.name, results[i]]))) + LF);
  process.exit(0);
}

const proxy = readProxy();
const proxyUsable = proxy && !proxy.unusable;

console.log('== apple-icloud-mcp 网络探针 ==');
console.log(`Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`代理：${proxy ? (proxy.display ?? '') + (proxy.unusable ? `（${proxy.unusable}）` : '') : '未设置'}`);
const noProxy = pickEnv('NO_PROXY', 'no_proxy');
console.log(`NO_PROXY：${noProxy ? preview(noProxy, 200) : '未设置'}`);
console.log(`NODE_EXTRA_CA_CERTS：${pickEnv('NODE_EXTRA_CA_CERTS') ? '已设置' : '未设置'}`);
console.log(`凭据变量：${credentialReport()}`);

const dnsResults = await Promise.all(TARGETS.map((t) => probeDns(t.host)));
const rawJobs = [];
for (const t of TARGETS) {
  rawJobs.push(probeRaw(t, 'direct'));
  rawJobs.push(proxyUsable ? probeRaw(t, 'proxy', proxy) : Promise.resolve({ ok: false, detail: '未设置可用的 HTTP(S) 代理，跳过', skipped: true }));
}
const [rawResults, fetchPlain, fetchEnv] = await Promise.all([
  Promise.all(rawJobs),
  Promise.all(HTTPS_TARGETS.map(fetchProbe)),
  fetchWithEnvProxy(),
]);

const mark = (r) => (r.skipped ? '[跳过]' : r.ok ? '[通]  ' : '[不通]');
const row = (name, via, endpoint, r) => console.log(`${mark(r)} ${name.padEnd(8)} ${via.padEnd(10)} ${endpoint.padEnd(26)} ${r.detail}`);

const results = { dns: {}, direct: {}, proxy: {}, fetch: {}, fetchEnvProxy: {} };

console.log('');
console.log('-- DNS（沙盒本地能否解析）--');
TARGETS.forEach((t, i) => {
  results.dns[t.name] = dnsResults[i];
  row(t.name, '解析', t.host, dnsResults[i]);
});

console.log('');
console.log('-- 原始连接 + 协议握手 --');
TARGETS.forEach((t, i) => {
  const endpoint = `${t.host}:${t.port}`;
  results.direct[t.name] = rawResults[i * 2];
  results.proxy[t.name] = rawResults[i * 2 + 1];
  row(t.name, '直连', endpoint, rawResults[i * 2]);
  row(t.name, '经代理', endpoint, rawResults[i * 2 + 1]);
});

console.log('');
console.log('-- 原生 fetch（CalDAV/CardDAV 今天走的路）--');
HTTPS_TARGETS.forEach((t, i) => {
  results.fetch[t.name] = fetchPlain[i];
  results.fetchEnvProxy[t.name] = fetchEnv[t.name] ?? { ok: false, detail: '无结果' };
  row(t.name, '默认', t.host, fetchPlain[i]);
  row(t.name, 'ENV_PROXY', t.host, results.fetchEnvProxy[t.name]);
});

// ---------- 结论 ----------

const ok = (bucket, name) => Boolean(results[bucket][name]?.ok);
const verdict = [];

if (!ok('direct', 'npm') && !ok('proxy', 'npm') && !ok('fetch', 'npm') && !ok('fetchEnvProxy', 'npm')) {
  verdict.push('对照组 npm 四条路全不通——这个环境的出网方式本探针没有覆盖到，下面关于 iCloud 的结论不可信，把整份输出贴回来。');
}

if (ok('direct', 'imap') && ok('direct', 'smtp')) {
  verdict.push('邮件：直连可用——现有代码不用改。');
} else if (ok('proxy', 'imap') && ok('proxy', 'smtp')) {
  verdict.push('邮件：只能经代理 CONNECT——需要给 imapflow / nodemailer 接上 proxy 选项（provider 层的小改动）。');
} else if ((ok('direct', 'imap') || ok('proxy', 'imap')) !== (ok('direct', 'smtp') || ok('proxy', 'smtp'))) {
  verdict.push(`邮件：只通了一半（IMAP ${ok('direct', 'imap') || ok('proxy', 'imap') ? '通' : '不通'}，SMTP ${ok('direct', 'smtp') || ok('proxy', 'smtp') ? '通' : '不通'}）——读信和发信要分开看。`);
} else {
  verdict.push('邮件：直连和代理都不通——这个环境里用不了邮件工具；邮件只能走远程 HTTP 连接器或自托管环境。');
}

const dav = ['caldav', 'carddav'];
if (dav.every((n) => ok('fetch', n))) {
  verdict.push('日历/提醒/通讯录：原生 fetch 直接可用——现有代码不用改。');
} else if (dav.every((n) => ok('fetchEnvProxy', n))) {
  verdict.push('日历/提醒/通讯录：设置环境变量 NODE_USE_ENV_PROXY=1 即可（不用改代码）。');
} else if (dav.every((n) => ok('proxy', n) || ok('direct', n))) {
  verdict.push(`日历/提醒/通讯录：原始连接能通但 fetch 不通——需要在代码里给 fetch 显式配代理（Node ${process.version} 可能不认 NODE_USE_ENV_PROXY）。`);
} else {
  verdict.push('日历/提醒/通讯录：不通——检查域名白名单（需要 *.icloud.com 通配）。');
}

verdict.push('注意：登录后 CalDAV/CardDAV 会跳到 pNN-caldav.icloud.com / pNN-contacts.icloud.com 这类主机，白名单要写 *.icloud.com 通配，只写上面两个主机名不够。');

console.log('');
console.log('== 结论 ==');
for (const v of verdict) console.log(`- ${v}`);
console.log('');
console.log(`PROBE_JSON ${JSON.stringify({ node: process.version, proxy: proxy?.display ?? null, results })}`);
