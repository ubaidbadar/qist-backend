import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode } from '@shop/shared';

/** An expected failure: its code, message and details are safe to send to the client. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: ContentfulStatusCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The `details` shape for problems tied to form fields, so the portal can show each message under its input. */
export const fieldDetails = (path: string, message: string) => ({ fields: [{ path, message }] });

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) {
    super('VALIDATION_ERROR', 400, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Please sign in again') {
    super('UNAUTHORIZED', 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this') {
    super('FORBIDDEN', 403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(entity = 'Resource') {
    super('NOT_FOUND', 404, `${entity} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', 409, message, details);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor() {
    super('PAYLOAD_TOO_LARGE', 413, 'Request body is too large');
  }
}

export class RateLimitError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super('RATE_LIMITED', 429, 'Too many requests, please try again shortly');
  }
}
