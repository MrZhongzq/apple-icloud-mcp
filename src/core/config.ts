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

function parseAccount(env: NodeJS.ProcessEnv, index: number): AccountConfig | undefined {
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

  return {
    id: `account${suffix}`,
    email,
    sender: clean(env[`ICLOUD_SENDER${suffix}`]) ?? email,
    label: clean(env[`ICLOUD_LABEL${suffix}`]) ?? email,
    appPassword,
    capabilities: {
      mailRead: readBool(env, `ALLOW_MAIL_READ${suffix}`, true),
      mailWrite: readBool(env, `ALLOW_MAIL_WRITE${suffix}`, false),
      calendarRead: readBool(env, `ALLOW_CALENDAR_READ${suffix}`, true),
      calendarWrite: readBool(env, `ALLOW_CALENDAR_WRITE${suffix}`, false),
      remindersRead: readBool(env, `ALLOW_REMINDERS_READ${suffix}`, true),
      remindersWrite: readBool(env, `ALLOW_REMINDERS_WRITE${suffix}`, false),
      contactsRead: readBool(env, `ALLOW_CONTACTS_READ${suffix}`, true),
      contactsWrite: readBool(env, `ALLOW_CONTACTS_WRITE${suffix}`, false),
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const { env: merged, deprecations } = applyLegacy(env);

  const accounts: AccountConfig[] = [];
  for (let i = 1; i <= 5; i++) {
    const account = parseAccount(merged, i);
    if (account) accounts.push(account);
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
