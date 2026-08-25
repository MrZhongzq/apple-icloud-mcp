import { AppError, toErrorPayload } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { ToolExtra, ToolResult } from './types.js';

const asText = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/**
 * 统一的工具边界：序列化成功结果，把任何异常转成结构化错误载荷。
 *
 * 第二个参数 `extra` 是 MCP SDK 交给工具回调的请求上下文，这里原样透传给 handler。
 * 它是可选的，理由有二：stdio 入口根本没有 `authInfo`（没有 OAuth 这一层），而 25 个工具里
 * 只有 `apple_login` 需要读它——其余 24 个的 handler 仍然只声明 `(args)`，一个字都不用改。
 * 早先这里把第二个参数直接丢掉，结果是 `apple_login` 在结构上就无法知道自己属于哪个令牌
 * 家族，`sessions.create(account)` 只能不带家族地建会话，令牌吊销于是销毁不了任何会话。
 */
export function wrapTool<T>(
  logger: Logger,
  name: string,
  handler: (args: T, extra?: ToolExtra) => Promise<unknown>,
): (args: T, extra?: ToolExtra) => Promise<ToolResult> {
  return async (args: T, extra?: ToolExtra): Promise<ToolResult> => {
    const startedAt = Date.now();
    try {
      const result = await handler(args, extra);
      logger.debug('tool ok', { tool: name, ms: Date.now() - startedAt });
      return asText(result);
    } catch (err) {
      const payload = toErrorPayload(err);
      logger.warn('tool failed', {
        tool: name,
        ms: Date.now() - startedAt,
        code: payload.error.code,
        // AppError 的 message 是我们自己的固定文案，可安全记录；
        // 未映射的原始异常可能内嵌 LOGIN 行等凭据，只记类型名。
        detail: err instanceof AppError ? err.message : err instanceof Error ? err.name : typeof err,
      });
      return { ...asText(payload), isError: true };
    }
  };
}
