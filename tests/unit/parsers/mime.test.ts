import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEmail, htmlToText, makeSnippet } from '../../../src/parsers/mime.js';

const fixture = (name: string): Buffer =>
  readFileSync(join(process.cwd(), 'tests/fixtures/mail', name));

describe('parseEmail', () => {
  it('decodes an RFC 2047 encoded Chinese subject', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.subject).toBe('测试邮件：中文主题');
  });

  it('decodes a base64 Chinese body', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.text).toContain('你好，这是一封测试邮件。');
    expect(mail.text).toContain('第二行。');
  });

  it('decodes the display name and address of the sender', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.from).toEqual({ name: '测试', address: 'sender@icloud.com' });
  });

  it('normalises the date to an ISO string', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.date).toBe(new Date('2026-08-17T02:30:00.000Z').toISOString());
  });

  it('decodes quoted-printable text from a multipart message', async () => {
    const mail = await parseEmail(fixture('multipart-qp.eml'));
    expect(mail.subject).toBe('多部分邮件');
    expect(mail.text).toContain('纯文本部分');
  });

  it('keeps the html part available separately', async () => {
    const mail = await parseEmail(fixture('multipart-qp.eml'));
    expect(mail.html).toContain('第一段');
  });

  it('reports no attachments for a plain message', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.attachments).toEqual([]);
  });

  it('converts an html-only message to readable text with our link format', async () => {
    const mail = await parseEmail(fixture('html-only.eml'));
    expect(mail.subject).toBe('只有 HTML 的邮件');
    expect(mail.text).toBe('第一段\n点击 这里 (https://example.com)');
  });

  it('still exposes the original html for an html-only message', async () => {
    const mail = await parseEmail(fixture('html-only.eml'));
    expect(mail.html).toContain('<p>第一段</p>');
  });

  it('surfaces an inline image as attachment metadata', async () => {
    const mail = await parseEmail(fixture('inline-image.eml'));
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.filename).toBe('pixel.png');
    expect(mail.attachments[0]!.contentType).toBe('image/png');
    expect(mail.attachments[0]!.size).toBeGreaterThan(0);
  });

  it('keeps the image payload out of the text body', async () => {
    const mail = await parseEmail(fixture('inline-image.eml'));
    expect(mail.text).toContain('看图');
    expect(mail.text).not.toContain('iVBORw0');
  });
});

describe('htmlToText', () => {
  it('turns block elements into line breaks and decodes entities', () => {
    const out = htmlToText('<p>第一段</p><p>Second &amp; last</p>');
    expect(out).toBe('第一段\nSecond & last');
  });

  it('keeps link targets alongside the link text', () => {
    expect(htmlToText('<a href="https://example.com">点这里</a>')).toBe('点这里 (https://example.com)');
  });

  it('drops script and style content entirely', () => {
    expect(htmlToText('<style>p{color:red}</style><p>正文</p><script>alert(1)</script>')).toBe('正文');
  });

  it('does not double-decode already-escaped entity sequences', () => {
    expect(htmlToText('<p>&amp;lt;tag&amp;gt;</p>')).toBe('&lt;tag&gt;');
  });

  it('leaves an out-of-range numeric entity as literal text', () => {
    expect(htmlToText('<p>&#99999999;</p>')).toBe('&#99999999;');
  });
});

describe('makeSnippet', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(makeSnippet('第一行\n\n  第二行  ', 6)).toBe('第一行 第二…');
  });

  it('leaves short text untouched', () => {
    expect(makeSnippet('短', 200)).toBe('短');
  });
});
