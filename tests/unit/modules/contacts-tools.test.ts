import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { registerContactTools } from '../../../src/modules/contacts/tools.js';
import { createLogger } from '../../../src/core/logger.js';
import { AppError } from '../../../src/core/errors.js';
import type { ToolConfig, ToolResult } from '../../../src/server/types.js';
import type { SessionStore } from '../../../src/core/session.js';

interface Registered {
  config: ToolConfig;
  handler: (args: any) => Promise<ToolResult>;
}

function collect(): { server: any; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: ToolConfig, handler: (args: any) => Promise<ToolResult>) {
      tools.set(name, { config, handler });
    },
  };
  return { server, tools };
}

const silentLogger = createLogger('error', () => {});
const fakeSessions = {
  get: vi.fn().mockReturnValue({ id: 's1', account: { id: 'account_1' }, providers: {} }),
} as unknown as SessionStore;

function depsWith(service: Record<string, unknown>) {
  return { sessions: fakeSessions, logger: silentLogger, contactFor: () => service as never };
}

describe('registerContactTools', () => {
  it('registers every contact tool', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    expect([...tools.keys()].sort()).toEqual([
      'contacts_create',
      'contacts_delete',
      'contacts_read',
      'contacts_search',
      'contacts_update',
    ]);
  });

  it('carries the specified annotations and no idempotentHint', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    expect(tools.get('contacts_search')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('contacts_read')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('contacts_create')!.config.annotations?.destructiveHint).toBe(false);
    expect(tools.get('contacts_update')!.config.annotations?.destructiveHint).toBe(false);
    expect(tools.get('contacts_update')!.config.annotations?.idempotentHint).toBeUndefined();
    expect(tools.get('contacts_delete')!.config.annotations?.destructiveHint).toBe(true);
  });

  it('advertises no top-level field the handler does not read', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    const allowed: Record<string, string[]> = {
      contacts_search: ['session_id', 'query', 'address_book_ids', 'limit'],
      contacts_read: ['session_id', 'contact_id'],
      contacts_create: ['session_id', 'address_book_id', 'contact'],
      contacts_update: ['session_id', 'contact_id', 'patch', 'expected_etag'],
      contacts_delete: ['session_id', 'contact_id', 'expected_etag'],
    };
    for (const [name, tool] of tools) {
      const keys = Object.keys(tool.config.inputSchema as Record<string, unknown>).sort();
      expect(keys, name + ' 的 inputSchema 顶层字段与 handler 读取的不一致').toEqual(allowed[name]!.sort());
    }
  });

  it('never requires an etag', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    for (const name of ['contacts_update', 'contacts_delete']) {
      const shape = tools.get(name)!.config.inputSchema as Record<string, z.ZodTypeAny>;
      expect(shape.expected_etag!.isOptional()).toBe(true);
    }
  });

  it('documents that photos are never returned', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    const text = tools.get('contacts_read')!.config.description ?? '';
    expect(text).toMatch(/has_photo/);
  });

  it('names only contacts tools in its own descriptions', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    for (const [name, tool] of tools) {
      const blob = JSON.stringify(tool.config);
      expect(blob, name + ' 的描述指向了别的域的工具').not.toMatch(/calendar_|reminders_|mail_/);
    }
  });

  it('forwards the search query verbatim', async () => {
    const { server, tools } = collect();
    const search = vi.fn().mockResolvedValue({ contacts: [] });
    registerContactTools(server, depsWith({ search }));

    await tools.get('contacts_search')!.handler({
      session_id: 's1',
      query: '张三',
      address_book_ids: ['abc'],
      limit: 20,
    });

    expect(search).toHaveBeenCalledWith({ query: '张三', address_book_ids: ['abc'], limit: 20 });
  });

  it('forwards the contact object and address_book_id on create', async () => {
    const { server, tools } = collect();
    const create = vi.fn().mockResolvedValue({ contact_id: 'c1' });
    registerContactTools(server, depsWith({ create }));

    await tools.get('contacts_create')!.handler({
      session_id: 's1',
      address_book_id: 'b1',
      contact: { name: { full: '张三' }, emails: [{ value: 'a@example.com' }] },
    });

    expect(create).toHaveBeenCalledWith(
      { name: { full: '张三' }, emails: [{ value: 'a@example.com' }] },
      'b1',
    );
  });

  it('forwards patch and expected_etag on update, in that order', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ contact_id: 'c1' });
    registerContactTools(server, depsWith({ update }));

    await tools.get('contacts_update')!.handler({
      session_id: 's1',
      contact_id: 'c1',
      patch: { title: '架构师' },
      expected_etag: 'e1',
    });

    expect(update).toHaveBeenCalledWith('c1', { title: '架构师' }, { expected_etag: 'e1' });
  });

  it('accepts a null scalar as an explicit clear', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ contact_id: 'c1' });
    registerContactTools(server, depsWith({ update }));

    const result = await tools.get('contacts_update')!.handler({
      session_id: 's1',
      contact_id: 'c1',
      patch: { note: null },
    });

    expect(result.isError).toBeUndefined();
    expect(update).toHaveBeenCalledWith('c1', { note: null }, { expected_etag: undefined });
  });

  it('accepts an empty array as an explicit clear', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ contact_id: 'c1' });
    registerContactTools(server, depsWith({ update }));

    await tools.get('contacts_update')!.handler({
      session_id: 's1',
      contact_id: 'c1',
      patch: { emails: [] },
    });

    expect(update).toHaveBeenCalledWith('c1', { emails: [] }, { expected_etag: undefined });
  });

  it('forwards the id and expected_etag on delete', async () => {
    const { server, tools } = collect();
    const remove = vi.fn().mockResolvedValue({ deleted: true });
    registerContactTools(server, depsWith({ remove }));

    await tools.get('contacts_delete')!.handler({ session_id: 's1', contact_id: 'c1', expected_etag: 'e1' });

    expect(remove).toHaveBeenCalledWith('c1', { expected_etag: 'e1' });
  });

  it('converts an AppError into a structured payload', async () => {
    const { server, tools } = collect();
    const search = vi
      .fn()
      .mockRejectedValue(
        new AppError('PERMISSION_DENIED', '通讯录读取权限未开启', { hint: '设置 ALLOW_CONTACTS_READ_1=true' }),
      );
    registerContactTools(server, depsWith({ search }));

    const result = await tools.get('contacts_search')!.handler({ session_id: 's1' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe('PERMISSION_DENIED');
    expect(payload.error.hint).toContain('ALLOW_CONTACTS_READ_1');
  });
});

// 上面那些 handler(...) 直接调用的用例没有经过任何校验：wrapTool 不校验，
// 所以即使把 contactShape 里的 .nullable() 删干净，它们也照样绿——而真实的 McpServer
// 会在 handler 跑之前就把 null 退回。下面这组直接对 inputSchema 本体 safeParse，
// 盯的就是那一层（三态清除与 contactSchema 的 name 必填 refine）。
describe('contact tool input schemas', () => {
  const SCALARS = ['nickname', 'organization', 'department', 'title', 'note'] as const;
  const REPEATABLES = ['emails', 'phones', 'addresses', 'urls', 'impp'] as const;

  function schemaOf(tool: string) {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    return z.object(tools.get(tool)!.config.inputSchema as Record<string, z.ZodTypeAny>);
  }

  it('accepts null for every three-state scalar in an update patch', () => {
    const schema = schemaOf('contacts_update');
    for (const field of [...SCALARS, 'birthday'] as const) {
      const result = schema.safeParse({ session_id: 's1', contact_id: 'c1', patch: { [field]: null } });
      expect(result.success, `patch.${field} 不接受 null，清除语义就断了`).toBe(true);
    }
  });

  it('accepts null for every three-state scalar on create', () => {
    const schema = schemaOf('contacts_create');
    for (const field of [...SCALARS, 'birthday'] as const) {
      const result = schema.safeParse({
        session_id: 's1',
        contact: { name: { full: '张三' }, [field]: null },
      });
      expect(result.success, `contact.${field} 不接受 null`).toBe(true);
    }
  });

  it('accepts an empty array for every repeatable field', () => {
    const update = schemaOf('contacts_update');
    const create = schemaOf('contacts_create');
    for (const field of REPEATABLES) {
      expect(
        update.safeParse({ session_id: 's1', contact_id: 'c1', patch: { [field]: [] } }).success,
        `patch.${field} 不接受空数组，清空语义就断了`,
      ).toBe(true);
      expect(
        create.safeParse({ session_id: 's1', contact: { name: { full: '张三' }, [field]: [] } }).success,
        `contact.${field} 不接受空数组`,
      ).toBe(true);
    }
  });

  it('rejects a nameless contact on create', () => {
    const schema = schemaOf('contacts_create');
    expect(schema.safeParse({ session_id: 's1', contact: { name: {} } }).success).toBe(false);
    expect(schema.safeParse({ session_id: 's1', contact: {} }).success).toBe(false);
    for (const name of [{ full: '张三' }, { family: '张' }, { given: '三' }]) {
      expect(schema.safeParse({ session_id: 's1', contact: { name } }).success, JSON.stringify(name)).toBe(true);
    }
  });

  // 一个格式非法的生日写进卡片后会让该联系人在本服务里永久失联，
  // 所以工具边界也要拦一道，不只依赖 parsers/vcard.ts。
  it('rejects a malformed birthday at the schema boundary', () => {
    const schema = schemaOf('contacts_update');
    for (const bad of ['next tuesday', '1990/05/20', '90-05-20', '1990']) {
      expect(
        schema.safeParse({ session_id: 's1', contact_id: 'c1', patch: { birthday: bad } }).success,
        bad,
      ).toBe(false);
    }
    for (const good of ['1990-05-20', '--05-20']) {
      expect(
        schema.safeParse({ session_id: 's1', contact_id: 'c1', patch: { birthday: good } }).success,
        good,
      ).toBe(true);
    }
  });
});
