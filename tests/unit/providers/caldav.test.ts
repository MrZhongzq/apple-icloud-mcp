import { describe, it, expect } from 'vitest';
import { mapCalDavError } from '../../../src/providers/icloud/caldav.js';

describe('mapCalDavError', () => {
  it('maps 401 to AUTH_FAILED', () => {
    const mapped = mapCalDavError({ status: 401, message: 'Unauthorized' });
    expect(mapped.code).toBe('AUTH_FAILED');
  });

  it('maps 403 to PERMISSION_DENIED', () => {
    expect(mapCalDavError({ status: 403 }).code).toBe('PERMISSION_DENIED');
  });

  it('maps 404 to NOT_FOUND with a recovery hint', () => {
    const mapped = mapCalDavError({ status: 404 });
    expect(mapped.code).toBe('NOT_FOUND');
    expect(mapped.hint).toContain('calendar_list_events');
  });

  it('maps 412 precondition failure to CONFLICT', () => {
    const mapped = mapCalDavError({ status: 412 });
    expect(mapped.code).toBe('CONFLICT');
    expect(mapped.hint).toContain('重新读取');
  });

  it('maps 5xx to a retryable UPSTREAM_ERROR', () => {
    const mapped = mapCalDavError({ status: 503 });
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.retryable).toBe(true);
  });
});
