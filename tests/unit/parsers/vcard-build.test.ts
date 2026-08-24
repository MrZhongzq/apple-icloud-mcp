import { describe, it, expect } from 'vitest';
import { buildVCard, applyContactPatch, parseVCard } from '../../../src/parsers/vcard.js';

const ref = {
  collectionUrl: 'https://contacts.icloud.com/123/card/',
  resourceUrl: 'https://contacts.icloud.com/123/card/abc.vcf',
};

/** 一张带足未建模属性的真实形态卡片。 */
const richCard = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iOS 18.0//EN',
  'N:张;三;;;',
  'FN:张三',
  'ORG:某某科技;研发部',
  'EMAIL;type=INTERNET;type=WORK;type=pref:zhang@example.com',
  'item1.TEL;type=pref:+8613800000000',
  'item1.X-ABLabel:老家座机',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ',
  'X-ABRELATEDNAMES;type=pref:李四',
  'X-SOCIALPROFILE;type=weibo:https://weibo.com/zhang',
  'X-APPLE-SUBADMINISTRATIVEAREA:浦东新区',
  'NOTE:原有备注',
  'UID:ABCD-1234',
  'REV:2026-08-01T00:00:00Z',
  'END:VCARD',
].join('\r\n');

describe('buildVCard', () => {
  it('emits a 3.0 card carrying VERSION, FN, N and a generated UID', () => {
    const { vcard, uid } = buildVCard({ name: { family: '王', given: '五' } });
    expect(vcard).toContain('BEGIN:VCARD');
    expect(vcard).toContain('VERSION:3.0');
    expect(vcard).toMatch(/\r\nFN:王 五\r\n/);
    expect(vcard).toMatch(/\r\nN:王;五;;;\r\n/);
    expect(uid).toBeTruthy();
    expect(vcard).toContain('UID:' + uid);
    expect(vcard.endsWith('END:VCARD')).toBe(true);
  });

  it('prefers an explicit full name over the composed one', () => {
    const { vcard } = buildVCard({ name: { full: '张三丰', family: '张', given: '三丰' } });
    expect(vcard).toMatch(/\r\nFN:张三丰\r\n/);
  });

  it('writes typed values with their parameters and pref', () => {
    const { vcard } = buildVCard({
      name: { full: 'x' },
      emails: [{ value: 'a@example.com', type: ['work'], primary: true }],
      phones: [{ value: '+8613900000000', type: ['cell'] }],
    });
    const email = vcard.split('\r\n').find((l) => l.startsWith('EMAIL'))!;
    expect(email).toContain('a@example.com');
    expect(email.toUpperCase()).toContain('WORK');
    expect(email.toUpperCase()).toContain('PREF');
    expect(vcard).toContain('+8613900000000');
  });

  it('writes a custom label in its own item group', () => {
    const { vcard } = buildVCard({
      name: { full: 'x' },
      phones: [{ value: '+8613800000000', label: '老家座机' }],
    });
    const lines = vcard.split('\r\n');
    const tel = lines.find((l) => /^ITEM\d+\.TEL/i.test(l));
    const label = lines.find((l) => /^ITEM\d+\.X-ABLABEL/i.test(l));
    expect(tel, 'labelled phone must live in an item group').toBeTruthy();
    expect(label).toBeTruthy();
    const group = /^(ITEM\d+)\./i.exec(tel!)![1]!;
    expect(label!.toUpperCase().startsWith(group.toUpperCase() + '.')).toBe(true);
    expect(label).toContain('老家座机');
  });

  it('round-trips through the parser', () => {
    const { vcard } = buildVCard({
      name: { full: '李四', family: '李', given: '四' },
      organization: '某公司',
      emails: [{ value: 'li@example.com', type: ['home'] }],
      birthday: '1990-05-20',
      note: '备注内容',
    });
    const back = parseVCard(vcard, ref);
    expect(back.name.full).toBe('李四');
    expect(back.organization).toBe('某公司');
    expect(back.emails![0]!.value).toBe('li@example.com');
    expect(back.birthday).toBe('1990-05-20');
    expect(back.note).toBe('备注内容');
  });
});

describe('applyContactPatch', () => {
  it('preserves every property the model does not represent', () => {
    const out = applyContactPatch(richCard, { organization: '新公司' });
    expect(out).toContain('X-ABRELATEDNAMES');
    expect(out).toContain('李四');
    expect(out).toContain('X-SOCIALPROFILE');
    expect(out).toContain('X-APPLE-SUBADMINISTRATIVEAREA');
    expect(out).toContain('PRODID');
    // 头像必须原样留在卡片里 —— 领域模型里根本没有它，重建就一定丢
    expect(out).toContain('/9j/4AAQSkZJRgABAQ');
    expect(out).toContain('新公司');
  });

  it('leaves untouched fields exactly as they were', () => {
    const out = applyContactPatch(richCard, { note: '新备注' });
    const back = parseVCard(out, ref);
    expect(back.note).toBe('新备注');
    expect(back.name.full).toBe('张三');
    expect(back.organization).toBe('某某科技');
    expect(back.emails![0]!.value).toBe('zhang@example.com');
    expect(back.phones![0]!.label).toBe('老家座机');
  });

  it('clears a scalar field when the patch carries null', () => {
    const out = applyContactPatch(richCard, { note: null });
    expect(parseVCard(out, ref).note).toBeUndefined();
    expect(out).not.toContain('原有备注');
  });

  it('does not touch a scalar field the patch omits', () => {
    const out = applyContactPatch(richCard, { organization: '新公司' });
    expect(parseVCard(out, ref).note).toBe('原有备注');
  });

  it('replaces a repeatable field wholesale and drops its orphaned labels', () => {
    const out = applyContactPatch(richCard, { phones: [{ value: '+8615000000000', type: ['cell'] }] });
    const back = parseVCard(out, ref);
    expect(back.phones!.map((p) => p.value)).toEqual(['+8615000000000']);
    // 老号码所属分组的 X-ABLabel 必须一起消失，否则留下孤儿标签
    expect(out).not.toContain('老家座机');
  });

  it('clears a repeatable field when given an empty array', () => {
    const out = applyContactPatch(richCard, { emails: [] });
    expect(parseVCard(out, ref).emails).toBeUndefined();
    expect(out).not.toContain('zhang@example.com');
  });

  it('refreshes REV on every write', () => {
    const before = parseVCard(richCard, ref).updated_at;
    const out = applyContactPatch(richCard, { title: '架构师' });
    const after = parseVCard(out, ref).updated_at;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('keeps UID stable across a patch', () => {
    const out = applyContactPatch(richCard, { organization: '新公司' });
    expect(out).toContain('UID:ABCD-1234');
  });
});
