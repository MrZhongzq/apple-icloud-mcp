import { describe, it, expect } from 'vitest';
import { encodeRef, decodeRef, encodeUrl, decodeUrl } from '../../../src/core/ids.js';
import { AppError } from '../../../src/core/errors.js';

describe('resource refs', () => {
  const ref = {
    collectionUrl: 'https://p01-caldav.icloud.com/12345/calendars/home/',
    resourceUrl: 'https://p01-caldav.icloud.com/12345/calendars/home/ABC-123.ics',
  };

  it('round-trips a reference', () => {
    expect(decodeRef(encodeRef(ref))).toEqual(ref);
  });

  it('produces a URL-safe token without padding', () => {
    expect(encodeRef(ref)).not.toMatch(/[+/=]/);
  });

  it('rejects a malformed id', () => {
    expect(() => decodeRef('not-a-real-id')).toThrowError(AppError);
  });

  it('rejects an id missing the separator', () => {
    const bad = Buffer.from('https://example.com/only-one-part').toString('base64url');
    expect(() => decodeRef(bad)).toThrowError(AppError);
  });
});

describe('calendar url ids', () => {
  const url = 'https://p01-caldav.icloud.com/12345/calendars/home/';

  it('round-trips a calendar url', () => {
    expect(decodeUrl(encodeUrl(url))).toBe(url);
  });

  it('rejects an id that does not decode to a url', () => {
    expect(() => decodeUrl(Buffer.from('nope').toString('base64url'))).toThrowError(AppError);
  });

  // 提醒侧的 list_ids 与 create 的 listId 都走 decodeUrl：报错不能只说日历，
  // 也不能把模型指向一个可能没被注册的日历工具。
  it('reports a malformed id in domain-neutral terms naming both listing tools', () => {
    try {
      decodeUrl(Buffer.from('nope').toString('base64url'));
      expect.unreachable('decodeUrl should have thrown');
    } catch (err) {
      const error = err as AppError;
      expect(error.message).not.toContain('calendar_id');
      expect(error.message).not.toContain('日历');
      expect(error.hint).toContain('calendar_list');
      expect(error.hint).toContain('reminders_lists');
    }
  });
});
