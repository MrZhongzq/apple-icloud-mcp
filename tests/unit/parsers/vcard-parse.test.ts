import { describe, it, expect } from 'vitest';
import { parseVCard, readContactMeta } from '../../../src/parsers/vcard.js';
import { AppError } from '../../../src/core/errors.js';

const ref = {
  collectionUrl: 'https://contacts.icloud.com/123/card/',
  resourceUrl: 'https://contacts.icloud.com/123/card/abc.vcf',
};

function card(...lines: string[]): string {
  return ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n');
}

/** 内置标签的包装形式，拆开写以免被误读成普通字符串。 */
const wrapped = (name: string) => '_$!<' + name + '>!$_';

describe('parseVCard', () => {
  it('reads the structured name and prefers FN for the full name', () => {
    const c = parseVCard(card('N:张;三;中;博士;Jr.', 'FN:张三'), ref);
    expect(c.name.full).toBe('张三');
    expect(c.name.family).toBe('张');
    expect(c.name.given).toBe('三');
    expect(c.name.middle).toBe('中');
    expect(c.name.prefix).toBe('博士');
    expect(c.name.suffix).toBe('Jr.');
  });

  it('falls back to composing a full name when FN is absent', () => {
    const c = parseVCard(card('N:张;三;;;'), ref);
    expect(c.name.full).toBe('张 三');
  });

  it('flattens a multi-value name segment', () => {
    // N 与 ADR 一样在 ical.js 的 design 表里声明了 multiValue:","，
    // 所以裸逗号会把该段变成子数组。ORG 没有这个声明，不会。
    const c = parseVCard(card('FN:x', 'N:张, 王;三;;;'), ref);
    expect(c.name.family).toBe('张, 王');
    expect(c.name.given).toBe('三');
  });

  it('degrades to an empty full name rather than throwing when a card has neither FN nor N', () => {
    const c = parseVCard(card('UID:U-1'), ref);
    expect(c.name.full).toBe('');
    expect(c.contact_id).toBeTruthy();
  });

  it('flattens a structured segment that itself parsed as an array', () => {
    // 裸逗号是 vCard 合法的多值分隔符，ical.js 会把该段解析成数组。
    // 这是唯一走得到 flattenSegment 的输入形态 —— 转义逗号不会触发它。
    const c = parseVCard(card('FN:x', 'ADR;type=WORK:;;某路 1 号, 5 楼;上海;;200000;中国'), ref);
    const addr = c.addresses![0]!;
    expect(addr.street).toBe('某路 1 号, 5 楼');
    expect(addr.city).toBe('上海');
    expect(addr.postal_code).toBe('200000');
    expect(addr.country).toBe('中国');
    expect(addr.type).toEqual(['work']);
  });

  it('keeps an escaped comma literal instead of splitting on it', () => {
    // 用 String.fromCharCode(92) 构造反斜杠：字面反斜杠会在多层工具链里被折叠，
    // 这正是这条事实最初被写反的原因。
    const bs = String.fromCharCode(92);
    const c = parseVCard(card('FN:x', 'ADR:;;某路 1 号' + bs + ', 5 楼;上海;;200000;中国'), ref);
    expect(c.addresses![0]!.street).toBe('某路 1 号, 5 楼');
  });

  it('splits ORG into organization and department', () => {
    const c = parseVCard(card('FN:x', 'ORG:某某科技有限公司;研发部', 'TITLE:工程师'), ref);
    expect(c.organization).toBe('某某科技有限公司');
    expect(c.department).toBe('研发部');
    expect(c.title).toBe('工程师');
  });

  it('normalizes TYPE to lowercase and lifts pref into primary', () => {
    const c = parseVCard(
      card(
        'FN:x',
        'EMAIL;type=INTERNET;type=WORK;type=pref:a@example.com',
        'EMAIL;type=HOME:b@example.com',
      ),
      ref,
    );
    const [first, second] = c.emails!;
    expect(first!.value).toBe('a@example.com');
    expect(first!.primary).toBe(true);
    expect(first!.type).toEqual(['internet', 'work']);
    expect(second!.primary).toBeUndefined();
    expect(second!.type).toEqual(['home']);
  });

  it('attaches an Apple custom label from the same item group', () => {
    const c = parseVCard(
      card(
        'FN:x',
        'item1.TEL;type=pref:+8613800000000',
        'item1.X-ABLabel:老家座机',
        'TEL;type=CELL:+8613900000000',
      ),
      ref,
    );
    const [labelled, plain] = c.phones!;
    expect(labelled!.label).toBe('老家座机');
    expect(plain!.label).toBeUndefined();
  });

  it('unwraps an Apple built-in label decoration', () => {
    const c = parseVCard(
      card('FN:x', 'item1.URL:https://example.com', 'item1.X-ABLabel:' + wrapped('HomePage')),
      ref,
    );
    expect(c.urls![0]!.label).toBe('HomePage');
  });

  it('reports a photo without ever returning its bytes', () => {
    const withPhoto = parseVCard(card('FN:x', 'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ'), ref);
    expect(withPhoto.has_photo).toBe(true);
    expect(JSON.stringify(withPhoto)).not.toContain('/9j/4AAQ');
    expect(parseVCard(card('FN:x'), ref).has_photo).toBe(false);
  });

  it('formats a birthday with and without a year', () => {
    expect(parseVCard(card('FN:x', 'BDAY:1990-05-20'), ref).birthday).toBe('1990-05-20');
    expect(parseVCard(card('FN:x', 'BDAY:--05-20'), ref).birthday).toBe('--05-20');
  });

  // Apple 给"不记得年份"的生日写的是 X-APPLE-OMIT-YEAR + 一个占位年份 1604；
  // 原样输出会让模型报告一个 1604 年的出生年份。
  it('reads an Apple omit-year birthday as the no-year form', () => {
    const c = parseVCard(card('FN:x', 'BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-20'), ref);
    expect(c.birthday).toBe('--05-20');
  });

  it('drops a year-only birthday instead of inventing month and day', () => {
    // BDAY:1990 解析出 month/day 为空，旧实现会输出 "1990-00-00" 这种不存在的日期。
    expect(parseVCard(card('FN:x', 'BDAY:1990'), ref).birthday).toBeUndefined();
  });

  it('drops a birthday outside the calendar range', () => {
    expect(parseVCard(card('FN:x', 'BDAY:1990-13-45'), ref).birthday).toBeUndefined();
    expect(parseVCard(card('FN:x', 'BDAY:1990-02-30'), ref).birthday).toBeUndefined();
  });

  // 这一条是最要紧的：卡片可能是任何客户端写的。读方向一旦抛错，异常会穿过
  // parseRoot 的 try/catch 变成 INTERNAL，而 modules/contacts/cache.ts 会在每次
  // 同步时跳过整张卡——一个字段格式不对，整个联系人就永远搜不到、也就再也拿不到
  // contact_id 去读/改/删了。所以无法格式化的 BDAY 只能让字段缺席，绝不能抛。
  it('still parses a card whose BDAY some other client wrote unparseably', () => {
    const c = parseVCard(card('FN:王五', 'N:王;五;;;', 'BDAY:next tuesday', 'EMAIL:w@example.com'), ref);
    expect(c.birthday).toBeUndefined();
    expect(c.name.full).toBe('王五');
    expect(c.emails![0]!.value).toBe('w@example.com');
  });

  it('tolerates vCard 4.0 as well as 3.0', () => {
    const v4 = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:李四',
      'N:李;四;;;',
      'EMAIL;TYPE=work:li@example.com',
      'END:VCARD',
    ].join('\r\n');
    const c = parseVCard(v4, ref);
    expect(c.name.full).toBe('李四');
    expect(c.emails![0]!.value).toBe('li@example.com');
  });

  it('emits opaque ids that never leak a raw URL', () => {
    const c = parseVCard(card('FN:x', 'UID:ABCD-1234', 'REV:2026-08-24T10:00:00Z'), ref);
    expect(typeof c.contact_id).toBe('string');
    expect(c.contact_id).not.toContain('https://');
    expect(c.contact_id).not.toContain('contacts.icloud.com');
    expect(c.address_book_id).not.toContain('https://');
    expect(c.updated_at).toBe('2026-08-24T10:00:00Z');
  });

  it('rejects text that is not a vCard', () => {
    expect(() => parseVCard('BEGIN:VCALENDAR\r\nEND:VCALENDAR', ref)).toThrow(AppError);
    expect(() => parseVCard('not a card at all', ref)).toThrow(AppError);
  });
});

describe('readContactMeta', () => {
  it('reads UID and REV without building the whole model', () => {
    expect(readContactMeta(card('FN:x', 'UID:U-1', 'REV:2026-01-01T00:00:00Z'))).toEqual({
      uid: 'U-1',
      rev: '2026-01-01T00:00:00Z',
    });
  });

  it('returns an empty object for a card carrying neither', () => {
    expect(readContactMeta(card('FN:x'))).toEqual({});
  });
});
