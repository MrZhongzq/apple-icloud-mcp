import { registerAllTools } from '../server/createServer.js';
import type { AppConfig } from '../core/config.js';
import type { SessionStore } from '../core/session.js';
import type { Logger } from '../core/logger.js';
import type { ToolConfig, ToolExtra, ToolRegistrar, ToolResult } from '../server/types.js';

export interface CollectedTool {
  name: string;
  config: ToolConfig;
  handler: (args: unknown, extra?: ToolExtra) => Promise<ToolResult>;
}

/**
 * 用收集型 registrar 跑一遍 registerAllTools，拿到全部已注册工具（含 schema 与 handler），
 * 不启动任何 MCP server。以后谁加了工具，这里自动就有——不做任何校验或转换，
 * 纯粹是把 registerTool 的三个参数收进 Map。
 */
export function collectTools(deps: {
  config: AppConfig;
  sessions: SessionStore;
  logger: Logger;
}): Map<string, CollectedTool> {
  const tools = new Map<string, CollectedTool>();

  const collector: ToolRegistrar = {
    registerTool(name, config, handler) {
      tools.set(name, { name, config, handler });
      return undefined;
    },
  };

  registerAllTools(collector, deps);

  return tools;
}
