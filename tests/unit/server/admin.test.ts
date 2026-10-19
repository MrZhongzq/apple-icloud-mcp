import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer as createNodeServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { createAdminRouter } from '../../../src/server/admin.js';
import { createAuthStore, type AuthStore } from '../../../src/auth/store.js';
import { hashPassword } from '../../../src/auth/crypto.js';
import { createLogger } from '../../../src/core/logger.js';

/**
 * 管理页：真实 AuthStore（临时目录）+ 真实端口，只把 httpApp 交进来的两个回调换成 vi.fn()。
 * 这两个回调各自的行为（吊销、销毁会话、关 transport）由 http-e2e 覆盖；这里只关心管理页
 * 有没有在该调用的时候调用它们、在不该调用的时候不调用。
 */

const logger = createLogger('error', () => {});
const ADMIN_PASSWORD = 'admin-test-password';
// scrypt 一次约百毫秒，整个文件共用一个哈希。
const ADMIN_PASSWORD_HASH = hashPassword(ADMIN_PASSWORD);
const PUBLIC_URL = new URL('http://127.0.0.1:19999');
const ORIGIN = PUBLIC_URL.origin;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface AdminServer {
  base: string;
  store: AuthStore;
  cutOffAccessKey: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
  onEnvAccountsDisabled: ReturnType<typeof vi.fn<() => Promise<void>>>;
  close: () => Promise<void>;
}

async function startAdmin(options: { now?: () => number; envelopePublicKey?: string } = {}): Promise<AdminServer> {
  const dir = mkdtempSync(join(tmpdir(), 'admin-'));
  dirs.push(dir);
  const store = createAuthStore({ path: join(dir, 'tokens.json.enc'), key: randomBytes(32), logger });
  await store.load();

  const cutOffAccessKey = vi.fn<(id: string) => Promise<void>>(async () => {});
  const onEnvAccountsDisabled = vi.fn<() => Promise<void>>(async () => {});

  const app = express();
  app.use(
    createAdminRouter({
      adminPasswordHash: ADMIN_PASSWORD_HASH,
      store,
      publicUrl: PUBLIC_URL,
      logger,
      cutOffAccessKey,
      onEnvAccountsDisabled,
      envAccountCount: 2,
      envelopePublicKey: options.envelopePublicKey,
      now: options.now,
    }),
  );
  const server = createNodeServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    base: `http://127.0.0.1:${port}`,
    store,
    cutOffAccessKey,
    onEnvAccountsDisabled,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function post(
  base: string,
  path: string,
  fields: Record<string, string>,
  opts: { cookie?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

function get(base: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: cookie !== undefined ? { cookie } : {},
    redirect: 'manual',
  });
}

/** 用正确口令登录，返回可以直接放进 Cookie 头的 `amcp_admin=...`。 */
async function login(base: string): Promise<string> {
  const res = await post(base, '/admin/login', { password: ADMIN_PASSWORD });
  expect(res.status, '正确口令登录').toBe(303);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) throw new Error('login did not set a cookie');
  return setCookie.split(';')[0] as string;
}

describe('admin page', () => {
  it('GET /admin without a session shows the login form, never key data', async () => {
    const s = await startAdmin();
    try {
      const { plaintext } = await s.store.createAccessKey('secret-person');
      const res = await get(s.base, '/admin');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('action="/admin/login"');
      expect(html).toContain('name="password"');
      expect(html).not.toContain('secret-person');
      expect(html).not.toContain(plaintext);
      expect(html).not.toContain('<script');
    } finally {
      await s.close();
    }
  });

  it('wrong admin password is rejected, right one sets an HttpOnly SameSite=Strict cookie scoped to /admin', async () => {
    const s = await startAdmin();
    try {
      const wrong = await post(s.base, '/admin/login', { password: 'not-the-password' });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get('set-cookie')).toBeNull();
      expect(await wrong.text()).toContain('action="/admin/login"');

      const right = await post(s.base, '/admin/login', { password: ADMIN_PASSWORD });
      expect(right.status).toBe(303);
      expect(right.headers.get('location')).toBe('/admin');
      const setCookie = right.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/^amcp_admin=[A-Za-z0-9_-]{43};/);
      expect(setCookie).toContain('Path=/admin');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      // PUBLIC_URL 是 http，不加 Secure（否则本地开发时浏览器根本不回传这个 cookie）。
      expect(setCookie).not.toContain('Secure');

      const cookie = setCookie.split(';')[0] as string;
      const dash = await get(s.base, '/admin', cookie);
      expect(dash.status).toBe(200);
      expect(await dash.text()).toContain('action="/admin/keys"');
    } finally {
      await s.close();
    }
  });

  it('admin login is rate limited like /access-login (20 per window)', async () => {
    const s = await startAdmin();
    try {
      for (let i = 0; i < 20; i += 1) {
        expect((await post(s.base, '/admin/login', { password: 'wrong' })).status).toBe(401);
      }
      const limited = await post(s.base, '/admin/login', { password: ADMIN_PASSWORD });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('set-cookie')).toBeNull();
    } finally {
      await s.close();
    }
  }, 30_000);

  it('POST without a matching Origin is 403 even with a valid cookie', async () => {
    const s = await startAdmin();
    try {
      const cookie = await login(s.base);

      for (const origin of [null, 'https://evil.example']) {
        const create = await post(s.base, '/admin/keys', { name: 'x' }, { cookie, origin });
        expect(create.status, `origin=${String(origin)}`).toBe(403);
        const loginRes = await post(s.base, '/admin/login', { password: ADMIN_PASSWORD }, { origin });
        expect(loginRes.status, `login origin=${String(origin)}`).toBe(403);
        expect(loginRes.headers.get('set-cookie')).toBeNull();
      }
      expect(s.store.listAccessKeys()).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('a non-login POST without a session redirects to /admin and changes nothing', async () => {
    const s = await startAdmin();
    try {
      const res = await post(s.base, '/admin/keys', { name: 'x' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/admin');
      expect(s.store.listAccessKeys()).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('creating a key shows the plaintext once and the dashboard lists it afterwards without it', async () => {
    const s = await startAdmin();
    try {
      const cookie = await login(s.base);
      const res = await post(s.base, '/admin/keys', { name: '  alice  ' }, { cookie });
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      const html = await res.text();
      const match = /amk_[A-Za-z0-9_-]{43}/.exec(html);
      expect(match, '新建响应里含明文').not.toBeNull();
      const plaintext = (match as RegExpExecArray)[0];
      expect(s.store.findAccessKeyByPlaintext(plaintext)?.name).toBe('alice');

      const after = await (await get(s.base, '/admin', cookie)).text();
      expect(after).toContain('alice');
      expect(after).not.toContain(plaintext);
      expect(after).not.toContain('amk_');
      expect(after).toContain('从未');
    } finally {
      await s.close();
    }
  });

  it('rejects key names that are empty after trimming or longer than 64 characters', async () => {
    const s = await startAdmin();
    try {
      const cookie = await login(s.base);
      expect((await post(s.base, '/admin/keys', { name: '   ' }, { cookie })).status).toBe(400);
      expect((await post(s.base, '/admin/keys', { name: 'a'.repeat(65) }, { cookie })).status).toBe(400);
      expect(s.store.listAccessKeys()).toHaveLength(0);
      expect((await post(s.base, '/admin/keys', { name: 'a'.repeat(64) }, { cookie })).status).toBe(200);
      expect(s.store.listAccessKeys()).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('key names are HTML-escaped', async () => {
    const s = await startAdmin();
    try {
      const cookie = await login(s.base);
      const created = await (await post(s.base, '/admin/keys', { name: '<script>x</script>' }, { cookie })).text();
      expect(created).toContain('&lt;script&gt;');
      expect(created).not.toContain('<script');
      const html = await (await get(s.base, '/admin', cookie)).text();
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
      expect(html).not.toContain('<script');
    } finally {
      await s.close();
    }
  });

  it('disable calls cutOffAccessKey and the row shows 已停用', async () => {
    const s = await startAdmin();
    try {
      const cookie = await login(s.base);
      const { record } = await s.store.createAccessKey('bob');

      const res = await post(s.base, `/admin/keys/${record.id}/disable`, {}, { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/admin');
      expect(s.store.getAccessKey(record.id)?.enabled).toBe(false);
      expect(s.cutOffAccessKey).toHaveBeenCalledTimes(1);
      expect(s.cutOffAccessKey).toHaveBeenCalledWith(record.id);

      const html = await (await get(s.base, '/admin', cookie)).text();
      expect(html).toContain('已停用');

      const enable = await post(s.base, `/admin/keys/${record.id}/enable`, {}, { cookie });
      expect(enable.status).toBe(303);
      expect(s.store.getAccessKey(record.id)?.enabled).toBe(true);
      expect(s.cutOffAccessKey).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it('destroy requires the confirm POST and removes the row', async () => {
    const s = await startAdmin();
    try {
      const cookie = await login(s.base);
      const { record } = await s.store.createAccessKey('carol');

      const confirm = await get(s.base, `/admin/keys/${record.id}/destroy`, cookie);
      expect(confirm.status).toBe(200);
      const confirmHtml = await confirm.text();
      expect(confirmHtml).toContain('carol');
      expect(confirmHtml).toContain(`action="/admin/keys/${record.id}/destroy"`);
      expect(confirmHtml).not.toContain('<script');
      // 只看确认页不删任何东西
      expect(s.store.getAccessKey(record.id)).toBeDefined();
      expect(s.cutOffAccessKey).not.toHaveBeenCalled();

      const res = await post(s.base, `/admin/keys/${record.id}/destroy`, {}, { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/admin');
      expect(s.cutOffAccessKey).toHaveBeenCalledWith(record.id);
      expect(s.store.getAccessKey(record.id)).toBeUndefined();

      const html = await (await get(s.base, '/admin', cookie)).text();
      expect(html).not.toContain('carol');
    } finally {
      await s.close();
    }
  });

  it('turning env accounts off calls onEnvAccountsDisabled; turning on does not', async () => {
    const s = await startAdmin();
    try {
      const cookie = await login(s.base);
      const dash = await (await get(s.base, '/admin', cookie)).text();
      expect(dash).toContain('打开后，任何一把有效的访问密钥都能登录服务器 .env 里配置的 2 个账号。');

      const on = await post(s.base, '/admin/settings/env-accounts', { enabled: 'true' }, { cookie });
      expect(on.status).toBe(303);
      expect(s.store.getSettings().envAccountsEnabled).toBe(true);
      expect(s.onEnvAccountsDisabled).not.toHaveBeenCalled();

      const off = await post(s.base, '/admin/settings/env-accounts', { enabled: 'false' }, { cookie });
      expect(off.status).toBe(303);
      expect(s.store.getSettings().envAccountsEnabled).toBe(false);
      expect(s.onEnvAccountsDisabled).toHaveBeenCalledTimes(1);

      // 本来就是关的，再关一次不算"从 true 改为 false"
      await post(s.base, '/admin/settings/env-accounts', { enabled: 'false' }, { cookie });
      expect(s.onEnvAccountsDisabled).toHaveBeenCalledTimes(1);

      const bad = await post(s.base, '/admin/settings/env-accounts', { enabled: 'yes' }, { cookie });
      expect(bad.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('shows the envelope public key only when one is configured', async () => {
    const withKey = await startAdmin({ envelopePublicKey: 'amp1_testpublickey' });
    try {
      const cookie = await login(withKey.base);
      const html = await (await get(withKey.base, '/admin', cookie)).text();
      expect(html).toContain('amp1_testpublickey');
      expect(html).toContain('把这一行发给使用者，写进他的 MCP_ENVELOPE_PUBKEY。');
    } finally {
      await withKey.close();
    }
    const without = await startAdmin();
    try {
      const cookie = await login(without.base);
      const html = await (await get(without.base, '/admin', cookie)).text();
      expect(html).not.toContain('MCP_ENVELOPE_PUBKEY');
    } finally {
      await without.close();
    }
  });

  it('admin session expires after 30 idle minutes', async () => {
    let t = 1_000_000;
    const s = await startAdmin({ now: () => t });
    try {
      const cookie = await login(s.base);
      // 29 分钟后还活着，而且这次访问刷新了空闲计时
      t += 29 * 60_000;
      expect(await (await get(s.base, '/admin', cookie)).text()).toContain('action="/admin/keys"');
      t += 29 * 60_000;
      expect(await (await get(s.base, '/admin', cookie)).text()).toContain('action="/admin/keys"');
      // 再空闲 30 分钟出头：过期，回到登录页，POST 也不再被接受
      t += 30 * 60_000 + 1;
      const html = await (await get(s.base, '/admin', cookie)).text();
      expect(html).toContain('action="/admin/login"');
      expect(html).not.toContain('action="/admin/keys"');
      const res = await post(s.base, '/admin/keys', { name: 'late' }, { cookie });
      expect(res.status).toBe(303);
      expect(s.store.listAccessKeys()).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('logout ends the session', async () => {
    const s = await startAdmin();
    try {
      const cookie = await login(s.base);
      const res = await post(s.base, '/admin/logout', {}, { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
      const html = await (await get(s.base, '/admin', cookie)).text();
      expect(html).toContain('action="/admin/login"');
    } finally {
      await s.close();
    }
  });

  it("/admin responses carry no-store and frame-ancestors 'none'", async () => {
    const s = await startAdmin();
    try {
      const cookie = await login(s.base);
      const { record } = await s.store.createAccessKey('dave');
      const responses = [
        await get(s.base, '/admin'),
        await get(s.base, '/admin', cookie),
        await post(s.base, '/admin/login', { password: 'wrong' }),
        await post(s.base, '/admin/keys', { name: 'eve' }, { cookie }),
        await post(s.base, '/admin/keys', { name: 'x' }, { cookie, origin: null }),
        await get(s.base, `/admin/keys/${record.id}/destroy`, cookie),
        await post(s.base, `/admin/keys/${record.id}/disable`, {}, { cookie }),
      ];
      for (const res of responses) {
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      }
    } finally {
      await s.close();
    }
  });
});
