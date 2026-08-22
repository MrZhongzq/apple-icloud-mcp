import { describe, it, expect } from 'vitest';
import { mapSmtpError } from '../../../src/providers/icloud/smtp.js';

describe('mapSmtpError', () => {
  it('maps a 535 authentication rejection to AUTH_FAILED', () => {
    const mapped = mapSmtpError(Object.assign(new Error('Invalid login'), { responseCode: 535 }));
    expect(mapped.code).toBe('AUTH_FAILED');
    expect(mapped.hint).toContain('App 专用密码');
  });

  it('maps a 421/450 throttle to a retryable RATE_LIMITED', () => {
    const mapped = mapSmtpError(Object.assign(new Error('too many messages'), { responseCode: 421 }));
    expect(mapped.code).toBe('RATE_LIMITED');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a 550 rejection to INVALID_INPUT', () => {
    const mapped = mapSmtpError(Object.assign(new Error('no such user'), { responseCode: 550 }));
    expect(mapped.code).toBe('INVALID_INPUT');
    expect(mapped.retryable).toBe(false);
  });

  it('falls back to a retryable UPSTREAM_ERROR without leaking details', () => {
    const mapped = mapSmtpError(new Error('AUTH PLAIN abcd-efgh'));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.message).not.toContain('abcd-efgh');
  });
});
