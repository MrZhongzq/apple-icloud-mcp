import { describe, it, expect } from 'vitest';
import { mapCalDavError } from '../../../src/providers/icloud/caldav.js';
import { hasWritePrivilege, applyPrivilegeFallback } from '../../../src/providers/icloud/caldav.js';

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

describe('hasWritePrivilege', () => {
  it('finds write in a multi-privilege array', () => {
    expect(hasWritePrivilege({ privilege: [{ write: {} }, { read: {} }] })).toBe(true);
  });

  it('returns false for a read-only privilege set', () => {
    expect(hasWritePrivilege({ privilege: { read: {} } })).toBe(false);
  });

  it('returns false when the property is absent', () => {
    expect(hasWritePrivilege(undefined)).toBe(false);
  });

  it('matches nested write-ish privileges such as write-content', () => {
    expect(hasWritePrivilege({ privilege: [{ 'write-content': {} }] })).toBe(true);
  });
});

describe('applyPrivilegeFallback', () => {
  it('reports all calendars writable when none was detected as writable', () => {
    const out = applyPrivilegeFallback([
      { url: 'a', name: 'A', readOnly: true, components: ['VEVENT'] },
      { url: 'b', name: 'B', readOnly: true, components: ['VEVENT'] },
    ]);
    expect(out.every((c) => !c.readOnly)).toBe(true);
  });

  it('leaves a mixed result untouched', () => {
    const out = applyPrivilegeFallback([
      { url: 'a', name: 'A', readOnly: false, components: ['VEVENT'] },
      { url: 'b', name: 'B', readOnly: true, components: ['VEVENT'] },
    ]);
    expect(out.map((c) => c.readOnly)).toEqual([false, true]);
  });

  it('handles an empty list', () => {
    expect(applyPrivilegeFallback([])).toEqual([]);
  });
});
