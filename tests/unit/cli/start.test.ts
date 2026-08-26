import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemonProcess, DEFAULT_START_TIMEOUT_MS } from '../../../src/cli/start.js';
import type { MinimalChildProcess, SpawnFn } from '../../../src/cli/start.js';
import type { EndpointFiles, Endpoint } from '../../../src/cli/transport.js';

/**
 * `startDaemonProcess` 是 `cli start` 真正的实现——单独抽到 `cli/start.ts`
 * 就是为了能像这样直接测：不真的 fork 一个进程（`spawn` 被替换），不真的
 * 轮询文件系统（`waitForDaemonReady` 被替换），所以下面这些用例都在几毫秒
 * 内跑完，不需要真的等 NN-1 之前那个 5 秒超时、或者现在这个 30 秒超时。
 */
class FakeChild extends EventEmitter implements MinimalChildProcess {
  pid = 4242;
  unref(): void {
    // 测试里不需要真的影响事件循环。
  }
}

function fakeSpawn(child: FakeChild): SpawnFn {
  return () => child;
}

/**
 * `startDaemonProcess` 在真的调用 `spawnFn` 之前，还要先 `await
 * ensureOwnedDir(...)`（真实的文件系统操作）——测试如果在调用
 * `startDaemonProcess(...)` 之后立刻同步 `child.emit(...)`，这些事件会打在
 * 一个还没接上 `once('exit')`/`once('error')` 监听器的 EventEmitter 上，
 * 'exit' 静默丢失、'error' 因为没有监听器直接抛出未捕获异常。轮询
 * `listenerCount`，而不是固定 sleep 一段时间——比瞎猜一个"应该够了"的
 * 毫秒数更可靠，也不会为了保险而选一个偏大的固定延迟拖慢测试。
 */
async function waitUntilListening(child: FakeChild, event: 'exit' | 'error'): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (child.listenerCount(event) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`startDaemonProcess never attached a '${event}' listener`);
}

let dir: string;
let files: EndpointFiles;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-start-'));
  files = { infoPath: join(dir, 'endpoint.json'), socketPath: join(dir, 'cli.sock') };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('startDaemonProcess', () => {
  it('resolves "ready" as soon as waitForDaemonReady finds an endpoint', async () => {
    const child = new FakeChild();
    const endpoint: Endpoint = { kind: 'tcp', port: 12345, token: 'x' };

    const result = await startDaemonProcess({
      scriptPath: 'fake-script.js',
      files,
      timeoutMs: 5_000,
      spawn: fakeSpawn(child),
      waitForDaemonReady: async () => endpoint,
    });

    expect(result).toEqual({ kind: 'ready', endpoint });
  });

  it('resolves "child-failed" when the child exits before the daemon becomes ready — does not wait out the full timeout', async () => {
    const child = new FakeChild();
    const startedAt = Date.now();

    const resultPromise = startDaemonProcess({
      scriptPath: 'fake-script.js',
      files,
      timeoutMs: 5_000,
      spawn: fakeSpawn(child),
      // 永远不 resolve——真正让这次调用结束的必须是子进程退出，而不是这个
      // 计时器（否则测试会真的等满 5 秒）。
      waitForDaemonReady: () => new Promise(() => undefined),
    });

    // 模拟子进程在起来之前就死了（比如配置错误、EADDRINUSE）。
    await waitUntilListening(child, 'exit');
    child.emit('exit', 1, null);

    const result = await resultPromise;
    const elapsedMs = Date.now() - startedAt;

    expect(result.kind, '子进程退出必须结束等待，而不是被计时器晾在那里').toBe('child-failed');
    if (result.kind === 'child-failed') {
      expect(result.detail, '子进程失败的诊断信息必须带上退出码').toContain('1');
    }
    expect(elapsedMs, '子进程退出应该立刻结束等待，不该跟 timeoutMs 扯上关系').toBeLessThan(1_000);
  });

  it('resolves "child-failed" with the spawn error message when spawn itself fails', async () => {
    const child = new FakeChild();

    const resultPromise = startDaemonProcess({
      scriptPath: 'fake-script.js',
      files,
      timeoutMs: 5_000,
      spawn: fakeSpawn(child),
      waitForDaemonReady: () => new Promise(() => undefined),
    });

    await waitUntilListening(child, 'error');
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('exit', null, null);

    const result = await resultPromise;
    expect(result.kind).toBe('child-failed');
    if (result.kind === 'child-failed') {
      expect(result.detail).toContain('spawn ENOENT');
    }
  });

  it('resolves "timed-out-but-alive" — not "child-failed" — when the deadline passes but the child never exited', async () => {
    const child = new FakeChild();

    const result = await startDaemonProcess({
      scriptPath: 'fake-script.js',
      files,
      timeoutMs: 20,
      spawn: fakeSpawn(child),
      // 永远不 resolve、子进程也永远不 exit——唯一能让这次调用结束的只有
      // waitForDaemonReady 自己内部的超时逻辑。这里直接模拟"到点了，报告
      // 超时"，因为真正的 waitForDaemonReady 已经在 client.test.ts 里单独
      // 测过。
      waitForDaemonReady: (_files, timeoutMs) =>
        new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    });

    expect(
      result,
      '到点了但子进程还活着，是"起得慢"，不是"死了"——这两者绝不能被汇报成同一种结果',
    ).toEqual({ kind: 'timed-out-but-alive', timeoutMs: 20 });
  });

  it('defaults to a generous timeout, not the old 5s that a cold Node start can exceed', () => {
    // NN-1 的测量：裸的 `node dist/bin/cli.js --list` 在某些机器上就要 6.9
    // 秒——旧的 5 秒预算连子进程自己的冷启动都盖不住。这里只锁住默认值本身
    // 比旧值宽松得多，不去真的等一次冷启动。
    expect(DEFAULT_START_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
