import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { deriveFlags, parseFlags, renderHelp } from '../../../src/cli/flags.js';
import type { ToolConfig } from '../../../src/server/types.js';

function cfg(shape: Record<string, z.ZodTypeAny>): ToolConfig {
  return { description: '测试工具', inputSchema: shape };
}

const sample = cfg({
  session_id: z.string().describe('会话'),
  folder: z.string().optional().describe('邮件文件夹'),
  unseen: z.boolean().optional(),
  limit: z.number().int().optional(),
  note: z.string().nullable().optional(),
  query: z.object({ from: z.string().optional() }).optional(),
  tags: z.array(z.string()).optional(),
  subject: z.string(),
});

describe('boolean flags', () => {
  // 布尔参数只能置 true 的话，三态布尔里"显式 false"这一态在命令行上根本
  // 写不出来。这不是理论问题：`reminders_list --completed` 是"只看已完成"，
  // 而"只看未完成"——提醒事项最常见的那个查询——无从表达；
  // `calendar_list_events --expand_recurring` 默认 true，想要 false 同理。
  const boolCfg = cfg({ completed: z.boolean().optional(), other: z.string().optional() });

  it('sets true when the flag is present', () => {
    expect(parseFlags(deriveFlags(boolCfg), ['--completed'])).toEqual({ completed: true });
  });

  it('sets false for --no-<key>', () => {
    expect(parseFlags(deriveFlags(boolCfg), ['--no-completed'])).toEqual({ completed: false });
  });

  it('omits the field entirely when neither form is given — the third state', () => {
    expect(parseFlags(deriveFlags(boolCfg), [])).toEqual({});
  });

  it('still rejects a value after a boolean flag, since it never consumes one', () => {
    expect(() => parseFlags(deriveFlags(boolCfg), ['--completed', 'true'])).toThrow(/true/);
  });

  it('does not invent --no- for non-boolean flags', () => {
    expect(() => parseFlags(deriveFlags(boolCfg), ['--no-other'])).toThrow(/--no-other/);
  });
});

describe('deriveFlags', () => {
  it('never exposes session_id, which the CLI injects itself', () => {
    const keys = deriveFlags(sample).map((f) => f.key);
    expect(keys, 'session_id 由 CLI 隐式注入，做成 flag 等于要用户填一个他拿不到的值').not.toContain(
      'session_id',
    );
  });

  it('maps each schema type to the right flag kind', () => {
    const by = Object.fromEntries(deriveFlags(sample).map((f) => [f.key, f]));
    expect(by.folder!.kind).toBe('string');
    expect(by.unseen!.kind).toBe('boolean');
    expect(by.limit!.kind).toBe('number');
    expect(by.query!.kind, '嵌套对象只能整块传 JSON').toBe('json');
    expect(by.tags!.kind).toBe('json');
  });

  it('marks a non-optional field required', () => {
    const by = Object.fromEntries(deriveFlags(sample).map((f) => [f.key, f]));
    expect(by.subject!.required).toBe(true);
    expect(by.folder!.required).toBe(false);
  });

  it('flags a nullable field so an unset variant can be offered', () => {
    const by = Object.fromEntries(deriveFlags(sample).map((f) => [f.key, f]));
    expect(by.note!.nullable).toBe(true);
    expect(by.folder!.nullable).toBe(false);
  });

  it('carries the schema description through, whichever side of the wrapper it sits on', () => {
    // zod 4.4.3 实测：optional().describe() 的描述在最外层，
    // describe().optional() 的最外层是 undefined、描述在内层。本项目两种写法都有。
    const both = cfg({
      outer: z.string().optional().describe('外层描述'),
      inner: z.string().describe('内层描述').optional(),
    });
    const by = Object.fromEntries(deriveFlags(both).map((f) => [f.key, f]));
    expect(by.outer!.description).toBe('外层描述');
    expect(by.inner!.description, '只看最外层会让这一半的帮助文本静默变空').toBe('内层描述');
  });

  it('reads enum choices from the schema for display, not just its kind', () => {
    const withEnum = cfg({
      format: z.enum(['text', 'html', 'both']).optional().describe('正文格式'),
    });
    const by = Object.fromEntries(deriveFlags(withEnum).map((f) => [f.key, f]));
    expect(by.format!.kind).toBe('string');
    expect(by.format!.choices).toEqual(['text', 'html', 'both']);
  });
});

describe('parseFlags', () => {
  const specs = deriveFlags(sample);

  it('parses each kind into the right JS type', () => {
    const got = parseFlags(specs, [
      '--subject', 'hi',
      '--folder', 'INBOX',
      '--unseen',
      '--limit', '10',
      '--query', '{"from":"a@b.c"}',
      '--tags', '["x","y"]',
    ]);
    expect(got).toEqual({
      subject: 'hi',
      folder: 'INBOX',
      unseen: true,
      limit: 10,
      query: { from: 'a@b.c' },
      tags: ['x', 'y'],
    });
  });

  it('omits what was not given, rather than filling in defaults', () => {
    const got = parseFlags(specs, ['--subject', 'hi']);
    expect(Object.keys(got)).toEqual(['subject']);
    expect('folder' in got, '没给的参数不能凭空出现，否则会覆盖服务端的默认值').toBe(false);
  });

  it('turns --unset-note into an explicit null', () => {
    const got = parseFlags(specs, ['--subject', 'hi', '--unset-note']);
    expect(got.note, 'null 表示清除该字段，与「省略」是两回事').toBeNull();
  });

  it('refuses to both set and unset the same field', () => {
    expect(() => parseFlags(specs, ['--subject', 'hi', '--note', 'x', '--unset-note'])).toThrow();
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseFlags(specs, ['--subject', 'hi', '--nonsense', 'x']),
      '静默忽略拼错的 flag，会让人以为参数生效了').toThrow();
  });

  it('rejects a missing required flag', () => {
    expect(() => parseFlags(specs, ['--folder', 'INBOX'])).toThrow();
  });

  it('rejects a value-taking flag with no value', () => {
    expect(() => parseFlags(specs, ['--subject'])).toThrow();
  });

  it('rejects a non-numeric value for a number flag', () => {
    expect(() => parseFlags(specs, ['--subject', 'hi', '--limit', 'abc'])).toThrow();
  });

  it('rejects malformed json rather than passing the raw string through', () => {
    expect(() => parseFlags(specs, ['--subject', 'hi', '--query', '{not json'])).toThrow();
  });

  it('accepts a value that begins with a dash when it follows a value-taking flag', () => {
    const got = parseFlags(specs, ['--subject', '-weird-subject']);
    expect(got.subject, '以短横开头的合法值不能被误判成另一个 flag').toBe('-weird-subject');
  });
});

describe('renderHelp', () => {
  it('lists every flag with its type, and marks the required ones', () => {
    const text = renderHelp('mail_search', sample, deriveFlags(sample));
    expect(text).toContain('mail_search');
    expect(text).toContain('--folder');
    expect(text).toContain('--unset-note');
    expect(text).toMatch(/--subject[^\n]*必填|必填[^\n]*--subject/);
    expect(text, '帮助里不该出现由 CLI 注入的参数').not.toContain('--session_id');
  });

  it('shows what the parser actually accepts for a boolean, not a value placeholder', () => {
    // 早先印的是 `--unseen <boolean>`，读起来像"要跟一个值"；照做
    // （`--unseen true`）得到的是 `未知参数：true`、退出码 1。帮助由 schema
    // 生成的全部意义就在于它不会和真实行为漂移——一份和解析器矛盾的帮助
    // 比没有帮助更糟，和 daemon 那条"用 --list 查看"的提示是同一种毛病。
    const text = renderHelp('mail_search', sample, deriveFlags(sample));
    expect(text, '布尔参数不吃值').not.toContain('--unseen <boolean>');
    expect(text).toContain('--unseen | --no-unseen');
  });

  it('lists every allowed value for an enum flag, not just <string>', () => {
    const withEnum = cfg({
      format: z.enum(['text', 'html', 'both']).optional().describe('正文格式'),
    });
    const specs = deriveFlags(withEnum);
    const text = renderHelp('mail_read', withEnum, specs);
    expect(text, '调用方光看类型名猜不出合法取值').toContain('--format <text|html|both>');
    for (const value of ['text', 'html', 'both']) {
      expect(text).toContain(value);
    }
  });
});
