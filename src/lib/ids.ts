import { Types } from 'mongoose';
import { NotFoundError } from './errors';

/** An id from the URL. A malformed or missing one is "not found", the same answer as another organization's id. */
export function parseId(id: string | undefined, entity: string) {
  if (!id || !Types.ObjectId.isValid(id) || String(new Types.ObjectId(id)) !== id.toLowerCase()) {
    throw new NotFoundError(entity);
  }
  return new Types.ObjectId(id);
}
