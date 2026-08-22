export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const SENSITIVE_KEY = /pass|password|secret|token|authorization|credential|appPass/i;

/** 递归遮蔽敏感字段。凭据永远不进日志。 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return value;
}

export interface Logger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/** 默认写 stderr —— stdout 在 stdio 传输下属于 MCP 协议，绝不可占用。 */
const writeStderr = (line: string): void => {
  process.stderr.write(line + '\n');
};

export function createLogger(level: LogLevel, write: (line: string) => void = writeStderr): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] > threshold) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
    };
    if (meta) record.meta = redact(meta);
    write(JSON.stringify(record));
  };

  return {
    error: (m, meta) => emit('error', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    info: (m, meta) => emit('info', m, meta),
    debug: (m, meta) => emit('debug', m, meta),
  };
}
