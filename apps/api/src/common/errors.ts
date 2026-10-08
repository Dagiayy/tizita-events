import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ZodError } from 'zod';
import { requestContext } from './request-context';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message ?? code);
  }
}

export const E = {
  badRequest: (code = 'bad_request', msg?: string, details?: unknown) => new AppError(400, code, msg, details),
  unauthorized: (code = 'unauthorized', msg?: string) => new AppError(401, code, msg),
  forbidden: (code = 'forbidden', msg?: string, details?: unknown) => new AppError(403, code, msg, details),
  notFound: (code = 'not_found', msg?: string) => new AppError(404, code, msg),
  conflict: (code = 'conflict', msg?: string, details?: unknown) => new AppError(409, code, msg, details),
  gone: (code = 'gone', msg?: string) => new AppError(410, code, msg),
  tooLarge: (code = 'payload_too_large', msg?: string) => new AppError(413, code, msg),
  unsupported: (code = 'unsupported_media_type', msg?: string) => new AppError(415, code, msg),
  unprocessable: (code = 'unprocessable', msg?: string, details?: unknown) => new AppError(422, code, msg, details),
  tooMany: (retryAfterSec: number, code = 'rate_limited') =>
    new AppError(429, code, 'Too many requests', { retry_after_sec: retryAfterSec }, { 'Retry-After': String(Math.max(1, retryAfterSec)) }),
  unavailable: (code = 'service_unavailable', msg?: string) => new AppError(503, code, msg),
};

/**
 * Safe error responses: client errors return a stable code; unexpected errors never leak internals
 * (stack, SQL, object keys) - they are logged server-side with the request id instead.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const requestId = requestContext()?.requestId;
    let status = 500;
    let code = 'internal_error';
    let message = 'Something went wrong. Please try again.';
    let details: unknown;

    if (err instanceof AppError) {
      status = err.status; code = err.code; message = err.message; details = err.details;
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
    } else if (err instanceof ZodError) {
      status = 400; code = 'validation_failed'; message = 'Request validation failed';
      details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if ((err as any)?.type === 'entity.too.large') {
      status = 413; code = 'payload_too_large'; message = 'Payload too large';
    } else if ((err as any)?.type === 'entity.parse.failed') {
      status = 400; code = 'invalid_json'; message = 'Malformed JSON body';
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      code = status === 404 ? 'not_found' : status === 413 ? 'payload_too_large' : /JSON|Unexpected (token|end)/i.test(err.message) ? 'invalid_json' : 'http_error';
      message = status >= 500 ? message : code === 'invalid_json' ? 'Malformed JSON body' : err.message;
    }
    if (status >= 500) {
      if (err instanceof AppError) this.log.warn(`[${requestId}] ${err.code}`);   // expected operational failures: no stack
      else this.log.error(`[${requestId}] ${(err as Error)?.stack ?? err}`);
    }
    res.status(status).json({ error: { code, message, request_id: requestId, ...(details !== undefined ? { details } : {}) } });
  }
}
