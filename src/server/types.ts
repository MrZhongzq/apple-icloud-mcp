import type { ZodRawShape } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SessionStore } from '../core/session.js';
import type { Logger } from '../core/logger.js';

/**
 * MCP SDK 传给工具回调的第二个参数（`RequestHandlerExtra`）中我们用得到的那一小块。
 * 只声明 `authInfo`，因为工具层只关心"这次调用是谁授权的"：远程 HTTP 入口下
 * `requireBearerAuth` 会把 `verifyAccessToken` 的返回值挂在这里，stdio 入口下它是
 * undefined。整个接口都是可选的，所以 24 个不关心授权上下文的工具一行都不用改。
 */
export interface ToolExtra {
  authInfo?: AuthInfo;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** MCP 的 CallToolResult 带索引签名；不加这一行，真实 McpServer 无法赋值给 ToolRegistrar。 */
  [x: string]: unknown;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface ToolConfig {
  title?: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations?: ToolAnnotations;
}

/**
 * 真实的 McpServer 满足这个接口（其 CallToolResult 带索引签名，故 ToolResult 也带）。
 * 模块依赖这个最小接口而非具体实现，使工具层可以在不启动 MCP server 的情况下被测试。
 */
export interface ToolRegistrar {
  registerTool(
    name: string,
    config: ToolConfig,
    handler: (args: any, extra?: ToolExtra) => Promise<ToolResult>,
  ): unknown;
}

export interface ToolDeps {
  sessions: SessionStore;
  logger: Logger;
}
