import { AppError, toErrorPayload } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { ToolResult } from './types.js';

const asText = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** 统一的工具边界：序列化成功结果，把任何异常转成结构化错误载荷。 */
export function wrapTool<T>(
  logger: Logger,
  name: string,
  handler: (args: T) => Promise<unknown>,
): (args: T) => Promise<ToolResult> {
  return async (args: T): Promise<ToolResult> => {
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      logger.debug('tool ok', { tool: name, ms: Date.now() - startedAt });
      return asText(result);
    } catch (err) {
      const payload = toErrorPayload(err);
      logger.warn('tool failed', {
        tool: name,
        ms: Date.now() - startedAt,
        code: payload.error.code,
        detail: err instanceof AppError ? err.message : String(err),
      });
      return { ...asText(payload), isError: true };
    }
  };
}
