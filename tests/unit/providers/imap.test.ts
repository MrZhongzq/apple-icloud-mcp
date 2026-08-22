import { describe, it, expect } from 'vitest';
import { mapImapError } from '../../../src/providers/icloud/imap.js';
import { AppError } from '../../../src/core/errors.js';

describe('mapImapError', () => {
  it('maps authentication failures to AUTH_FAILED with an actionable hint', () => {
    const mapped = mapImapError(Object.assign(new Error('Invalid credentials'), {
      authenticationFailed: true,
    }));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe('AUTH_FAILED');
    expect(mapped.retryable).toBe(false);
    expect(mapped.hint).toContain('App 专用密码');
  });

  it('maps network errors to a retryable UPSTREAM_ERROR', () => {
    const mapped = mapImapError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a missing mailbox to NOT_FOUND', () => {
    const mapped = mapImapError(new Error('Mailbox does not exist'));
    expect(mapped.code).toBe('NOT_FOUND');
  });

  it('never leaks the original message for unknown failures', () => {
    const mapped = mapImapError(new Error('LOGIN user pass=abcd-efgh'));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.message).not.toContain('abcd-efgh');
  });
});
