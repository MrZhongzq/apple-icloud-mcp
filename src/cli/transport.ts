import { mkdtempSync, lstatSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { AppError } from '../core/errors.js';

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

/** 当前用户在文件系统上的稳定标识，用来把运行时目录和别的用户隔开。 */
function currentUserTag(): string {
  const uid = process.getuid?.();
  if (typeof uid === 'number') return String(uid);
  // Windows 没有 uid；用户名是这台机器上仅有的稳定区分符（沙箱策略本身已经
  // 不允许 unix socket/命名管道，见 canUseUnixSocket 的实测，这个平台上
  // 单用户是唯一支持的形态，这里的隔离主要是让目录名不可预测/不跨用户复用）。
  return userInfo().username.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/**
 * 端点文件放在临时目录，随沙盒销毁；可用 MCP_CLI_RUNTIME_DIR 覆盖。
 * 目录名固定（而不是每次都 mkdtemp）——客户端和守护进程必须算出同一个路径
 * 才能互相找到对方，随机后缀行不通；名字里带上当前用户的标识，是因为共享
 * `/tmp` 上一个不带用户区分的固定名字是可预测、可抢先创建的（见 ensureOwnedDir）。
 */
export function endpointFiles(): EndpointFiles {
  const override = process.env.MCP_CLI_RUNTIME_DIR;
  const base = override && override.length > 0 ? override : join(tmpdir(), `apple-icloud-mcp-cli-${currentUserTag()}`);
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

/**
 * 建目录（0700）并确认它真的归当前用户所有，已存在但属于别人时拒绝往下走。
 * 0700 单独就足以关掉两类问题：unix socket 在 `listen`→`chmod` 之间那扇短暂
 * 敞开的窗口（父目录不允许别人遍历，chmod 之前谁都进不来），以及往
 * `endpoint.json` 里放置符号链接偷读 TCP 令牌的招数（写入需要目录写权限）。
 * 但 0700 挡不住"目录在我们创建之前就已经被别人建好"这种情形——共享 `/tmp`
 * 通常设了 sticky bit，只挡删除/重命名别人的文件，不挡创建新文件/目录，所以
 * 攻击者完全可以抢先建出这个路径、自己拥有它、模式也设成 0700，等着受害者
 * 把令牌写进来。`mkdir(..., { recursive: true })` 对已存在的目录是空操作，
 * 不会去检查所有者——这正是需要显式校验的原因。
 */
async function ensureOwnedDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  assertOwnedByCurrentUser(dir);
}

/** Windows 没有 uid 概念，这条检查在该平台上没有对应物，直接放行。 */
function assertOwnedByCurrentUser(dir: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    // 目录访问不到：后续的读/写操作自己会失败并报出更具体的错误，这里不重复。
    return;
  }
  if (stat.uid !== uid) {
    throw new AppError('PERMISSION_DENIED', `运行时目录 ${dir} 属于另一个用户，拒绝使用`, {
      hint: '删除该目录，或设置 MCP_CLI_RUNTIME_DIR 指向一个你自己拥有的路径',
    });
  }
}

/** ownerId 是 `writeEndpoint` 可选写入的额外字段，`Endpoint` 本身的公开形状不受影响。 */
export async function writeEndpoint(files: EndpointFiles, ep: Endpoint, ownerId?: string): Promise<void> {
  await ensureOwnedDir(dirname(files.infoPath));
  const record: Record<string, unknown> = ownerId === undefined ? { ...ep } : { ...ep, ownerId };
  // 0600：unix 模式下文件本身不带敏感数据，但 TCP 模式下带着令牌——两种模式
  // 统一按最严格的权限写，不看 kind 分叉，免得以后加字段时漏改。父目录本身
  // 已经是 0700（见 ensureOwnedDir），这里是纵深防御，不是唯一的一道门。
  await writeFile(files.infoPath, JSON.stringify(record), { mode: 0o600 });
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export async function readEndpoint(files: EndpointFiles): Promise<Endpoint | undefined> {
  // 目录不存在时这里静默放行（下面的 readFile 会以 ENOENT 收场，走既有的
  // "没有端点文件"分支）；目录存在但归属不对，则必须响亮地拒绝，而不是把
  // 里面可能是攻击者布置的 endpoint.json 当真——那样我们会连到攻击者的
  // 监听者，把真实的工具调用参数（包括 mail_send 的正文）发给他们。
  assertOwnedByCurrentUser(dirname(files.infoPath));

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
      if (obj.kind === 'tcp' && isValidPort(obj.port) && typeof obj.token === 'string') {
        return { kind: 'tcp', port: obj.port, token: obj.token };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 端点文件里 `ownerId` 那部分，`readEndpoint` 不会把它暴露在公开的 `Endpoint`
 * 形状里——只有 daemon 自己在决定"这份端点文件还是不是我写的那份"时才需要它
 * （见 daemon.ts 的 shutdown）。
 */
export async function readEndpointOwner(files: EndpointFiles): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(files.infoPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'ownerId' in parsed) {
      const value = (parsed as Record<string, unknown>).ownerId;
      return typeof value === 'string' ? value : undefined;
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
 * 一个 daemon 实例的随机身份，写进端点文件里 `Endpoint` 类型之外的一个字段。
 * 两个 `cli start` 竞态时，后起的那个会覆盖前一个的端点文件；没有这个字段，
 * 15 分钟后前一个（此时已经是孤儿）的空闲计时器一样会触发 `clearEndpoint`，
 * 删掉的却是后起、仍然活着的那个 daemon 的端点——`shutdown` 必须先确认端点
 * 文件里的身份还是自己写的那个，才能真的删（daemon.ts）。
 */
export function generateOwnerId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 保留的工具名，daemon 收到它时不查工具表，直接关停自己。放在 transport.ts
 * 而不是 daemon.ts / client.ts 任一方，是因为两边都要用同一个字面量——
 * 各写一份迟早会有一边改了名字另一边忘记跟着改。
 */
export const DAEMON_STOP_COMMAND = '__cli_daemon_stop__';

/**
 * `cli start` detach 出来的子进程内部标记，不是用户命令：父进程 spawn 一个
 * `node <script> __cli_daemon_run__` 的子进程，子进程看到这个标记就直接
 * `startDaemon` 并常驻，不走一次性分派那条路。放在 transport.ts 而不是
 * bin/cli.ts 内部，是因为父子两个进程用的是同一份 bin/cli.ts 代码——
 * 都得认得同一个字面量。
 */
export const DAEMON_RUN_MARKER = '__cli_daemon_run__';
