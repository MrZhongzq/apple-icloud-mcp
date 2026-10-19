import path from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.js';
import { parseEncryptionKey } from '../auth/crypto.js';
import type { LogLevel } from './logger.js';

export interface Capabilities {
  mailRead: boolean;
  mailWrite: boolean;
  calendarRead: boolean;
  calendarWrite: boolean;
  remindersRead: boolean;
  remindersWrite: boolean;
  contactsRead: boolean;
  contactsWrite: boolean;
}

export interface AccountConfig {
  id: string;
  email: string;
  sender: string;
  label: string;
  appPassword: string;
  capabilities: Capabilities;
  /** 账号从哪里来：env = 服务进程自己的环境变量；envelope = 用户登录时带来的信封。未设置等同于 env。 */
  origin?: 'env' | 'envelope';
}

export interface AppConfig {
  accounts: AccountConfig[];
  sessionTtlMs: number;
  imapIdleTimeoutMs: number;
  logLevel: LogLevel;
  deprecations: string[];
  /** 能力被自动降级时的说明（例如：发信地址不是 iCloud 邮箱，邮件工具已禁用）。与 deprecations 分开，
   *  因为二者含义不同：deprecations 说的是"这个变量名过时了"，notices 说的是"这个账号的某项能力被关闭了"。 */
  notices: string[];
}

/** 真正使用 iCloud Mail 的账号，其发信地址一定落在 Apple 分配的这几个域名下。 */
const ICLOUD_MAIL_DOMAINS = new Set(['icloud.com', 'me.com', 'mac.com', 'icloud.com.cn']);

function isIcloudMailAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at === -1) return false;
  const domain = address.slice(at + 1).toLowerCase();
  return ICLOUD_MAIL_DOMAINS.has(domain);
}

/** 旧的小写变量名 → 新命名。旧版把序号嵌在名字中间（icloud_account2、allow_mail2_read）。 */
function buildLegacyMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 1; i <= 5; i++) {
    const old = i === 1 ? '' : String(i);
    map[`icloud_account${old}`] = `ICLOUD_ACCOUNT_${i}`;
    map[`icloud_app_pass${old}`] = `ICLOUD_APP_PASSWORD_${i}`;
    map[`icloud_sender${old}`] = `ICLOUD_SENDER_${i}`;
    map[`allow_mail${old}_read`] = `ALLOW_MAIL_READ_${i}`;
    map[`allow_mail${old}_write`] = `ALLOW_MAIL_WRITE_${i}`;
    map[`allow_calendar${old}_read`] = `ALLOW_CALENDAR_READ_${i}`;
    map[`allow_calendar${old}_write`] = `ALLOW_CALENDAR_WRITE_${i}`;
  }
  return map;
}

const LEGACY_MAP: Record<string, string> = buildLegacyMap();

const emailSchema = z.email();
const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);

function clean(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * parseAccount 里那几条会把变量的**值**写进消息的错误。对 env 账号它就是一个普通的 AppError，
 * 消息与以前逐字相同——值是部署者自己的配置，写进 stderr 有助于排查。信封账号不一样：值来自
 * 解密后的载荷，而 wrapTool 会把 AppError 的 message 原样记进日志，所以 accountFromEnvelopeEnv
 * 接住它，换成一条只点名变量的消息。带上 variable/problem 是为了不必回头去解析中文消息。
 */
class EnvValueError extends AppError {
  readonly variable: string;
  readonly problem: string;

  constructor(variable: string, problem: string, message: string, hint?: string) {
    super('INVALID_INPUT', message, hint === undefined ? {} : { hint });
    this.variable = variable;
    this.problem = problem;
  }
}

const BOOL_HINT = '只接受 true/false（或 1/0、yes/no）';

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = clean(env[key]);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true;
  if (lowered === 'false' || lowered === '0' || lowered === 'no') return false;
  throw new EnvValueError(key, '的值无法识别', `环境变量 ${key} 的值无法识别：${raw}`, BOOL_HINT);
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = clean(env[key]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('INVALID_INPUT', `环境变量 ${key} 必须是正整数，实际是：${raw}`);
  }
  return Math.floor(value);
}

function applyLegacy(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; deprecations: string[] } {
  const merged: NodeJS.ProcessEnv = { ...env };
  const deprecations: string[] = [];
  for (const [oldKey, newKey] of Object.entries(LEGACY_MAP)) {
    const value = env[oldKey];
    if (value !== undefined && merged[newKey] === undefined) {
      merged[newKey] = value;
      deprecations.push(`环境变量 ${oldKey} 已弃用，请改用 ${newKey}`);
    }
  }
  if (env.multiple_account_enable !== undefined) {
    deprecations.push('环境变量 multiple_account_enable 已废弃：账号 2-5 现在按 ICLOUD_ACCOUNT_2..5 是否存在自动识别');
  }
  return { env: merged, deprecations };
}

function parseAccount(
  env: NodeJS.ProcessEnv,
  index: number,
): { account: AccountConfig; notice?: string } | undefined {
  const suffix = `_${index}`;
  const email = clean(env[`ICLOUD_ACCOUNT${suffix}`]);
  const appPassword = clean(env[`ICLOUD_APP_PASSWORD${suffix}`]);

  if (email === undefined && appPassword === undefined) return undefined;
  if (email === undefined) {
    throw new AppError('INVALID_INPUT', `配置了 ICLOUD_APP_PASSWORD${suffix} 却没有 ICLOUD_ACCOUNT${suffix}`);
  }
  if (appPassword === undefined) {
    throw new AppError('INVALID_INPUT', `配置了 ICLOUD_ACCOUNT${suffix} 却没有 ICLOUD_APP_PASSWORD${suffix}`, {
      hint: '在 https://appleid.apple.com 生成 App 专用密码',
    });
  }
  if (!emailSchema.safeParse(email).success) {
    throw new EnvValueError(`ICLOUD_ACCOUNT${suffix}`, '不是合法邮箱', `ICLOUD_ACCOUNT${suffix} 不是合法邮箱：${email}`);
  }

  const sender = clean(env[`ICLOUD_SENDER${suffix}`]) ?? email;
  const label = clean(env[`ICLOUD_LABEL${suffix}`]) ?? email;

  // readBool 必须无条件调用，即便下面会因为非 iCloud 发信域名把结果强制改成 false：
  // 这样一个写错的 ALLOW_MAIL_* 取值仍然会被拒绝，而不是被域名判断悄悄掩盖。
  const mailReadAllowed = readBool(env, `ALLOW_MAIL_READ${suffix}`, true);
  const mailWriteAllowed = readBool(env, `ALLOW_MAIL_WRITE${suffix}`, false);
  const mailCapable = isIcloudMailAddress(sender);

  const notice = mailCapable
    ? undefined
    : `账号 ${label}：发信地址 ${sender} 不是 iCloud 邮箱地址，该账号的邮件工具已禁用（日历、提醒事项与通讯录不受影响）。` +
      `如果这是一个 iCloud Mail 账号，请设置 ICLOUD_SENDER${suffix} 为你的 iCloud 邮箱地址` +
      `（@icloud.com / @me.com / @mac.com / @icloud.com.cn）；` +
      `如果你没有 iCloud 邮箱，说明该账号并未使用 iCloud Mail，其日历、提醒事项与通讯录工具仍然可用。`;

  return {
    account: {
      id: `account${suffix}`,
      email,
      sender,
      label,
      appPassword,
      capabilities: {
        mailRead: mailCapable && mailReadAllowed,
        mailWrite: mailCapable && mailWriteAllowed,
        calendarRead: readBool(env, `ALLOW_CALENDAR_READ${suffix}`, true),
        calendarWrite: readBool(env, `ALLOW_CALENDAR_WRITE${suffix}`, false),
        remindersRead: readBool(env, `ALLOW_REMINDERS_READ${suffix}`, true),
        remindersWrite: readBool(env, `ALLOW_REMINDERS_WRITE${suffix}`, false),
        contactsRead: readBool(env, `ALLOW_CONTACTS_READ${suffix}`, true),
        contactsWrite: readBool(env, `ALLOW_CONTACTS_WRITE${suffix}`, false),
      },
    },
    notice,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv, options: { allowNoAccounts?: boolean } = {}): AppConfig {
  const { env: merged, deprecations } = applyLegacy(env);

  const accounts: AccountConfig[] = [];
  const notices: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const parsed = parseAccount(merged, i);
    if (parsed) {
      accounts.push(parsed.account);
      if (parsed.notice) notices.push(parsed.notice);
    }
  }

  // 远程入口的账号来自用户登录时的信封，进程自己可以一个账号都没有；stdio/CLI 仍然必须有。
  if (accounts.length === 0 && !options.allowNoAccounts) {
    throw new AppError('INVALID_INPUT', '没有配置任何 iCloud 账号', {
      hint: '至少设置 ICLOUD_ACCOUNT_1 与 ICLOUD_APP_PASSWORD_1，可参考仓库根目录的 .env.example',
    });
  }

  const rawLevel = clean(merged.LOG_LEVEL) ?? 'info';
  const level = logLevelSchema.safeParse(rawLevel);
  if (!level.success) {
    throw new AppError('INVALID_INPUT', `LOG_LEVEL 不合法：${rawLevel}`, {
      hint: '可选值：error / warn / info / debug',
    });
  }

  return {
    accounts,
    sessionTtlMs: readInt(merged, 'SESSION_TTL_MINUTES', 30) * 60_000,
    imapIdleTimeoutMs: readInt(merged, 'IMAP_IDLE_TIMEOUT_SECONDS', 300) * 1000,
    logLevel: level.data,
    deprecations,
    notices,
  };
}

/** 信封里允许携带的变量：正好是账号 1 的 12 个变量，其余一律丢弃。 */
export const ENVELOPE_ENV_KEYS: readonly string[] = [
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

/** 把信封里的 env 变成账号。必须走 parseAccount：iCloud 发信域名保护与"写权限默认关"都在那里，
 *  这里另写一份就会让信封账号绕开它们。先按白名单过滤，是为了让信封里夹带的
 *  ICLOUD_ACCOUNT_2、LOG_LEVEL 之类无法影响解析。 */
export function accountFromEnvelopeEnv(env: Record<string, unknown>): { account: AccountConfig; notices: string[] } {
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of ENVELOPE_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string') filtered[key] = value;
  }
  let parsed: ReturnType<typeof parseAccount>;
  try {
    parsed = parseAccount(filtered, 1);
  } catch (err) {
    // 同一个错误码、同一个变量名，只是不带值：信封载荷不能经 wrapTool 的日志漏出去。
    // 其余 parseAccount 错误（缺账号、缺密码）本来就只含变量名，原样抛出。
    if (err instanceof EnvValueError) {
      const fix = `在你自己的 .env 里改好 ${err.variable} 后重新生成信封`;
      throw new AppError(err.code, `信封里的 ${err.variable} ${err.problem}`, {
        hint: err.hint === undefined ? fix : `${err.hint}；${fix}`,
      });
    }
    throw err;
  }
  if (!parsed) {
    throw new AppError('INVALID_INPUT', '信封里没有账号信息', {
      hint: '确认 .env 里设置了 ICLOUD_ACCOUNT_1 与 ICLOUD_APP_PASSWORD_1 后重新生成信封',
    });
  }
  return {
    account: { ...parsed.account, origin: 'envelope' },
    notices: parsed.notice ? [parsed.notice] : [],
  };
}

/** 权限被拒时的恢复提示。env 账号改服务端环境变量；信封账号只能改自己的 .env 重新生成信封。 */
export function capabilityHint(account: AccountConfig, stem: string): string {
  if (account.origin === 'envelope') {
    return `在你自己的 .env 里把 ${stem}_1 设为 true，重新生成信封后再登录`;
  }
  return `设置环境变量 ${stem}_${account.id.split('_')[1]}=true 后重启服务`;
}

// ---------------------------------------------------------------------------
// HTTP 入口专属配置。只有 src/bin/http.ts（远程 Streamable HTTP + OAuth 传输）
// 会调用 loadHttpConfig；stdio 入口（loadConfig/AppConfig）完全不依赖它，
// 本地用户不会因为这里新增的变量而突然需要设置 PUBLIC_URL 才能启动。
// ---------------------------------------------------------------------------

export interface HttpConfig {
  port: number;
  publicUrl: URL;
  adminPasswordHash: string;
  tokenStorePath: string;
  encryptionKey: Buffer;
  /**
   * 是否启用 express 的 `trust proxy`，即把 `X-Forwarded-For` 的最左端当成客户端地址。
   *
   * 默认 **false**：直接把端口暴露到公网的部署里，这个头是调用方自己写的，信它等于让任何人
   * 自选限流桶，一个客户端就能无限重试访问密钥与管理员口令。反过来，本仓库自带的 `docker-compose.yml`
   * 在前面放了 Caddy，此时每个请求的 socket 远端地址都是同一个容器 IP，按 `req.ip` 限流
   * 等于全世界共用一个桶——一个未认证的访客就能把授权页 `/access-login`、管理页登录 `/admin/login`
   * 与 `/token` 的额度替所有人耗光，把整条授权流程锁死。两种部署都真实存在，所以这件事只能由
   * 部署方声明，不能猜。
   */
  trustProxy: boolean;
  /** 信封私钥文件（用 TOKEN_ENCRYPTION_KEY 加密）。默认与令牌存储放在同一目录。 */
  envelopeKeyPath: string;
}

const DEFAULT_HTTP_PORT = 17733;
/** OAuth 元数据要求 issuer 是 https，但本地开发没有证书，所以这两个 host 豁免。 */
const HTTPS_EXEMPT_HOSTS = new Set(['localhost', '127.0.0.1']);

/** 自包含的生成命令：不指向任何文档章节（本仓库已经因为提示语指向不存在的东西踩过好几次坑），
 *  而是直接给出可以照抄执行的命令。口令从标准输入读入而不是命令行参数——参数会留在 shell
 *  历史和进程列表里，被同一台机器上的其他用户看到。 */
const GENERATE_ADMIN_HASH_HINT =
  `用以下命令生成 ADMIN_PASSWORD_HASH（在 npm run build 之后于项目根目录运行，口令从标准输入读入，` +
  `不会留在 shell 历史或进程列表里）：node -e "const r=require('node:readline').createInterface(` +
  `{input:process.stdin,output:process.stderr});r.question('password: ',p=>{r.close();` +
  `import('./dist/auth/crypto.js').then(m=>console.log(m.hashPassword(p)))})"`;

/** 显式、独立于共享的 clean() 做 trim——不是因为 clean() 不够，而是让"HTTP 配置在存进
 *  HttpConfig 之前会被 trim"这件事在这里自己说清楚，不必让读者去翻 clean() 的实现才能确认。
 *  这三个变量（PUBLIC_URL / ADMIN_PASSWORD_HASH / TOKEN_ENCRYPTION_KEY）都经过这里，
 *  所以粘贴带来的首尾空白——比如 .env 里 "KEY= value" 等号后的那个空格——三个都会被处理。
 *  尾部的换行符不需要特殊处理：trim() 本身就会去掉它，而下游的 base64url 解码就算留着换行符
 *  也会忽略它，所以真正会改变解码结果的只有首尾空白，不是所有"看不见的字符"都要挡。 */
function requireHttpEnv(env: NodeJS.ProcessEnv, key: string, hint: string): string {
  const raw = env[key];
  const value = raw === undefined ? undefined : raw.trim();
  if (value === undefined || value.length === 0) {
    throw new AppError('INVALID_INPUT', `缺少必需的环境变量 ${key}`, { hint });
  }
  return value;
}

/** 只检查形状（六个 $ 分隔字段、scheme 是 scrypt、N/r/p 是正整数）——不校验 salt/hash 的内容，
 *  那部分校验不了也不需要校验。目的是把"哈希格式不对"这个问题挡在启动时，而不是让它一路
 *  沉默到登录时才在 verifyPassword 里悄悄变成一句"密码错误"，把部署者的排查方向指错。 */
function validateAdminPasswordHashFormat(hash: string): void {
  const invalid = (): never => {
    throw new AppError('INVALID_INPUT', 'ADMIN_PASSWORD_HASH 格式不对', {
      hint: `ADMIN_PASSWORD_HASH 必须是形如 scrypt$32768$8$1$<salt>$<hash> 的哈希串，而不是口令明文本身。${GENERATE_ADMIN_HASH_HINT}`,
    });
  };
  const parts = hash.split(String.fromCharCode(36));
  if (parts.length !== 6) invalid();
  const [scheme, nRaw, rRaw, pRaw] = parts;
  if (scheme !== 'scrypt') invalid();
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || n <= 0) invalid();
  if (!Number.isInteger(r) || r <= 0) invalid();
  if (!Number.isInteger(p) || p <= 0) invalid();
}

function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('INVALID_INPUT', `PUBLIC_URL 不是合法的 URL：${raw}`, {
      hint: 'PUBLIC_URL 必须是完整 URL，例如 https://mcp.example.com',
    });
  }
  const isExempt = HTTPS_EXEMPT_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !isExempt) {
    throw new AppError('INVALID_INPUT', 'PUBLIC_URL 必须使用 https', {
      hint: 'OAuth 元数据要求 issuer 是 https；仅 localhost/127.0.0.1 可以用 http 做本地开发',
    });
  }
  return url;
}

function readHttpPort(env: NodeJS.ProcessEnv): number {
  const raw = clean(env.PORT);
  if (raw === undefined) return DEFAULT_HTTP_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new AppError('INVALID_INPUT', `环境变量 PORT 必须是 1-65535 之间的整数，实际是：${raw}`, {
      hint: 'PORT 留空则默认 17733',
    });
  }
  return value;
}

/** 只有 HTTP 入口调用；缺少任一必填项即抛 AppError，绝不使用默认值兜底。 */
export function loadHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const publicUrlRaw = requireHttpEnv(
    env,
    'PUBLIC_URL',
    'PUBLIC_URL 用作 OAuth issuer 与回调地址，例如 https://mcp.example.com',
  );
  const adminPasswordHash = requireHttpEnv(
    env,
    'ADMIN_PASSWORD_HASH',
    `设置 ADMIN_PASSWORD_HASH 为管理员口令的 scrypt 哈希（形如 scrypt$32768$8$1$<salt>$<hash>）。${GENERATE_ADMIN_HASH_HINT}`,
  );
  const tokenEncryptionKeyRaw = requireHttpEnv(
    env,
    'TOKEN_ENCRYPTION_KEY',
    '设置 TOKEN_ENCRYPTION_KEY 为 32 字节密钥的 base64 编码，可用 openssl rand -base64 32 生成',
  );

  const publicUrl = parsePublicUrl(publicUrlRaw);
  validateAdminPasswordHashFormat(adminPasswordHash);
  const encryptionKey = parseEncryptionKey(tokenEncryptionKeyRaw);
  const port = readHttpPort(env);
  const tokenStorePath = clean(env.TOKEN_STORE_PATH) ?? path.join(process.cwd(), 'data', 'tokens.json.enc');

  return {
    port,
    publicUrl,
    adminPasswordHash,
    tokenStorePath,
    encryptionKey,
    trustProxy: readBool(env, 'TRUST_PROXY', false),
    envelopeKeyPath:
      clean(env.ENVELOPE_KEY_PATH) ?? path.join(path.dirname(tokenStorePath), 'envelope-key.json.enc'),
  };
}

export function findAccount(config: AppConfig, email?: string): AccountConfig {
  if (email === undefined) {
    const only = config.accounts[0];
    if (config.accounts.length === 1 && only) return only;
    throw new AppError('INVALID_INPUT', '配置了多个账号，必须指定 account', {
      hint: `可用账号：${config.accounts.map((a) => a.email).join('、')}`,
    });
  }
  const found = config.accounts.find((a) => a.email === email || a.sender === email);
  if (!found) {
    throw new AppError('NOT_FOUND', `未配置账号 ${email}`, {
      hint: `已配置的账号：${config.accounts.map((a) => a.email).join('、')}`,
    });
  }
  return found;
}
