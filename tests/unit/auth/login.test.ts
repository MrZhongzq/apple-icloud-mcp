import { describe, it, expect, vi } from 'vitest';
import {
  renderLoginPage,
  handleLoginSubmit,
  createPendingStore,
} from '../../../src/auth/login.js';
import { hashPassword } from '../../../src/auth/crypto.js';
import { createLogger } from '../../../src/core/logger.js';
import type { Logger } from '../../../src/core/logger.js';

const logger = createLogger('error', () => {});
/** 绕开 core/logger.ts 的 redact()：那层会把任何 pass/token/secret 之类的键遮成 '***'，
 *  所以只看落地日志分不清「这个文件没记密码」和「记了但被遮住了」。这里直接接住
 *  handleLoginSubmit 传给 logger 的原始 meta，单独检查这一个文件自己的纪律。 */
const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};
const PASSWORD = 'a-long-admin-password';
const adminPasswordHash = hashPassword(PASSWORD);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function makeProvider(code = 'issued-code-123') {
  return {
    issueAuthorizationCode: vi.fn().mockReturnValue(code),
  };
}

function pendingWith(store: ReturnType<typeof createPendingStore>, state?: string) {
  return store.put({
    client_id: 'client-1',
    redirect_uri: REDIRECT,
    code_challenge: 'challenge-abc',
    scopes: ['mcp'],
    state,
    expires_at: Date.now() + 600_000,
  });
}

describe('pending authorization store', () => {
  it('hands back what was put in, exactly once', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    expect(store.take(id)?.client_id).toBe('client-1');
    expect(store.take(id), '取出即删除 —— 一个待授权请求不该能被消费两次').toBeUndefined();
  });

  it('generates unguessable request ids', () => {
    const store = createPendingStore();
    const ids = new Set(Array.from({ length: 100 }, () => pendingWith(store)));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('expires a pending request', () => {
    const store = createPendingStore();
    const id = store.put({
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      code_challenge: 'c',
      scopes: ['mcp'],
      expires_at: Date.now() - 1,
    });
    expect(store.take(id)).toBeUndefined();
  });
});

describe('login page', () => {
  it('carries the request id and nothing sensitive', () => {
    const html = renderLoginPage({ requestId: 'req-abc' });
    expect(html).toContain('req-abc');
    expect(html).not.toContain(adminPasswordHash);
    expect(html).not.toContain('scrypt$');
    expect(html.toLowerCase()).toContain('type="password"');
  });

  it('shows an error when one is given', () => {
    const html = renderLoginPage({ requestId: 'req-abc', error: '口令不正确' });
    expect(html).toContain('口令不正确');
  });

  it('escapes the request id rather than interpolating it raw', () => {
    const html = renderLoginPage({ requestId: '"><script>alert(1)</script>' });
    expect(html, '登录页拼 HTML 时不转义，就是一个现成的反射型 XSS').not.toContain('<script>alert(1)</script>');
  });
});

describe('login submission', () => {
  it('issues a code and redirects back with it', () => {
    const store = createPendingStore();
    const id = pendingWith(store, 'client-state-xyz');
    const provider = makeProvider('the-code');
    const result = handleLoginSubmit(
      { adminPasswordHash, provider, logger, pending: store } as never,
      { requestId: id, password: PASSWORD },
    );
    expect('redirectTo' in result).toBe(true);
    const url = new URL((result as { redirectTo: string }).redirectTo);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('code')).toBe('the-code');
    expect(url.searchParams.get('state'), 'state 必须原样带回，它是客户端防 CSRF 的手段').toBe(
      'client-state-xyz',
    );
  });

  it('omits state when the client did not send one', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const result = handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, password: PASSWORD },
    );
    const url = new URL((result as { redirectTo: string }).redirectTo);
    expect(url.searchParams.has('state')).toBe(false);
  });

  it('rejects a wrong password without issuing anything', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const provider = makeProvider();
    const result = handleLoginSubmit(
      { adminPasswordHash, provider, logger, pending: store } as never,
      { requestId: id, password: 'wrong' },
    );
    expect('error' in result).toBe(true);
    expect(provider.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  it('says plainly which of the two things went wrong', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const wrongPass = handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, password: 'wrong' },
    );
    const expired = handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: 'never-existed', password: PASSWORD },
    );
    // 只有一个管理员，不存在账号枚举问题；含糊报错只会让部署者配错时抓瞎
    expect((wrongPass as { error: string }).error).not.toBe((expired as { error: string }).error);
    // 不只要“不一样”——两条消息不能被调换：口令错必须点名口令，请求过期/不存在必须点名请求本身。
    expect((wrongPass as { error: string }).error, '口令错的提示必须点名是口令').toContain('口令');
    expect(
      (expired as { error: string }).error,
      '请求过期/不存在的提示必须点名是请求本身，不能是口令',
    ).toMatch(/过期|不存在/);
    expect((expired as { error: string }).error).not.toContain('口令');
  });

  it('keeps the pending request usable after a wrong password', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, password: 'wrong' },
    );
    const second = handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, password: PASSWORD },
    );
    expect('redirectTo' in second, '输错一次口令不该让人重新发起整个授权').toBe(true);
  });

  it('never logs the submitted password', () => {
    const lines: string[] = [];
    const capturing = createLogger('debug', (line) => lines.push(line));
    const store = createPendingStore();
    const id = pendingWith(store);
    handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger: capturing, pending: store } as never,
      { requestId: id, password: PASSWORD },
    );
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  it('never hands the submitted password to the logger, redaction aside', () => {
    // 上面那条测试走的是 createLogger 的真实落地路径，会先经过 redact() 才落盘——
    // 一旦 handleLoginSubmit 往 meta 里塞了 password 字段，redact() 会把它遮成 '***'，
    // 那条测试看不出区别。这里绕开 redact，直接接住传给 logger.warn 的原始 meta 对象，
    // 单独检查这一个文件自己有没有把口令递出去。
    const seen: unknown[] = [];
    const spy: Logger = {
      ...silentLogger,
      warn: (_msg, meta) => {
        seen.push(meta);
      },
    };
    const store = createPendingStore();
    const id = pendingWith(store);

    handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger: spy, pending: store } as never,
      { requestId: id, password: 'wrong-password-value' },
    );

    expect(JSON.stringify(seen)).not.toContain('wrong-password-value');
  });
});
