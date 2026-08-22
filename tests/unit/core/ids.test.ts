import { describe, it, expect } from 'vitest';
import { encodeRef, decodeRef } from '../../../src/core/ids.js';
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
