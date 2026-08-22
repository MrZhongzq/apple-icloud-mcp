import type { ZodRawShape } from 'zod';
import type { SessionStore } from '../core/session.js';
import type { Logger } from '../core/logger.js';

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
    handler: (args: any) => Promise<ToolResult>,
  ): unknown;
}

export interface ToolDeps {
  sessions: SessionStore;
  logger: Logger;
}
