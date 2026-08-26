import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { isDaemonAbsent, roundTrip } from '../../../src/cli/client.js';

/**
 * F-2 的整个规则归结到这一个判断上：只有 ENOENT/ECONNREFUSED 能证明"那头
 * 真的没有 daemon"，别的连接失败（EMFILE、EACCES、ENFILE……）都不能。
 * 复审者验证过：把这个函数改成无条件 `return true`，CLI 套件在这之前一条
 * 都不会转红——之前完全没有测试挡着这条判断本身。这里直接钉住它，而不是
 * 试图在集成层面制造一个真实的 EMFILE/EACCES（那需要真的耗尽文件描述符或
 * 触发系统级权限拒绝，跨平台既不确定也有破坏性，不适合放进单测）。
 */
describe('isDaemonAbsent (F-2 guard)', () => {
  it('is true only for the two error codes that prove the daemon is gone', () => {
    expect(isDaemonAbsent({ code: 'ENOENT' })).toBe(true);
    expect(isDaemonAbsent({ code: 'ECONNREFUSED' })).toBe(true);
  });

  it('is false for errors that do not prove the daemon is gone', () => {
    // 清空端点文件是不可逆的：daemon 还在跑、还握着已登录的 iCloud 会话，
    // 只是这一次连接因为别的原因（fd 耗尽、权限……）没打通，把它当成"没有
    // daemon"会把一个活的 daemon 变成孤儿。
    expect(isDaemonAbsent({ code: 'EMFILE' })).toBe(false);
    expect(isDaemonAbsent({ code: 'EACCES' })).toBe(false);
    expect(isDaemonAbsent({ code: 'ENFILE' })).toBe(false);
    expect(isDaemonAbsent({ code: 'ETIMEDOUT' })).toBe(false);
    expect(isDaemonAbsent(undefined)).toBe(false);
    expect(isDaemonAbsent(new Error('boom'))).toBe(false);
    expect(isDaemonAbsent({})).toBe(false);
  });
});

/**
 * 一个满足 roundTrip 实际用到的那点 socket 接口（on/once/write/destroy）的假
 * 实现，不接真实网络。用它而不是真的 hanging listener，是为了能直接监听
 * 全局 setTimeout：daemon.test.ts 里"500ms 内没超时"那条测试只能证明
 * "没有比 500ms 更短的超时"，真正要证明的是"压根没有安排任何计时器"——
 * 这只能靠直接观察 setTimeout 有没有被调用，不能靠等一段有限的时间再去看
 * 有没有触发（不管等多久，等的时间本身永远是个上限，不是"没有上限"）。
 */
class FakeSocket extends EventEmitter {
  write(_data: string): boolean {
    return true;
  }
  destroy(): void {
    // 不用做任何事：这个假 socket 没有底层连接需要关闭。
  }
}

describe('roundTrip has no default deadline (N-3, direct)', () => {
  it('arms no timer at all when timeoutMs is omitted — the shape every production call site uses', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    try {
      const socket = new FakeSocket();
      // 故意不 await：这个 promise 在假 socket 上不会有任何事件触发，也没有
      // 计时器可以让它 settle——它按设计永远不会落定，这正是要证明的属性。
      // 没有任何真实资源（定时器、socket、文件句柄）引用它，测试结束后可以
      // 被安全回收。
      void roundTrip(socket as unknown as net.Socket, { tool: 'apple_accounts', args: {} });
      // 让 roundTrip 内部同步执行的部分（包括那次 write 调用）真正跑完。
      await Promise.resolve();
      await Promise.resolve();

      expect(
        setTimeoutSpy,
        '生产路径（callDaemon/stopDaemon 都不传 roundTripMs）不该安一个计时器——写完请求之后应当无限期等答复，而不是在某个硬编的时间点被打断',
      ).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('arms exactly one timer when a test-only timeoutMs is given, and it is what fires', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    let outcomeKind: string;
    try {
      const socket = new FakeSocket();
      const promise = roundTrip(socket as unknown as net.Socket, { tool: 'apple_accounts', args: {} }, 20);
      await Promise.resolve();
      expect(setTimeoutSpy, '显式传入 timeoutMs 时必须真的安一个计时器，不然这个测试专用的旋钮就是摆设').toHaveBeenCalledTimes(1);
      const outcome = await promise;
      outcomeKind = outcome.kind;
    } finally {
      setTimeoutSpy.mockRestore();
    }
    expect(outcomeKind, '假 socket 永远不会给出真实响应，注入的计时器到点之后应当归类为 sent-unknown').toBe('sent-unknown');
  });
});
