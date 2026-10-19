import { describe, it, expect, vi } from 'vitest';
import {
  renderLoginPage,
  handleLoginSubmit,
  createPendingStore,
} from '../../../src/auth/login.js';
import { hashPassword } from '../../../src/auth/crypto.js';
import type { AccessKeyRecord } from '../../../src/auth/store.js';
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
/** 管理员口令的哈希只用来确认登录页不会把它渲染出去——授权页本身已经不认管理员口令了。 */
const adminPasswordHash = hashPassword('a-long-admin-password');
const ACCESS_KEY = 'amk_the-access-key-plaintext';
const DISABLED_KEY = 'amk_a-disabled-access-key';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const keyRecord: AccessKeyRecord = {
  id: 'key-1',
  name: 'alice',
  key_hash: 'not-used-here',
  created_at: 0,
  enabled: true,
};
const disabledRecord: AccessKeyRecord = { ...keyRecord, id: 'key-2', name: 'bob', enabled: false };

/** 替代 store.findAccessKeyByPlaintext：与真实 store 一样，停用的密钥也会被查到。 */
function findAccessKey(plaintext: string): AccessKeyRecord | undefined {
  if (plaintext === ACCESS_KEY) return keyRecord;
  if (plaintext === DISABLED_KEY) return disabledRecord;
  return undefined;
}

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

  it('remembers a consumed request as completed until the original request would have expired', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    expect(store.wasCompleted(id), '还没被消费的请求不算完成').toBe(false);
    store.take(id);
    expect(store.wasCompleted(id)).toBe(true);
    expect(store.wasCompleted('never-existed')).toBe(false);

    store.sweep(Date.now() + 600_001);
    expect(store.wasCompleted(id), '过了原请求的有效期，sweep 必须把这条标记一并清掉').toBe(false);
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

  it('asks for an access key and posts it to /access-login', () => {
    const html = renderLoginPage({ requestId: 'req-abc' });
    expect(html).toContain('action="/access-login"');
    expect(html).toContain('name="access_key"');
    expect(html).toContain('访问密钥');
    expect(html, '访问密钥不是使用者自己的口令，不该被浏览器记成这个站点的密码').toContain(
      'autocomplete="off"',
    );
    expect(html).not.toContain('name="password"');
  });

  it('shows an error when one is given', () => {
    const html = renderLoginPage({ requestId: 'req-abc', error: '访问密钥不正确' });
    expect(html).toContain('访问密钥不正确');
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
      { findAccessKey, provider, logger, pending: store } as never,
      { requestId: id, accessKey: ACCESS_KEY },
    );
    expect('redirectTo' in result).toBe(true);
    const url = new URL((result as { redirectTo: string }).redirectTo);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('code')).toBe('the-code');
    expect(url.searchParams.get('state'), 'state 必须原样带回，它是客户端防 CSRF 的手段').toBe(
      'client-state-xyz',
    );
    expect(provider.issueAuthorizationCode, '授权码必须记下是凭哪把密钥签发的').toHaveBeenCalledWith(
      expect.objectContaining({ accessKeyId: 'key-1' }),
    );
  });

  it('omits state when the client did not send one', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const result = handleLoginSubmit(
      { findAccessKey, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, accessKey: ACCESS_KEY },
    );
    const url = new URL((result as { redirectTo: string }).redirectTo);
    expect(url.searchParams.has('state')).toBe(false);
  });

  it('rejects a wrong access key without issuing anything', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const provider = makeProvider();
    const result = handleLoginSubmit(
      { findAccessKey, provider, logger, pending: store } as never,
      { requestId: id, accessKey: 'wrong' },
    );
    expect('error' in result).toBe(true);
    expect(provider.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  it('rejects a disabled access key without issuing anything', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const provider = makeProvider();
    const result = handleLoginSubmit(
      { findAccessKey, provider, logger, pending: store } as never,
      { requestId: id, accessKey: DISABLED_KEY },
    );
    expect('error' in result).toBe(true);
    expect(provider.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  it('says plainly which of the two things went wrong', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const wrongKey = handleLoginSubmit(
      { findAccessKey, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, accessKey: 'wrong' },
    );
    const expired = handleLoginSubmit(
      { findAccessKey, provider: makeProvider(), logger, pending: store } as never,
      { requestId: 'never-existed', accessKey: ACCESS_KEY },
    );
    // 访问密钥没有「用户名」这一半，区分这两种情况不构成任何枚举；含糊报错只会让人抓瞎
    expect((wrongKey as { error: string }).error).not.toBe((expired as { error: string }).error);
    // 不只要“不一样”——两条消息不能被调换：密钥错必须点名密钥，请求过期/不存在必须点名请求本身。
    expect((wrongKey as { error: string }).error, '密钥错的提示必须点名是访问密钥').toContain('访问密钥');
    expect(
      (expired as { error: string }).error,
      '请求过期/不存在的提示必须点名是请求本身，不能是密钥',
    ).toMatch(/过期|不存在/);
    expect((expired as { error: string }).error).not.toContain('密钥');
  });

  it('keeps the pending request usable after a wrong access key', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    handleLoginSubmit(
      { findAccessKey, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, accessKey: 'wrong' },
    );
    const second = handleLoginSubmit(
      { findAccessKey, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, accessKey: ACCESS_KEY },
    );
    expect('redirectTo' in second, '输错一次密钥不该让人重新发起整个授权').toBe(true);
  });

  it('never logs the submitted access key', () => {
    const lines: string[] = [];
    const capturing = createLogger('debug', (line) => lines.push(line));
    const store = createPendingStore();
    const id = pendingWith(store);
    handleLoginSubmit(
      { findAccessKey, provider: makeProvider(), logger: capturing, pending: store } as never,
      { requestId: id, accessKey: ACCESS_KEY },
    );
    expect(lines.join('\n')).not.toContain(ACCESS_KEY);
  });

  it('never hands the submitted access key to the logger, redaction aside', () => {
    // 上面那条测试走的是 createLogger 的真实落地路径，会先经过 redact() 才落盘——
    // 一旦 handleLoginSubmit 往 meta 里塞了带 key/secret 字样的字段，redact() 会把它遮成 '***'，
    // 那条测试看不出区别。这里绕开 redact，直接接住传给 logger 的原始 meta 对象，
    // 单独检查这一个文件自己有没有把提交上来的字符串递出去——成功与失败两条路径都看。
    const seen: unknown[] = [];
    const record = (_msg: string, meta?: unknown): void => {
      seen.push(meta);
    };
    const spy: Logger = { ...silentLogger, warn: record, info: record, debug: record, error: record };
    const store = createPendingStore();
    const id = pendingWith(store);

    handleLoginSubmit(
      { findAccessKey, provider: makeProvider(), logger: spy, pending: store } as never,
      { requestId: id, accessKey: 'amk_wrong-key-value' },
    );
    handleLoginSubmit(
      { findAccessKey, provider: makeProvider(), logger: spy, pending: store } as never,
      { requestId: id, accessKey: ACCESS_KEY },
    );

    expect(seen.length, '两次提交都应当留下日志，否则这条测试什么也没看').toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(seen)).not.toContain('amk_wrong-key-value');
    expect(JSON.stringify(seen)).not.toContain(ACCESS_KEY);
  });
});
