import { describe, it, expect } from 'vitest';
import { runCli, listCliTools, CLI_MANAGED_SESSION_TOOLS, formatErrorPayload, formatFailure } from '../../../src/cli/dispatch.js';
import { AppError } from '../../../src/core/errors.js';
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

  it('--list prints only the first sentence of each description, one line per tool', async () => {
    // 工具描述是字符串拼接写出来的，里面一个换行都没有——实测 contacts_search
    // 那一段有 798 字符。只取第一行等于原样打印整段，--list 就不再是一份能扫一眼
    // 的清单。完整描述仍然在 --help 里。
    const tools = baseTools();
    tools.set('mail_search', {
      name: 'mail_search',
      config: {
        description: '按条件搜索邮件。' + '后面这一整段属于 --help，不属于清单视图。'.repeat(20),
        inputSchema: { session_id: z.string() },
      },
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });

    const outcome = await runCli(deps(singleAccountConfig, tools), ['--list']);
    expect(outcome.exitCode).toBe(0);

    const line = outcome.stdout.split(String.fromCharCode(10)).find((l) => l.startsWith('mail_search'));
    expect(line).toBe('mail_search  按条件搜索邮件。');
    expect(outcome.stdout, '第二句及以后不该出现在清单里').not.toContain('不属于清单视图');

    // 每个工具恰好一行——描述里没有换行，所以行数必须等于工具数。
    const lines = outcome.stdout.split(String.fromCharCode(10)).filter((l) => l.length > 0);
    expect(lines).toHaveLength(listCliTools(tools).size);
  });

  it('--list keeps the whole first line when a description has no full stop', async () => {
    // 找不到句号时退回整个第一行，而不是按字符数硬截——硬截会把一句话拦腰砍断。
    const tools = baseTools();
    tools.set('mail_search', {
      name: 'mail_search',
      config: { description: '一段没有句号的描述', inputSchema: { session_id: z.string() } },
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });
    const outcome = await runCli(deps(singleAccountConfig, tools), ['--list']);
    const line = outcome.stdout.split(String.fromCharCode(10)).find((l) => l.startsWith('mail_search'));
    expect(line).toBe('mail_search  一段没有句号的描述');
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

describe('formatErrorPayload', () => {
  // 用法错误（工具没跑）在一次性路径上是一个抛出来的 AppError，由 formatFailure
  // 渲染成两行中文；同一个失败经过守护进程时已经被拍平成了 JSON 载荷。退出码
  // 上一轮统一过了，渲染没有——于是同一条命令、同一个错误，跑没跑过 cli start
  // 决定了用户看到中文还是一坨 JSON，而文档教的是"stderr 上的 {error:…} 信封
  // 意味着退出码 2、工具跑过了"，恰恰相反。
  it('renders a daemon error payload exactly the way formatFailure renders the thrown one', () => {
    const err = new AppError('INVALID_INPUT', '工具 mail_read 的参数不合法：format：bad', { hint: '用 cli mail_read --help' });
    const payload = { error: { code: 'INVALID_INPUT', message: err.message, retryable: false, hint: err.hint } };
    expect(formatErrorPayload(payload)).toBe(formatFailure(err));
  });

  it('renders a payload without a hint the same way too', () => {
    const err = new AppError('INTERNAL', '出错了');
    expect(formatErrorPayload({ error: { code: 'INTERNAL', message: '出错了' } })).toBe(formatFailure(err));
  });

  it('falls back to JSON for a shape it does not recognise, rather than losing it', () => {
    expect(formatErrorPayload({ something: 'else' })).toContain('something');
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
    // 断言要钉在**只有这条 guard 会产生**的文字上。`batch.test.ts` 那一侧已经
    // 修过：删掉 guard 之后 `findAccount` 会抛「配置了多个账号，必须指定 account」，
    // 泛化的子串（'一个账号'、'.env'）今天之所以还能红，只是因为那条替代消息
    // 碰巧写的是"多个账号"、碰巧没提 .env——是措辞的巧合，不是被钉住的性质。
    // 两段文案的区别是实质的：guard 给的是可执行的下一步，findAccount 叫人
    // "指定 account"，而 account 这个参数命令行根本不接受。
    expect(outcome.stderr, '必须是 CLI 自己的拒绝文案，不是 findAccount 的替身').toContain(
      '把不同账号拆分到各自的 .env 文件里',
    );
    expect(outcome.stderr).toContain('已配置 2 个账号');
  });

  it('still lets apple_accounts run with multiple accounts configured', async () => {
    const outcome = await runCli(deps(twoAccountConfig, baseTools()), ['apple_accounts']);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe('');
    const payload = JSON.parse(outcome.stdout) as Array<{ email: string }>;
    expect(Array.isArray(payload)).toBe(true);
  });
});
