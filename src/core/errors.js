export class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest: (code, message, details) => new AppError(400, code, message, details),
  unauthorized: (code = 'UNAUTHORIZED', message = 'Authentication required') => new AppError(401, code, message),
  forbidden: (code = 'FORBIDDEN', message = 'Permission denied') => new AppError(403, code, message),
  notFound: (code = 'NOT_FOUND', message = 'Resource not found') => new AppError(404, code, message),
  conflict: (code, message) => new AppError(409, code, message),
  rateLimited: (code = 'RATE_LIMITED', message = 'Too many requests') => new AppError(429, code, message),
  unavailable: (code, message) => new AppError(503, code, message),
};

const STATUS_DEFAULTS = new Map([
  [400, ['BAD_REQUEST', 'Invalid request']],
  [401, ['UNAUTHORIZED', 'Authentication required']],
  [403, ['FORBIDDEN', 'Permission denied']],
  [404, ['ROUTE_NOT_FOUND', 'Route not found']],
  [405, ['METHOD_NOT_ALLOWED', 'Method not allowed']],
  [406, ['NOT_ACCEPTABLE', 'Requested response format is not acceptable']],
  [408, ['REQUEST_TIMEOUT', 'Request timed out']],
  [409, ['CONFLICT', 'Request conflicts with current resource state']],
  [413, ['PAYLOAD_TOO_LARGE', 'Request body is too large']],
  [415, ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type']],
  [422, ['UNPROCESSABLE_CONTENT', 'Request could not be processed']],
  [429, ['RATE_LIMITED', 'Too many requests']],
]);

const FASTIFY_CODE_OVERRIDES = new Map([
  ['FST_ERR_CTP_INVALID_MEDIA_TYPE', ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type']],
  ['FST_ERR_CTP_INVALID_JSON_BODY', ['INVALID_JSON', 'Request body contains invalid JSON']],
  ['FST_ERR_CTP_BODY_TOO_LARGE', ['PAYLOAD_TOO_LARGE', 'Request body is too large']],
]);

export function normalizeHttpClientError(error) {
  const statusCode = Number(error?.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode >= 500) return null;

  const fastifyOverride = FASTIFY_CODE_OVERRIDES.get(error?.code);
  const [code, message] = fastifyOverride || STATUS_DEFAULTS.get(statusCode) || [`HTTP_${statusCode}`, 'Request failed'];
  return { statusCode, code, message };
}
