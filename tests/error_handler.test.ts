import { describe, expect, test } from 'bun:test';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ConflictError } from '../src/lib/errors';
import { createRouter } from '../src/lib/hono';
import { validate } from '../src/lib/validate';
import { onError, onNotFound } from '../src/middleware/error_handler';
import { readError } from './helpers';

const app = createRouter()
  .get('/conflict', () => {
    throw new ConflictError('IMEI already registered', { field: 'imei' });
  })
  .get('/crash', () => {
    throw new Error('secret internal detail');
  })
  .get('/bad-id', () => {
    throw new mongoose.Error.CastError('ObjectId', 'not-an-id', 'customerId');
  })
  .get('/duplicate', () => {
    throw new mongoose.mongo.MongoServerError({
      message: 'E11000 duplicate key error',
      code: 11000,
      keyPattern: { orgId: 1, cnic: 1 },
      keyValue: { orgId: 'org1', cnic: '35202-1234567-1' },
    });
  })
  .post('/echo', validate('json', z.object({ name: z.string().min(2) })), (c) => c.json({ data: c.req.valid('json') }));
app.onError(onError);
app.notFound(onNotFound);

const postJson = (body: string) => app.request('/echo', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });

describe('error envelope', () => {
  test('AppError keeps its status, code, message and details', async () => {
    const res = await app.request('/conflict');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: 'CONFLICT', message: 'IMEI already registered', details: { field: 'imei' } },
    });
  });

  test('unexpected errors become a generic 500 without internals', async () => {
    const res = await app.request('/crash');
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR');
    expect(text).not.toContain('secret internal detail');
    expect(text).not.toContain('at ');
  });

  test('invalid input lists the failing fields', async () => {
    const res = await postJson(JSON.stringify({ name: 'A' }));
    const error = await readError(res);
    expect(res.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual({ fields: [{ path: 'name', message: expect.any(String) }] });
  });

  test('malformed JSON is a validation error, not a crash', async () => {
    const res = await postJson('{"name":');
    expect(res.status).toBe(400);
    expect((await readError(res)).code).toBe('VALIDATION_ERROR');
  });

  test('valid input passes through', async () => {
    const res = await postJson(JSON.stringify({ name: 'Ali' }));
    expect(await res.json()).toEqual({ data: { name: 'Ali' } });
  });

  test('an invalid id from the database layer is a validation error', async () => {
    const res = await app.request('/bad-id');
    expect(res.status).toBe(400);
    expect(await readError(res)).toEqual({ code: 'VALIDATION_ERROR', message: 'Invalid customerId' });
  });

  test('a duplicate key is a conflict that names the field but never echoes the value', async () => {
    const res = await app.request('/duplicate');
    const text = await res.text();
    expect(res.status).toBe(409);
    expect(JSON.parse(text).error).toEqual({
      code: 'CONFLICT',
      message: 'This already exists',
      details: { fields: [{ path: 'cnic', message: 'Already in use' }] },
    });
    expect(text).not.toContain('35202');
  });

  test('unknown routes return the NOT_FOUND envelope', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect((await readError(res)).code).toBe('NOT_FOUND');
  });
});
