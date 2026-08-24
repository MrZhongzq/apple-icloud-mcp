import { describe, it, expect } from 'vitest';
import { encodeRef, decodeRef, encodeUrl, decodeUrl } from '../../../src/core/ids.js';
import { AppError } from '../../../src/core/errors.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  // decodeUrl 被多个域共用，而它无从知道当前注册了哪些工具：报错不能只说日历，
  // 也不能把模型指向一个可能没被注册的工具。
  //
  // 这一条以前把列表写死成 calendar_list + reminders_lists 两个，于是当
  // contacts 成为第三个调用方时，这个专为该约束写的测试对违反结构性地看不见。
  // 现在改成从源码里反推：扫 src/modules/*/service.ts，凡是真的调用了 decodeUrl 的域，
  // 它的列表类工具就必须出现在 hint 里；出现了表里没登记的新域也直接失败。
  const LISTING_TOOL_BY_DOMAIN: Record<string, string> = {
    calendar: 'calendar_list',
    reminders: 'reminders_lists',
    contacts: 'contacts_search',
  };

  function domainsCallingDecodeUrl(): string[] {
    const modulesDir = fileURLToPath(new URL('../../../src/modules/', import.meta.url));
    return readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        const service = join(modulesDir, entry.name, 'service.ts');
        return existsSync(service) && readFileSync(service, 'utf8').includes('decodeUrl');
      })
      .map((entry) => entry.name);
  }

  it('reports a malformed id in domain-neutral terms naming a listing tool for every caller', () => {
    const domains = domainsCallingDecodeUrl();
    expect(domains.length, 'no module calls decodeUrl -- the scan is broken').toBeGreaterThan(0);

    try {
      decodeUrl(Buffer.from('nope').toString('base64url'));
      expect.unreachable('decodeUrl should have thrown');
    } catch (err) {
      const error = err as AppError;
      expect(error.message).not.toContain('calendar_id');
      expect(error.message).not.toContain('日历');
      for (const domain of domains) {
        const tool = LISTING_TOOL_BY_DOMAIN[domain];
        expect(tool, `${domain} 模块调用了 decodeUrl，请把它的列表类工具登记到 LISTING_TOOL_BY_DOMAIN`).toBeTruthy();
        expect(error.hint, `decodeUrl 的 hint 没有点到 ${domain} 的列表类工具`).toContain(tool!);
      }
    }
  });
});
