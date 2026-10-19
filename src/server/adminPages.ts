import { escapeHtml } from '../auth/login.js';
import type { AccessKeyRecord } from '../auth/store.js';

/**
 * 管理页 `/admin` 的纯渲染函数：只拼字符串，不碰 store、不碰请求。
 *
 * 规则与授权登录页（auth/login.ts::renderLoginPage）相同：任何插值都经过 escapeHtml，
 * 页面上不出现任何 `<script>`——确认、切换都是普通表单提交，由服务端渲染结果页。
 */

const STYLE =
  'body{font-family:system-ui,-apple-system,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem;color:#111}' +
  'h1{font-size:1.25rem}' +
  'h2{font-size:1.05rem;margin-top:2rem}' +
  '.error{color:#b00020;background:#fdecea;padding:0.5rem 0.75rem;border-radius:4px}' +
  '.notice{background:#eef6ee;padding:0.75rem;border-radius:4px}' +
  '.hint{color:#555;font-size:0.9rem}' +
  'code{font-family:ui-monospace,monospace;word-break:break-all}' +
  'table{border-collapse:collapse;width:100%}' +
  'th,td{text-align:left;padding:0.4rem 0.5rem;border-bottom:1px solid #ddd;vertical-align:top}' +
  'form.inline{display:inline}' +
  'label{display:block;margin-top:1rem;font-weight:600}' +
  'input[type="password"],input[type="text"]{width:100%;box-sizing:border-box;padding:0.5rem;font-size:1rem;margin-top:0.25rem}' +
  'button{padding:0.4rem 0.8rem;font-size:0.95rem;cursor:pointer}';

function layout(title: string, body: string): string {
  return (
    '<!doctype html>' +
    '<html lang="zh">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>' + STYLE + '</style>' +
    '</head>' +
    '<body>' +
    body +
    '</body>' +
    '</html>'
  );
}

function errorBlock(error: string | undefined): string {
  return error !== undefined ? '<p class="error" role="alert">' + escapeHtml(error) + '</p>' : '';
}

/** 毫秒时间戳 → ISO 字符串加 UTC 标注。刻意不用 toLocaleString：那个结果取决于服务器进程
 *  的时区和语言环境，同一条记录换一台机器看就成了另一个时刻。 */
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') + ' UTC';
}

/** URL 路径里的密钥 id：先按 URL 编码，再按 HTML 转义放进属性。id 本身是十六进制，
 *  两步都是纵深防御，不是因为现在的 id 需要。 */
function keyPath(id: string, action: 'disable' | 'enable' | 'destroy'): string {
  return escapeHtml('/admin/keys/' + encodeURIComponent(id) + '/' + action);
}

export function renderAdminLoginPage(params: { error?: string } = {}): string {
  return layout(
    '管理页登录',
    '<h1>管理页登录</h1>' +
      errorBlock(params.error) +
      '<form method="post" action="/admin/login">' +
      '<label for="password">管理员口令</label>' +
      '<input type="password" id="password" name="password" autocomplete="current-password" required autofocus>' +
      '<p><button type="submit">登录</button></p>' +
      '</form>',
  );
}

export interface DashboardParams {
  keys: readonly AccessKeyRecord[];
  envAccountsEnabled: boolean;
  envAccountCount: number;
  envelopePublicKey?: string;
  /** 刚建好的那把密钥。只在新建请求的那一次响应里传——这是明文唯一一次离开服务端。 */
  created?: { name: string; plaintext: string };
  error?: string;
}

function renderKeyRow(key: AccessKeyRecord): string {
  const toggle = key.enabled
    ? '<form class="inline" method="post" action="' + keyPath(key.id, 'disable') + '">' +
      '<button type="submit">停用</button></form>'
    : '<form class="inline" method="post" action="' + keyPath(key.id, 'enable') + '">' +
      '<button type="submit">启用</button></form>';
  return (
    '<tr>' +
    '<td>' + escapeHtml(key.name) + '</td>' +
    '<td>' + escapeHtml(formatUtc(key.created_at)) + '</td>' +
    '<td>' + (key.enabled ? '启用' : '已停用') + '</td>' +
    '<td>' + (key.last_used_at !== undefined ? escapeHtml(formatUtc(key.last_used_at)) : '从未') + '</td>' +
    '<td>' + toggle + ' <a href="' + keyPath(key.id, 'destroy') + '">销毁</a></td>' +
    '</tr>'
  );
}

export function renderAdminDashboard(params: DashboardParams): string {
  const createdHtml =
    params.created !== undefined
      ? '<div class="notice" role="status">' +
        '<p>已为「' + escapeHtml(params.created.name) + '」新建访问密钥。明文<strong>只显示这一次</strong>，' +
        '离开此页就再也看不到，请现在复制给对方：</p>' +
        '<p><code>' + escapeHtml(params.created.plaintext) + '</code></p>' +
        '</div>'
      : '';

  const tableHtml =
    params.keys.length === 0
      ? '<p class="hint">还没有任何访问密钥。</p>'
      : '<table>' +
        '<thead><tr><th>名字</th><th>创建时间</th><th>状态</th><th>上次使用</th><th>操作</th></tr></thead>' +
        '<tbody>' + params.keys.map(renderKeyRow).join('') + '</tbody>' +
        '</table>';

  const envHtml =
    '<h2>.env 账号</h2>' +
    '<p>当前：' + (params.envAccountsEnabled ? '已打开' : '已关闭') + '</p>' +
    '<p class="hint">' +
    escapeHtml(`打开后，任何一把有效的访问密钥都能登录服务器 .env 里配置的 ${params.envAccountCount} 个账号。`) +
    '</p>' +
    '<form method="post" action="/admin/settings/env-accounts">' +
    '<input type="hidden" name="enabled" value="' + (params.envAccountsEnabled ? 'false' : 'true') + '">' +
    '<button type="submit">' + (params.envAccountsEnabled ? '关闭' : '打开') + '</button>' +
    '</form>';

  const pubkeyHtml =
    params.envelopePublicKey !== undefined
      ? '<h2>信封公钥</h2>' +
        '<p><code>' + escapeHtml(params.envelopePublicKey) + '</code></p>' +
        '<p class="hint">把这一行发给使用者，写进他的 MCP_ENVELOPE_PUBKEY。</p>'
      : '';

  return layout(
    '访问密钥管理',
    '<h1>访问密钥管理</h1>' +
      '<form method="post" action="/admin/logout"><button type="submit">退出登录</button></form>' +
      errorBlock(params.error) +
      createdHtml +
      '<h2>访问密钥</h2>' +
      tableHtml +
      '<h2>新建访问密钥</h2>' +
      '<form method="post" action="/admin/keys">' +
      '<label for="name">名字（1–64 个字符，只用来区分是谁的）</label>' +
      '<input type="text" id="name" name="name" maxlength="64" required autocomplete="off">' +
      '<p><button type="submit">新建</button></p>' +
      '</form>' +
      envHtml +
      pubkeyHtml,
  );
}

/** 销毁前的确认页：二次确认由服务端渲染，不用浏览器的 confirm()（页面上没有脚本）。 */
export function renderDestroyConfirmPage(key: AccessKeyRecord): string {
  return layout(
    '确认销毁访问密钥',
    '<h1>确认销毁访问密钥</h1>' +
      '<p>要销毁「' + escapeHtml(key.name) + '」吗？它名下已授权的连接会立刻断开，' +
      '用这把密钥的人需要你另发一把新的才能再连接。此操作不能撤销。</p>' +
      '<form method="post" action="' + keyPath(key.id, 'destroy') + '">' +
      '<button type="submit">确认销毁</button> <a href="/admin">取消</a>' +
      '</form>',
  );
}

/** 403 / 404 等终态页：一句话加一个回到面板的链接。 */
export function renderAdminMessagePage(title: string, message: string): string {
  return layout(
    title,
    '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(message) + '</p><p><a href="/admin">返回管理页</a></p>',
  );
}
