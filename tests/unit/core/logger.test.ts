import { describe, it, expect } from 'vitest';
import { createLogger, redact } from '../../../src/core/logger.js';

describe('redact', () => {
  it('masks credential-bearing keys at any depth', () => {
    const out = redact({
      user: 'a@icloud.com',
      password: 'abcd-efgh-ijkl-mnop',
      nested: { appPassword: 'secret', authorization: 'Bearer xyz', token: 't' },
    }) as Record<string, any>;
    expect(out.user).toBe('a@icloud.com');
    expect(out.password).toBe('***');
    expect(out.nested.appPassword).toBe('***');
    expect(out.nested.authorization).toBe('***');
    expect(out.nested.token).toBe('***');
  });

  it('leaves primitives untouched', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
  });
});

describe('createLogger', () => {
  it('suppresses levels below the configured one', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (l) => lines.push(l));
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"level":"warn"');
    expect(lines[1]).toContain('"level":"error"');
  });

  it('redacts metadata before writing', () => {
    const lines: string[] = [];
    const log = createLogger('info', (l) => lines.push(l));
    log.info('login', { user: 'a@icloud.com', password: 'abcd-efgh' });
    expect(lines[0]).toContain('a@icloud.com');
    expect(lines[0]).not.toContain('abcd-efgh');
  });
});
