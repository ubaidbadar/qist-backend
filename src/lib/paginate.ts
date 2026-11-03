import { Types, type Query } from 'mongoose';
import type { Page, PageQuery } from '@shop/shared';

/**
 * Newest first, `limit` at a time. The cursor is the _id of the last item already shown, so pages stay stable
 * while new records arrive at the top, and each page is read through an index ending in `_id: -1`.
 */
export async function paginate<T extends { _id: Types.ObjectId }>(
  query: Query<T[], unknown>,
  { limit, cursor }: PageQuery,
): Promise<Page<T>> {
  if (cursor) query.where({ _id: { $lt: new Types.ObjectId(cursor) } });
  const rows = await query.sort({ _id: -1 }).limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? String(items[items.length - 1]._id) : null };
}
