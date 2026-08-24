import { describe, it, expect } from 'vitest';
import { buildVCard, applyContactPatch, parseVCard } from '../../../src/parsers/vcard.js';
import { AppError } from '../../../src/core/errors.js';

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

  it('writes a structured address and round-trips it', () => {
    const { vcard } = buildVCard({
      name: { full: 'x' },
      addresses: [
        {
          type: ['work'],
          street: '某路 1 号',
          city: '上海',
          region: '',
          postal_code: '200000',
          country: '中国',
        },
      ],
      urls: [{ value: 'https://example.com', type: ['work'] }],
      impp: [{ value: 'skype:someone', type: ['home'] }],
    });
    const back = parseVCard(vcard, ref);
    const addr = back.addresses![0]!;
    expect(addr.street).toBe('某路 1 号');
    expect(addr.city).toBe('上海');
    expect(addr.postal_code).toBe('200000');
    expect(addr.country).toBe('中国');
    expect(back.urls![0]!.value).toBe('https://example.com');
    expect(back.impp![0]!.value).toBe('skype:someone');
  });

  it('refuses to build a card with no usable name', () => {
    expect(() => buildVCard({ name: {} })).toThrow(AppError);
    expect(() => buildVCard({ name: { full: '   ' } })).toThrow(AppError);
  });

  // 写方向必须在触网之前拒绝非法生日：服务层是"先在服务器上建卡、再解析回显"的顺序，
  // 一张 BDAY 写坏的卡片会让该联系人在本服务里永久失联（搜不到 → 拿不到 contact_id）。
  it('rejects a birthday that is not one of the two accepted forms', () => {
    for (const bad of ['next tuesday', '1990-13-45', '1990', '1990/05/20', '90-05-20', '--13-01', '1990-02-30']) {
      expect(() => buildVCard({ name: { full: 'x' }, birthday: bad }), bad).toThrow(AppError);
    }
  });

  it('names both accepted birthday forms in the error hint', () => {
    try {
      buildVCard({ name: { full: 'x' }, birthday: 'next tuesday' });
      expect.unreachable('buildVCard should have rejected the birthday');
    } catch (err) {
      const error = err as AppError;
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.hint).toContain('YYYY-MM-DD');
      expect(error.hint).toContain('--MM-DD');
    }
  });

  it('accepts both birthday forms, including a leap day with no year', () => {
    for (const good of ['1990-05-20', '--05-20', '2000-02-29', '--02-29']) {
      const { vcard } = buildVCard({ name: { full: 'x' }, birthday: good });
      expect(parseVCard(vcard, ref).birthday, good).toBe(good);
    }
  });

  it('allocates distinct groups across two labelled fields in one call', () => {
    const { vcard } = buildVCard({
      name: { full: 'x' },
      emails: [{ value: 'a@example.com', label: '私人邮箱' }],
      phones: [{ value: '+8613800000000', label: '老家座机' }],
    });
    const groupOf = (re: RegExp) =>
      /^(ITEM\d+)\./i.exec(vcard.split('\r\n').find((l) => re.test(l))!)![1]!;
    expect(groupOf(/^ITEM\d+\.EMAIL/i).toUpperCase()).not.toBe(groupOf(/^ITEM\d+\.TEL/i).toUpperCase());
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

  it('replaces addresses wholesale and leaves other fields alone', () => {
    const out = applyContactPatch(richCard, {
      addresses: [{ type: ['home'], street: '新路 2 号', city: '北京' }],
    });
    const back = parseVCard(out, ref);
    expect(back.addresses).toHaveLength(1);
    expect(back.addresses![0]!.street).toBe('新路 2 号');
    expect(back.addresses![0]!.city).toBe('北京');
    expect(back.name.full).toBe('张三');
    expect(back.emails![0]!.value).toBe('zhang@example.com');
  });

  // 同 buildVCard：一个非法生日经 update 写进去，会把一个原本健康的联系人变成失联卡片。
  it('rejects a birthday that is not one of the two accepted forms', () => {
    for (const bad of ['next tuesday', '1990-13-45', '1990', '--13-01']) {
      expect(() => applyContactPatch(richCard, { birthday: bad }), bad).toThrow(AppError);
    }
    // 校验必须发生在任何改动之前：抛错时原卡片一个字节都不该被改（同一个入参对象再走一次仍等价）
    expect(() => applyContactPatch(richCard, { birthday: 'next tuesday', note: '新备注' })).toThrow(AppError);
    expect(parseVCard(richCard, ref).note).toBe('原有备注');
  });

  it('accepts both birthday forms and clears with null', () => {
    expect(parseVCard(applyContactPatch(richCard, { birthday: '1990-05-20' }), ref).birthday).toBe('1990-05-20');
    expect(parseVCard(applyContactPatch(richCard, { birthday: '--05-20' }), ref).birthday).toBe('--05-20');
    const withBday = applyContactPatch(richCard, { birthday: '1990-05-20' });
    expect(parseVCard(applyContactPatch(withBday, { birthday: null }), ref).birthday).toBeUndefined();
  });

  // ORG 是一条属性里的两段，补丁却把它拆成两个独立标量：只改一半时，另一半必须从
  // 卡片上读回来一起重写，否则用户的部门会被静默删掉（richCard 的 ORG 是 某某科技;研发部）。
  it('preserves the untouched half of ORG', () => {
    const orgOnly = parseVCard(applyContactPatch(richCard, { organization: '新公司' }), ref);
    expect(orgOnly.organization).toBe('新公司');
    expect(orgOnly.department, 'ORG 的部门段在只改公司名时必须保留').toBe('研发部');

    const deptOnly = parseVCard(applyContactPatch(richCard, { department: '平台部' }), ref);
    expect(deptOnly.organization, 'ORG 的公司段在只改部门时必须保留').toBe('某某科技');
    expect(deptOnly.department).toBe('平台部');
  });

  it('clears only the named half of ORG when it is null', () => {
    const noDept = parseVCard(applyContactPatch(richCard, { department: null }), ref);
    expect(noDept.organization).toBe('某某科技');
    expect(noDept.department).toBeUndefined();

    const noOrg = parseVCard(applyContactPatch(richCard, { organization: null }), ref);
    expect(noOrg.organization).toBeUndefined();
    expect(noOrg.department).toBe('研发部');
  });

  it('leaves ORG untouched when neither half is in the patch', () => {
    const back = parseVCard(applyContactPatch(richCard, { title: '架构师' }), ref);
    expect(back.organization).toBe('某某科技');
    expect(back.department).toBe('研发部');
  });

  it('replaces FN and N together when the patch carries a name', () => {
    const out = applyContactPatch(richCard, { name: { family: '李', given: '四' } });
    const back = parseVCard(out, ref);
    expect(back.name.full).toBe('李 四');
    expect(back.name.family).toBe('李');
    expect(back.name.given).toBe('四');
    // 旧的 N/FN 不得残留成第二条同名属性
    expect(out.split('\r\n').filter((l) => l.startsWith('FN:'))).toHaveLength(1);
    expect(out.split('\r\n').filter((l) => l.startsWith('N:'))).toHaveLength(1);
    expect(out).not.toContain('FN:张三');
  });

  it('prefers an explicit full name in a name patch and leaves the card alone without one', () => {
    const explicit = parseVCard(applyContactPatch(richCard, { name: { full: '张三丰', family: '张' } }), ref);
    expect(explicit.name.full).toBe('张三丰');
    expect(explicit.name.family).toBe('张');

    const untouched = parseVCard(applyContactPatch(richCard, { title: '架构师' }), ref);
    expect(untouched.name.full).toBe('张三');
    expect(untouched.name.family).toBe('张');
    expect(untouched.name.given).toBe('三');
  });

  it('refuses a name patch that produces no FN', () => {
    expect(() => applyContactPatch(richCard, { name: {} })).toThrow(AppError);
    expect(() => applyContactPatch(richCard, { name: { full: '   ' } })).toThrow(AppError);
  });

  it('does not reuse a group number held by a preserved property', () => {
    // richCard 里 item1 已被那条带标签的电话占着；替换 email 时分配的组号不得撞上它
    const out = applyContactPatch(richCard, {
      emails: [{ value: 'new@example.com', label: '新标签' }],
    });
    const back = parseVCard(out, ref);
    expect(back.emails![0]!.label).toBe('新标签');
    expect(back.phones![0]!.label).toBe('老家座机');
  });
});
