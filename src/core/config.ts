import { z } from 'zod';
import { AppError } from './errors.js';
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

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = clean(env[key]);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true;
  if (lowered === 'false' || lowered === '0' || lowered === 'no') return false;
  throw new AppError('INVALID_INPUT', `环境变量 ${key} 的值无法识别：${raw}`, {
    hint: '只接受 true/false（或 1/0、yes/no）',
  });
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
    throw new AppError('INVALID_INPUT', `ICLOUD_ACCOUNT${suffix} 不是合法邮箱：${email}`);
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
    : `账号 ${label}：发信地址 ${sender} 不是 iCloud 邮箱地址，该账号的邮件工具已禁用（日历不受影响）。` +
      `如果这是一个 iCloud Mail 账号，请设置 ICLOUD_SENDER${suffix} 为你的 iCloud 邮箱地址` +
      `（@icloud.com / @me.com / @mac.com / @icloud.com.cn）；` +
      `如果你没有 iCloud 邮箱，说明该账号并未使用 iCloud Mail，仅日历功能可用。`;

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

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
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

  if (accounts.length === 0) {
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
