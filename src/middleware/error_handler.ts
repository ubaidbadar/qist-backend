import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import mongoose from 'mongoose';
import type { ApiFailure, ErrorCode } from '@shop/shared';
import { AppError, ConflictError, RateLimitError, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { AppEnv } from '../lib/hono';

// Hono's own exceptions (malformed JSON, …) carry only a status; give them the matching API code.
const CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
};

const DUPLICATE_KEY = 11000;

/** Database errors the request caused (bad id, schema violation, duplicate), when a service didn't map them first. */
function fromDatabaseError(err: Error): AppError | undefined {
  if (err instanceof mongoose.Error.CastError) return new ValidationError(`Invalid ${err.path}`);
  if (err instanceof mongoose.Error.ValidationError) {
    const fields = Object.values(err.errors).map(({ path, message }) => ({ path, message }));
    return new ValidationError('Some fields are invalid', { fields });
  }
  if (err instanceof mongoose.mongo.MongoServerError && err.code === DUPLICATE_KEY) {
    // Field names only: the duplicate values can be personal data (CNIC, phone).
    const fields = Object.keys(err.keyPattern ?? {})
      .filter((key) => key !== 'orgId')
      .map((path) => ({ path, message: 'Already in use' }));
    return new ConflictError('This already exists', { fields });
  }
  return undefined;
}

export function errorResponse(c: Context, error: AppError) {
  if (error instanceof RateLimitError) c.header('Retry-After', String(error.retryAfterSeconds));
  const body: ApiFailure = { error: { code: error.code, message: error.message, details: error.details } };
  return c.json(body, error.status);
}

/** Turns every thrown error into the `{ error }` envelope. Unexpected errors are logged and never leak details. */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof AppError) return errorResponse(c, err);

  const databaseError = fromDatabaseError(err);
  if (databaseError) return errorResponse(c, databaseError);

  const code = err instanceof HTTPException ? CODE_BY_STATUS[err.status] : undefined;
  if (err instanceof HTTPException && code) {
    return errorResponse(c, new AppError(code, err.status, err.message));
  }

  logger.error('Unhandled error', { requestId: c.get('requestId'), method: c.req.method, path: c.req.path, err });
  return errorResponse(c, new AppError('INTERNAL_ERROR', 500, 'Something went wrong'));
};

export const onNotFound: NotFoundHandler = (c) => errorResponse(c, new AppError('NOT_FOUND', 404, 'Route not found'));
