import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  endpointFiles, canUseUnixSocket, writeEndpoint, readEndpoint, clearEndpoint,
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

  it('writes the endpoint file 0600, since it carries the tcp token', async () => {
    await writeEndpoint(files, { kind: 'tcp', port: 1, token: 'sekrit' });
    if (process.platform === 'win32') {
      // Windows 上 POSIX 权限位无意义，这里只断言文件存在；真正的检查在 WSL/Linux 上跑
      expect(existsSync(files.infoPath)).toBe(true);
      return;
    }
    const mode = statSync(files.infoPath).mode & 0o777;
    expect(mode, '端点文件里有 TCP 令牌，权限放宽等于把会话交出去').toBe(0o600);
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
      // 一个不带用户区分的固定名字在共享 /tmp 上是可预测、可被别的用户抢先
      // 创建并占有的路径——见 transport.ts 里 ensureOwnedDir 的注释。这里
      // 只断言"目录名不是那个裸的固定名字"，具体用什么区分符（uid 还是
      // 用户名）留给实现，不在这里锁死。
      expect(dirName, '默认运行时目录名不应该是一个所有用户共享的固定名字').not.toBe('apple-icloud-mcp-cli');
      expect(dirName.startsWith('apple-icloud-mcp-cli')).toBe(true);
    } finally {
      if (prev !== undefined) process.env.MCP_CLI_RUNTIME_DIR = prev;
    }
  });
});

describe('运行时目录权限', () => {
  it.skipIf(process.platform === 'win32')(
    'creates the runtime dir 0700, not the OS default',
    async () => {
      await writeEndpoint(files, { kind: 'unix', path: files.socketPath });
      const mode = statSync(dirname(files.infoPath)).mode & 0o777;
      expect(mode, '运行时目录必须是 0700——它是 endpoint.json 的父目录，目录权限不够，chmod 600 单独也挡不住同机的其他用户遍历进来').toBe(0o700);
    },
  );

  it('writeEndpoint succeeds against a freshly-created runtime dir on every platform', async () => {
    // Windows 上没有 process.getuid，owner 校验直接放行；这里确认无论平台，
    // writeEndpoint 在一个全新目录上都能正常工作，不会因为缺了 uid 概念而抛。
    await expect(writeEndpoint(files, { kind: 'unix', path: files.socketPath })).resolves.toBeUndefined();
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
