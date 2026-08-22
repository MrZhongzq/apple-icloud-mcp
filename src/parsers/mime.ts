import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface AttachmentInfo {
  filename: string;
  contentType: string;
  size: number;
}

export interface ParsedEmail {
  messageId?: string;
  date?: string;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
  attachments: AttachmentInfo[];
  inReplyTo?: string;
  references: string[];
}

function toAddresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: EmailAddress[] = [];
  for (const group of list) {
    for (const entry of group.value) {
      if (!entry.address) continue;
      const address: EmailAddress = { address: entry.address };
      if (entry.name) address.name = entry.name;
      out.push(address);
    }
  }
  return out;
}

const BLOCK_TAG = /<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi;
const BREAK_TAG = /<br\s*\/?>/gi;
const DROPPED_BLOCK = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const LINK_TAG = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const ANY_TAG = /<[^>]+>/g;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

function decodeEntities(input: string): string {
  let out = input.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out;
}

/** HTML 转可读纯文本：保留段落结构与链接目标，丢弃脚本样式。 */
export function htmlToText(html: string): string {
  const withLinks = html
    .replace(DROPPED_BLOCK, '')
    .replace(LINK_TAG, (_, href: string, label: string) => `${label.trim()} (${href})`);

  const withBreaks = withLinks.replace(BREAK_TAG, '\n').replace(BLOCK_TAG, '\n');

  return decodeEntities(withBreaks.replace(ANY_TAG, ''))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** 供搜索结果使用的正文预览。 */
export function makeSnippet(text: string, maxLength = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.slice(0, maxLength) + '…';
}

export async function parseEmail(source: Buffer | string): Promise<ParsedEmail> {
  const parsed: ParsedMail = await simpleParser(source);

  const from = toAddresses(parsed.from)[0];
  const text = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '');

  const result: ParsedEmail = {
    to: toAddresses(parsed.to),
    cc: toAddresses(parsed.cc),
    subject: parsed.subject ?? '',
    text: text.trim(),
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? 'unnamed',
      contentType: a.contentType,
      size: a.size,
    })),
    references: Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : [],
  };

  if (parsed.messageId) result.messageId = parsed.messageId;
  if (parsed.date) result.date = parsed.date.toISOString();
  if (from) result.from = from;
  if (typeof parsed.html === 'string') result.html = parsed.html;
  if (parsed.inReplyTo) result.inReplyTo = parsed.inReplyTo;

  return result;
}
