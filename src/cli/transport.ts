import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

/**
 * 一个端点：daemon 正在监听的地方。unix 模式下只有一条 socket 路径；
 * TCP 模式下还带一个握手令牌——TCP 端口没有文件权限可依赖，
 * 安全性归结为"能不能读到写着这个令牌的 600 端点文件"。
 */
export type Endpoint = { kind: 'unix'; path: string } | { kind: 'tcp'; port: number; token: string };

export interface EndpointFiles {
  /** 描述当前监听端点的文件；权限 600。 */
  infoPath: string;
  /** unix 模式下的 socket 路径。 */
  socketPath: string;
}

/**
 * 端点文件放在临时目录，随沙盒销毁；可用 MCP_CLI_RUNTIME_DIR 覆盖。
 * 目录用一个固定名字（而不是每次都 mkdtemp）——客户端和守护进程必须算出
 * 同一个路径才能互相找到对方，随机后缀行不通。
 */
export function endpointFiles(): EndpointFiles {
  const base = process.env.MCP_CLI_RUNTIME_DIR && process.env.MCP_CLI_RUNTIME_DIR.length > 0
    ? process.env.MCP_CLI_RUNTIME_DIR
    : join(tmpdir(), 'apple-icloud-mcp-cli');
  return {
    infoPath: join(base, 'endpoint.json'),
    socketPath: join(base, 'cli.sock'),
  };
}

/**
 * 本平台能不能用 unix socket。Windows 沙箱下实测为 EACCES，需要 TCP 兜底。
 * 用一次真实的 listen+connect+close 探测，而不是单看 `process.platform`——
 * 平台判断只是启发式，真正可靠的只有"试一次"。
 */
export function canUseUnixSocket(): Promise<boolean> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-probe-'));
    const path = join(dir, 'probe.sock');
    const server = net.createServer();

    const cleanup = (result: boolean): void => {
      server.close(() => {
        rm(dir, { recursive: true, force: true })
          .catch(() => undefined)
          .finally(() => resolve(result));
      });
    };

    server.once('error', () => cleanup(false));
    server.listen(path, () => {
      const client = net.connect(path);
      client.once('connect', () => {
        client.destroy();
        cleanup(true);
      });
      client.once('error', () => cleanup(false));
    });
  });
}

async function ensureDir(files: EndpointFiles): Promise<void> {
  await mkdir(join(files.infoPath, '..'), { recursive: true });
}

export async function writeEndpoint(files: EndpointFiles, ep: Endpoint): Promise<void> {
  await ensureDir(files);
  // 0600：unix 模式下文件本身不带敏感数据，但 TCP 模式下带着令牌——两种模式
  // 统一按最严格的权限写，不看 kind 分叉，免得以后加字段时漏改。
  await writeFile(files.infoPath, JSON.stringify(ep), { mode: 0o600 });
}

export async function readEndpoint(files: EndpointFiles): Promise<Endpoint | undefined> {
  let text: string;
  try {
    text = await readFile(files.infoPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'kind' in parsed) {
      const obj = parsed as Record<string, unknown>;
      if (obj.kind === 'unix' && typeof obj.path === 'string') {
        return { kind: 'unix', path: obj.path };
      }
      if (obj.kind === 'tcp' && typeof obj.port === 'number' && typeof obj.token === 'string') {
        return { kind: 'tcp', port: obj.port, token: obj.token };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 清掉端点文件与（unix 模式下的）socket 文件。两者都可能不存在，不能因此报错。 */
export async function clearEndpoint(files: EndpointFiles): Promise<void> {
  await rm(files.infoPath, { force: true }).catch(() => undefined);
  await rm(files.socketPath, { force: true }).catch(() => undefined);
}

/** 生成一个 TCP 握手令牌。 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 保留的工具名，daemon 收到它时不查工具表，直接关停自己。放在 transport.ts
 * 而不是 daemon.ts / client.ts 任一方，是因为两边都要用同一个字面量——
 * 各写一份迟早会有一边改了名字另一边忘记跟着改。
 */
export const DAEMON_STOP_COMMAND = '__cli_daemon_stop__';
