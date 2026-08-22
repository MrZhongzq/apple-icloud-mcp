export type ErrorCode =
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'SESSION_EXPIRED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export interface AppErrorOptions {
  hint?: string;
  retryable?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
    retryable: boolean;
  };
}

/** 把任意抛出物转成给模型看的结构化载荷。cause 只留在日志里，不外泄。 */
export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof AppError) {
    const error: ErrorPayload['error'] = {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
    };
    if (err.hint !== undefined) error.hint = err.hint;
    return { error };
  }
  return {
    error: {
      code: 'INTERNAL',
      message: '服务内部错误',
      retryable: false,
    },
  };
}
