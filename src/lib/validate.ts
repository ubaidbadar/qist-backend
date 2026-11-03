import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';
import { ValidationError } from './errors';

/** `zValidator` that fails with the API's VALIDATION_ERROR envelope, listing each invalid field. */
export const validate = <Target extends keyof ValidationTargets, Schema extends ZodType>(target: Target, schema: Schema) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const fields = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      throw new ValidationError('Some fields are invalid', { fields });
    }
  });
