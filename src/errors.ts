/**
 * 统一错误码。HTTP 层据此映射状态码，CLI 层据此输出中文原因并以非零码退出。
 */
export type ErrorCode =
  | "INVALID_PARAM"
  | "NOT_FOUND"
  | "OVERLAP_CONFLICT"
  | "INVALID_RANGE"
  | "BATCH_REJECTED"
  | "LIMIT_EXCEEDED"
  | "EMPTY_RESULT";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_PARAM: 400,
  NOT_FOUND: 404,
  OVERLAP_CONFLICT: 409,
  INVALID_RANGE: 422,
  BATCH_REJECTED: 422,
  LIMIT_EXCEEDED: 413,
  EMPTY_RESULT: 200,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}
