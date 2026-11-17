import type { Query, Schema } from 'mongoose';

const crossTenantQueries = new WeakSet<object>();

/**
 * Marks one of the few queries that legitimately run before the organization is known: finding a user by email
 * to sign in, or by the user id inside a verified token.
 */
export function acrossTenants<Q extends object>(query: Q): Q {
  crossTenantQueries.add(query);
  return query;
}

const FILTERED_OPERATIONS =
  /^(find|findOne|findOneAndUpdate|findOneAndDelete|findOneAndReplace|updateOne|updateMany|replaceOne|deleteOne|deleteMany|countDocuments|distinct)$/;

/**
 * Safety net for collections that belong to an organization: a query whose filter has no `orgId` throws instead
 * of reading or changing another retailer's data. Aggregations must start with `{ $match: { orgId } }`.
 */
export function tenantGuard(schema: Schema) {
  schema.pre(FILTERED_OPERATIONS, function (this: Query<unknown, unknown>) {
    if (crossTenantQueries.has(this) || 'orgId' in this.getFilter()) return;
    throw new Error(`${this.model.modelName} query without an orgId filter`);
  });

  schema.pre('aggregate', function () {
    if (crossTenantQueries.has(this)) return;
    const firstStage = this.pipeline()[0];
    if (firstStage && '$match' in firstStage && 'orgId' in firstStage.$match) return;
    throw new Error(`${this.model().modelName} aggregation must start with { $match: { orgId } }`);
  });
}
