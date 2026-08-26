import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import {
  endpointFiles, canUseUnixSocket, writeEndpoint, readEndpoint, clearEndpoint, ensureOwnedDir, configFingerprint,
} from '../../../src/cli/transport.js';

let dir: string;
let files: ReturnType<typeof endpointFiles>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-ep-'));
  files = { infoPath: join(dir, 'endpoint.json'), socketPath: join(dir, 'cli.sock') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('endpoint file', () => {
  it('round-trips a unix endpoint', async () => {
    await writeEndpoint(files, { kind: 'unix', path: files.socketPath });
    expect(await readEndpoint(files)).toEqual({ kind: 'unix', path: files.socketPath });
  });

  it('round-trips a tcp endpoint with its token', async () => {
    await writeEndpoint(files, { kind: 'tcp', port: 12345, token: 'sekrit' });
    expect(await readEndpoint(files)).toEqual({ kind: 'tcp', port: 12345, token: 'sekrit' });
  });

  // 这条曾经写成"win32 就在函数体里 expect(existsSync).toBe(true) 然后 return"。
  // 两个问题：函数体内提前 return 会被 runner 报成**通过**而不是跳过（本阶段
  // 因此明令禁止这种写法），而那半个断言在 mode 是 0666 时同样成立——也就是
  // 在 Windows 上这条测试的名字不是它检查的东西。改成 skipIf + 写进名字的原因。
  const modeSkipReason =
    process.platform === 'win32'
      ? '（在 win32 上跳过：Node 在这个平台上只把 mode 映射成只读属性，0600 无从验证；真正的检查在 WSL/Linux 上跑）'
      : '';
  it.skipIf(process.platform === 'win32')(
    'writes the endpoint file 0600, since it carries the tcp token' + modeSkipReason,
    async () => {
      await writeEndpoint(files, { kind: 'tcp', port: 1, token: 'sekrit' });
      const mode = statSync(files.infoPath).mode & 0o777;
      expect(mode, '端点文件里有 TCP 令牌，权限放宽等于把会话交出去').toBe(0o600);
    },
  );

  it('writes the endpoint file on every platform, whatever the mode means there', async () => {
    await writeEndpoint(files, { kind: 'tcp', port: 1, token: 'sekrit' });
    expect(existsSync(files.infoPath)).toBe(true);
  });

  it('returns undefined when there is no endpoint file', async () => {
    expect(await readEndpoint(files)).toBeUndefined();
  });

  it('returns undefined rather than throwing on a corrupted endpoint file', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(files.infoPath, 'not json', 'utf8');
    expect(await readEndpoint(files)).toBeUndefined();
  });

  it('clears both the info file and the socket file', async () => {
    await writeEndpoint(files, { kind: 'unix', path: files.socketPath });
    // 之前这条测试从没真的建过 socketPath 这个文件，所以它对 clearEndpoint
    // 是否真的清掉了 socket 文件这半个承诺完全没有约束力——删掉
    // `clearEndpoint` 里 `rm(files.socketPath, ...)` 那一行，这条测试照样
    // 全绿。这里先建一个真实文件占住那个路径，再断言它被清掉。
    writeFileSync(files.socketPath, '');
    await clearEndpoint(files);
    expect(existsSync(files.infoPath), '端点描述文件应当被清掉').toBe(false);
    expect(existsSync(files.socketPath), 'socket 文件也应当被清掉，不只是描述文件').toBe(false);
  });

  it('rejects an out-of-range port instead of handing it to net.connect', async () => {
    // net.connect 对越界端口（比如 70000、-1、1.5）是同步抛 ERR_SOCKET_BAD_PORT，
    // 不是走一贯的异步 'error'——一份被手改/损坏成这样的端点文件，如果
    // readEndpoint 原样放行，会让调用方在完全没有防备的地方炸掉。
    writeFileSync(files.infoPath, JSON.stringify({ kind: 'tcp', port: 70000, token: 'x' }), 'utf8');
    expect(await readEndpoint(files), '端口越界应当和其它损坏形状一样被当成"没有可用端点"').toBeUndefined();
  });
});

describe('endpointFiles', () => {
  it('honours MCP_CLI_RUNTIME_DIR so a sandbox can pin the location', () => {
    const prev = process.env.MCP_CLI_RUNTIME_DIR;
    process.env.MCP_CLI_RUNTIME_DIR = dir;
    try {
      const f = endpointFiles();
      expect(f.infoPath.startsWith(dir)).toBe(true);
      expect(f.socketPath.startsWith(dir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MCP_CLI_RUNTIME_DIR;
      else process.env.MCP_CLI_RUNTIME_DIR = prev;
    }
  });

  it('falls back to the OS temp dir', () => {
    const prev = process.env.MCP_CLI_RUNTIME_DIR;
    delete process.env.MCP_CLI_RUNTIME_DIR;
    try {
      expect(endpointFiles().infoPath.length).toBeGreaterThan(0);
    } finally {
      if (prev !== undefined) process.env.MCP_CLI_RUNTIME_DIR = prev;
    }
  });

  it('the default runtime dir path is tagged with the current user, not a fixed shared name', () => {
    const prev = process.env.MCP_CLI_RUNTIME_DIR;
    delete process.env.MCP_CLI_RUNTIME_DIR;
    try {
      const dirName = dirname(endpointFiles().infoPath).split(/[\\/]/).pop() ?? '';
      // 正向断言，不是“不等于裸名字、且以它开头”：一个退化成永远返回空
      // 字符串的 currentUserTag() 会让目录名变成 "apple-icloud-mcp-cli-"——
      // 依然不等于裸名字、依然以它开头，之前这两条断言会全部
      // 通过，却照样把机器上所有用户折叠回同一个共享路径，
      // 这正是 F-3 要防的后果本身。这里用同样的公开
      // API（process.getuid / os.userInfo().username）独立算出期望的标签，
      // 断言目录名后缀真的是它。
      const expectedTag =
        typeof process.getuid === 'function'
          ? String(process.getuid())
          : userInfo().username.replace(/[^a-zA-Z0-9_.-]/g, '_');
      expect(expectedTag.length, '这条测试自己算出的标签不能是空的，否则测试本身就测不出任何东西').toBeGreaterThan(0);
      expect(dirName, '运行时目录名必须真的带上当前用户的标识，不能只是长得像').toBe(
        `apple-icloud-mcp-cli-${expectedTag}`,
      );
    } finally {
      if (prev !== undefined) process.env.MCP_CLI_RUNTIME_DIR = prev;
    }
  });
});

describe('运行时目录权限', () => {
  // vitest 的 it.skipIf 本身不带"打印原因"的参数，这里把原因直接写进测试名——
  // 跳过的这条在报告里应该看得出"为什么"、以及"这个属性其实在别处被验证过
  // （daemon.test.ts 里 startDaemon 那条真正跑起 daemon 的用例）"，而不是一行
  // 光秃秃的 "1 skipped"。
  //
  // 这条测的是 writeEndpoint 自己的目录准备逻辑（ensureOwnedDir），不是
  // startDaemon 实际启动 daemon 时那条独立的 mkdir 调用——那条单独在
  // daemon.test.ts 的 "runtime dir permissions (N-1)" 里用 startDaemon 覆盖，
  // 因为 N-1 这个回归恰恰是"两处 mkdir 没对齐"：daemon.ts 自己那次 mkdir
  // 没带 mode，只有 writeEndpoint 这条带；只测这一条不会抓到那个回归。
  const skipReason =
    process.platform === 'win32'
      ? '（在 win32 上跳过：POSIX 权限位在这个平台上没有意义；在 WSL/Linux 上验证，见下方 it 与 daemon.test.ts 的对应用例）'
      : '';
  it.skipIf(process.platform === 'win32')('writeEndpoint creates the runtime dir 0700, not the OS default' + skipReason, async () => {
    // `dir`（beforeEach 里 mkdtempSync 建出来的）本身默认就是 0700——如果
    // 直接用 files（父目录就是 dir），writeEndpoint 面对的是一个已经存在、
    // 模式凑巧也是 0700 的目录，ensureOwnedDir 的 mkdir 对它是空操作，这条
    // 断言即使在 ensureOwnedDir 完全不设 mode 的情况下也会通过（验证过：
    // 去掉 transport.ts 里那个 mode: 0o700，这条测试原样全绿）。必须指向
    // dir 底下一个还不存在的子目录，让创建动作、连同它的权限，真的由
    // writeEndpoint 自己决定。
    const freshDir = join(dir, 'not-yet-created');
    const freshFiles = { infoPath: join(freshDir, 'endpoint.json'), socketPath: join(freshDir, 'cli.sock') };
    await writeEndpoint(freshFiles, { kind: 'unix', path: freshFiles.socketPath });
    const mode = statSync(freshDir).mode & 0o777;
    expect(mode, '运行时目录必须是 0700——它是 endpoint.json 的父目录，目录权限不够，chmod 600 单独也挡不住同机的其他用户遍历进来').toBe(0o700);
  });

  const existingSkipReason =
    process.platform === 'win32'
      ? '（在 win32 上跳过：POSIX 权限位在这个平台上没有意义；在 WSL/Linux 上验证）'
      : '';
  it.skipIf(process.platform === 'win32')(
    'tightens a runtime dir that already exists with a looser mode' + existingSkipReason,
    async () => {
      // 上面那条只覆盖"目录还不存在"这一支，而且它自己的注释就点名了另一支的
      // 存在（mkdir 对已存在的目录是空操作）。性质跨两支，测试只盖了眼前这支——
      // 这正是本阶段那份失败形状目录里的第 6 种，而且发生在为修 N-1 而写的测试里。
      // 触发条件不冷僻：.env.example 建议的 MCP_CLI_RUNTIME_DIR=/var/tmp/... 落在
      // 一个人人可写的 sticky 目录里，很可能早就被建出来了。
      const existing = join(dir, 'already-here');
      mkdirSync(existing, { mode: 0o755 });
      chmodSync(existing, 0o755); // umask 可能让 mkdir 的 mode 不完全生效，显式定一次
      expect(statSync(existing).mode & 0o777, '前提：这个目录一开始不是 0700').not.toBe(0o700);

      await ensureOwnedDir(existing);
      expect(statSync(existing).mode & 0o777, '目录已经存在也必须被收紧到 0700').toBe(0o700);
    },
  );

  const ownerSkipReason =
    process.platform === 'win32'
      ? '（在 win32 上跳过：这个平台没有 uid，assertOwnedByCurrentUser 按设计直接放行——那里靠的是每用户的 %TEMP% ACL）'
      : '';
  it.skipIf(process.platform === 'win32')(
    'refuses a runtime dir owned by another user' + ownerSkipReason,
    async () => {
      // 这条检查是 F-3 装上的四条访问控制性质之一，此前**一个测试都没有**：
      // 把它整个删掉，整个 CLI 套件依然全绿。它挡的是：攻击者在共享 /tmp 里
      // 抢先建出运行时目录、放一份自己的 endpoint.json，于是我们连到他的
      // 监听者，把真实的工具参数（包括 mail_send 的正文）交给他。
      // /tmp 归 root、测试进程不是 root，所以不需要 chown 就能构造。
      await expect(ensureOwnedDir('/tmp')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    },
  );

  it('writeEndpoint succeeds against a freshly-created runtime dir on every platform', async () => {
    // Windows 上没有 process.getuid，owner 校验直接放行；这里确认无论平台，
    // writeEndpoint 在一个全新目录上都能正常工作，不会因为缺了 uid 概念而抛。
    await expect(writeEndpoint(files, { kind: 'unix', path: files.socketPath })).resolves.toBeUndefined();
  });
});

describe('configFingerprint', () => {
  const account = {
    id: 'account_1', label: 'a', email: 'a@icloud.com', sender: 'a@icloud.com', appPassword: 'p1',
    capabilities: {
      mailRead: true, mailWrite: false, calendarRead: true, calendarWrite: false,
      remindersRead: true, remindersWrite: false, contactsRead: true, contactsWrite: false,
    },
  };
  const cfg = (overrides: Record<string, unknown> = {}) =>
    ({
      accounts: [{ ...account, ...overrides }],
      sessionTtlMs: 1, imapIdleTimeoutMs: 1, logLevel: 'error', deprecations: [], notices: [],
    }) as never;

  it('changes when a capability changes', () => {
    const before = configFingerprint(cfg());
    const after = configFingerprint(cfg({ capabilities: { ...account.capabilities, mailWrite: true } }));
    expect(after, '打开 ALLOW_MAIL_WRITE_1 之后守护进程必须被认出是旧的').not.toBe(before);
  });

  it('changes when the app password is rotated', () => {
    expect(configFingerprint(cfg({ appPassword: 'p2' })), '轮换密码后守护进程还在拿旧密码认证').not.toBe(
      configFingerprint(cfg()),
    );
  });

  it('is stable for the same config', () => {
    expect(configFingerprint(cfg())).toBe(configFingerprint(cfg()));
  });

  it('changes when ICLOUD_LABEL_n changes — apple_accounts reports it verbatim', () => {
    expect(configFingerprint(cfg({ label: 'renamed' }))).not.toBe(configFingerprint(cfg()));
  });

  it('is a fixed-width hex digest — the only shape that cannot carry credential material', () => {
    // 早先这里写的是 `expect(fp).not.toContain('super-secret')`。那条断言对
    // **任何**十六进制摘要实现都恒成立——包括一个把明文密码原样拼进材料再
    // 哈希的实现——所以它是装饰，不是保证。真正承担这条性质的是形状断言：
    // 一个会把凭据带出来的实现（比如直接返回拼接后的材料）过不了它。
    expect(configFingerprint(cfg({ appPassword: 'super-secret-value' }))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('canUseUnixSocket', () => {
  it('answers without throwing, whatever the platform', async () => {
    const ok = await canUseUnixSocket();
    expect(typeof ok).toBe('boolean');
    if (process.platform !== 'win32') {
      expect(ok, 'POSIX 平台上 unix socket 应当可用；不可用会静默退到 TCP，那条路径依赖令牌').toBe(true);
    }
  });
});
