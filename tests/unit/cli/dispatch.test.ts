import { describe, it, expect } from 'vitest';
import { runCli, listCliTools, CLI_MANAGED_SESSION_TOOLS } from '../../../src/cli/dispatch.js';
import type { RunCliDeps } from '../../../src/cli/dispatch.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig, AccountConfig } from '../../../src/core/config.js';
import type { CollectedTool } from '../../../src/cli/registry.js';
import type { SessionFactory } from '../../../src/cli/execute.js';
import { z } from 'zod';

const logger = createLogger('error', () => {});

function account(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id: 'account_1', label: 'a@icloud.com', email: 'a@icloud.com', sender: 'a@icloud.com',
    appPassword: 'x',
    capabilities: {
      mailRead: true, mailWrite: false, calendarRead: true, calendarWrite: false,
      remindersRead: true, remindersWrite: false, contactsRead: true, contactsWrite: false,
    },
    ...overrides,
  };
}

function configWith(accounts: AccountConfig[]): AppConfig {
  return {
    accounts,
    sessionTtlMs: 60_000, imapIdleTimeoutMs: 60_000, logLevel: 'error',
    deprecations: [], notices: [],
  } as AppConfig;
}

const singleAccountConfig = configWith([account()]);

function fakeSessionFactory(): SessionFactory {
  let counter = 0;
  return () => ({
    create: () => {
      counter += 1;
      return { id: `fake-session-${counter}` };
    },
    destroy: async () => true,
  });
}

/** 与真实 apple_login/work_done/apple_accounts/mail_search 的 schema 形状一致，
 *  handler 不做真事——只用于验证 dispatch 层的路由和排除逻辑。 */
function baseTools(): Map<string, CollectedTool> {
  const appleAccounts: CollectedTool = {
    name: 'apple_accounts',
    config: { description: '返回服务端配置的账号', inputSchema: {} },
    handler: async () => ({
      content: [{ type: 'text', text: JSON.stringify([{ email: 'a@icloud.com' }]) }],
    }),
  };
  const appleLogin: CollectedTool = {
    name: 'apple_login',
    config: { description: '登录 iCloud', inputSchema: { account: z.string().optional() } },
    handler: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ session_id: 'leaked-session' }) }],
    }),
  };
  const workDone: CollectedTool = {
    name: 'work_done',
    config: { description: '结束会话', inputSchema: { session_id: z.string() } },
    handler: async () => ({ content: [{ type: 'text', text: JSON.stringify({ success: true }) }] }),
  };
  const mailSearch: CollectedTool = {
    name: 'mail_search',
    config: { description: '搜索邮件', inputSchema: { session_id: z.string(), folder: z.string().optional() } },
    handler: async (args) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, got: args }) }],
    }),
  };
  return new Map([
    ['apple_accounts', appleAccounts],
    ['apple_login', appleLogin],
    ['work_done', workDone],
    ['mail_search', mailSearch],
  ]);
}

function deps(config: AppConfig, tools: Map<string, CollectedTool>): RunCliDeps {
  return { config, logger, tools, sessionFactory: fakeSessionFactory() };
}

describe('CLI_MANAGED_SESSION_TOOLS exclusion', () => {
  it('excludes apple_login and work_done from the CLI tool list', () => {
    const visible = listCliTools(baseTools());
    expect(visible.has('apple_login')).toBe(false);
    expect(visible.has('work_done')).toBe(false);
    expect(visible.has('apple_accounts')).toBe(true);
    expect(visible.has('mail_search')).toBe(true);
  });

  it('--list never surfaces apple_login or work_done', async () => {
    const outcome = await runCli(deps(singleAccountConfig, baseTools()), ['--list']);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).not.toContain('apple_login');
    expect(outcome.stdout).not.toContain('work_done');
    expect(outcome.stdout).toContain('apple_accounts');
  });

  for (const name of CLI_MANAGED_SESSION_TOOLS) {
    it(`rejects invoking ${name} directly with a message about CLI-managed sessions`, async () => {
      const outcome = await runCli(deps(singleAccountConfig, baseTools()), [name]);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdout).toBe('');
      expect(outcome.stderr, '拒绝理由必须说明 CLI 自己管理会话').toContain('自己管理会话');
    });
  }
});

describe('structured tool error exits 2 through the real dispatch path', () => {
  it('maps an isError result from executeOnce to exit code 2, via runCli (not executeOnce directly)', async () => {
    const tools = baseTools();
    const failingSearch: CollectedTool = {
      name: 'mail_search',
      config: { description: '搜索邮件', inputSchema: { session_id: z.string() } },
      handler: async () => ({
        content: [
          { type: 'text', text: JSON.stringify({ error: { code: 'AUTH_FAILED', message: '认证失败', retryable: false } }) },
        ],
        isError: true,
      }),
    };
    tools.set('mail_search', failingSearch);

    const outcome = await runCli(deps(singleAccountConfig, tools), ['mail_search']);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toBe('');
    const payload = JSON.parse(outcome.stderr) as { error: { code: string } };
    expect(payload.error.code).toBe('AUTH_FAILED');
  });

  it('exits 0 with the result on stdout when the tool succeeds', async () => {
    const outcome = await runCli(deps(singleAccountConfig, baseTools()), ['mail_search', '--folder', 'INBOX']);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe('');
    const payload = JSON.parse(outcome.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });
});

describe('multi-account refusal', () => {
  const twoAccountConfig = configWith([
    account({ id: 'account_1', label: 'a@icloud.com', email: 'a@icloud.com', sender: 'a@icloud.com' }),
    account({ id: 'account_2', label: 'b@icloud.com', email: 'b@icloud.com', sender: 'b@icloud.com' }),
  ]);

  it('refuses to run a session-taking tool with exit 1, naming the configured accounts', async () => {
    const outcome = await runCli(deps(twoAccountConfig, baseTools()), ['mail_search', '--folder', 'INBOX']);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toContain('a@icloud.com');
    expect(outcome.stderr).toContain('b@icloud.com');
    expect(outcome.stderr, '要说明这个入口一次只服务一个账号').toContain('一个账号');
    expect(outcome.stderr, '要给出拆分 .env 的建议').toContain('.env');
  });

  it('still lets apple_accounts run with multiple accounts configured', async () => {
    const outcome = await runCli(deps(twoAccountConfig, baseTools()), ['apple_accounts']);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe('');
    const payload = JSON.parse(outcome.stdout) as Array<{ email: string }>;
    expect(Array.isArray(payload)).toBe(true);
  });
});
