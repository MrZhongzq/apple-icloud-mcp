import { describe, it, expect } from 'vitest';
import { AppError, toErrorPayload } from '../../../src/core/errors.js';

describe('AppError', () => {
  it('defaults retryable to false and keeps code and hint', () => {
    const err = new AppError('PERMISSION_DENIED', '邮件写权限未开启', {
      hint: '在环境变量中设置 ALLOW_MAIL_WRITE_1=true 后重启服务',
    });
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.retryable).toBe(false);
    expect(err.hint).toContain('ALLOW_MAIL_WRITE_1');
    expect(err).toBeInstanceOf(Error);
  });

  it('marks upstream errors retryable when told to', () => {
    const err = new AppError('UPSTREAM_ERROR', 'iCloud 暂时不可达', { retryable: true });
    expect(err.retryable).toBe(true);
  });
});

describe('toErrorPayload', () => {
  it('serializes AppError without leaking the cause', () => {
    const err = new AppError('AUTH_FAILED', 'App 专用密码被拒绝', {
      hint: '确认密码未被吊销',
      cause: new Error('LOGIN failed: password=hunter2'),
    });
    const payload = toErrorPayload(err);
    expect(payload).toEqual({
      error: {
        code: 'AUTH_FAILED',
        message: 'App 专用密码被拒绝',
        hint: '确认密码未被吊销',
        retryable: false,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('hunter2');
  });

  it('wraps unknown throwables as INTERNAL', () => {
    const payload = toErrorPayload(new TypeError('x is not a function'));
    expect(payload.error.code).toBe('INTERNAL');
    expect(payload.error.retryable).toBe(false);
  });
});
