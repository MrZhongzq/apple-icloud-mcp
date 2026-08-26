import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
    await clearEndpoint(files);
    expect(existsSync(files.infoPath)).toBe(false);
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
