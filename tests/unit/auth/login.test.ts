import { describe, it, expect, vi } from 'vitest';
import {
  renderLoginPage,
  handleLoginSubmit,
  createPendingStore,
} from '../../../src/auth/login.js';
import { hashPassword } from '../../../src/auth/crypto.js';
import { createLogger } from '../../../src/core/logger.js';

const logger = createLogger('error', () => {});
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
    const store = createPendingStore(1);
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
});
