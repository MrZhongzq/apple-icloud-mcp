import { describe, it, expect } from 'vitest';
import { isDaemonAbsent } from '../../../src/cli/client.js';

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
