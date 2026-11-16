import { createHash, createPublicKey, verify, randomBytes } from 'node:crypto';
import { Types, type PipelineStage } from 'mongoose';
import { Device } from '../models/device';
import { Contract } from '../models/contract';
import { CustomerAccount } from '../models/customer_account';
import { CustomerAuthHandoff } from '../models/customer_auth_handoff';
import { UnauthorizedError } from './errors';

export const signinHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const signinRandom = () => randomBytes(32).toString('base64url');
export const SIGNIN_TTL_MS = 3 * 60_000;
export const SIGNIN_SELECT = '+enrollment.authPublicKey +enrollment.secretHash';

export function signinPublicKey(encoded: string) {
  const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('P-256 required');
  if (Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw new Error('Invalid key encoding');
  return key;
}
export function validSigninSignature(publicKey: string, payload: string, signature: string) {
  try { return verify('sha256', Buffer.from(payload), signinPublicKey(publicKey), Buffer.from(signature, 'base64url')); }
  catch { return false; }
}
export const keyRegistrationPayload = (deviceId: string, keyId: string) => `qist-customer-key-v1\n${deviceId}\n${keyId}`;
export function signinPayload(request: { _id: unknown; kind: string; challenge: string; nonceHash: string; expiresAt: Date }, deviceId: string, decision: string, number: string) {
  return ['qist-customer-signin-v1', request.kind, String(request._id), deviceId, request.challenge, request.nonceHash, request.expiresAt.toISOString(), decision, number].join('\n');
}

/** These lookups stay inside MongoDB; no per-contract/customer follow-up queries. */
export function signinOwnerStages(): Exclude<PipelineStage, PipelineStage.Merge | PipelineStage.Out>[] {
  return [
    { $sort: { _id: -1 } }, { $limit: 1 },
    { $lookup: { from: 'orgs', localField: 'orgId', foreignField: '_id', pipeline: [{ $match: { status: 'active' } }, { $project: { _id: 1 } }], as: 'activeOrg' } },
    { $match: { 'activeOrg.0': { $exists: true } } },
    { $lookup: { from: 'customers', let: { customer: '$customerId', org: '$orgId' }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$_id', '$$customer'] }, { $eq: ['$orgId', '$$org'] }] } } }, { $project: { phone: 1 } },
    ], as: 'owner' } },
    { $unwind: '$owner' }, { $project: { _id: 0, phone: '$owner.phone' } },
  ];
}
export const eligibleSigninContracts = ['active', 'defaulted', 'completed'];
export function signinIdentityStages(): Exclude<PipelineStage, PipelineStage.Merge | PipelineStage.Out>[] {
  return [
    { $lookup: { from: 'contracts', let: { device: '$_id', org: '$orgId' }, pipeline: [
      { $match: { status: { $in: eligibleSigninContracts }, $expr: { $and: [{ $eq: ['$deviceId', '$$device'] }, { $eq: ['$orgId', '$$org'] }] } } },
      ...signinOwnerStages(),
    ], as: 'identity' } },
    { $unwind: '$identity' }, { $set: { phone: '$identity.phone' } }, { $unset: 'identity' },
  ];
}
/** Resolve identity from the current tenant-scoped agreement, never a client assertion. */
export async function signinOwner(deviceId: Types.ObjectId, orgId: Types.ObjectId) {
  const [identity] = await Contract.aggregate<{ phone: string }>([
    { $match: { orgId, deviceId, status: { $in: eligibleSigninContracts } } }, ...signinOwnerStages(),
  ]);
  if (!identity?.phone) throw new UnauthorizedError('This phone is not eligible for customer sign-in.');
  return identity.phone;
}
export async function currentSigninDevice(deviceId: Types.ObjectId, orgId: Types.ObjectId, enrollmentHash: string, keyId?: string | null) {
  const [device] = await Device.aggregate<{
    _id: Types.ObjectId; orgId: Types.ObjectId; phone: string;
    enrollment: { secretHash: string; authKeyId: string | null; authPublicKey: string | null };
  }>([
    { $match: { orgId, _id: deviceId, stockStatus: { $ne: 'released' }, 'enrollment.secretHash': enrollmentHash, ...(keyId ? { 'enrollment.authKeyId': keyId } : {}) } },
    ...signinIdentityStages(),
    { $project: { _id: 1, orgId: 1, phone: 1, 'enrollment.secretHash': 1, 'enrollment.authKeyId': 1, 'enrollment.authPublicKey': 1 } },
  ]);
  if (!device?.enrollment) throw new UnauthorizedError('Device sign-in is no longer valid.');
  return device;
}
export async function signinAccount(phone: string) {
  try {
    return await CustomerAccount.findOneAndUpdate({ phone }, { $setOnInsert: { phone } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }).select('+tokenVersion').lean();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 11000) throw error;
    return CustomerAccount.findOne({ phone }).select('+tokenVersion').lean();
  }
}
export async function createSigninHandoff(device: { _id: Types.ObjectId; orgId: Types.ObjectId; enrollment: { secretHash: string; authKeyId?: string | null } }, nonce: string, phone: string, accountId: Types.ObjectId, accountVersion: number) {
  const ticket = signinRandom();
  const expiresAt = new Date(Date.now() + 60_000);
  await CustomerAuthHandoff.create({ ticketHash: signinHash(ticket), nonceHash: signinHash(nonce), phone, orgId: device.orgId, deviceId: device._id, enrollmentHash: device.enrollment.secretHash, keyId: device.enrollment.authKeyId ?? null, accountId, accountVersion, expiresAt });
  return { ticket, expiresAt: expiresAt.toISOString() };
}
export async function validateSigninHandoff(handoff: { deviceId: Types.ObjectId; orgId: Types.ObjectId; enrollmentHash?: string | null; phone: string; accountId?: Types.ObjectId | null; accountVersion?: number | null; keyId?: string | null }) {
  // All newly issued proofs carry an enrollment snapshot. Unbound pre-rollout tickets fail closed.
  if (!handoff.enrollmentHash || !handoff.keyId || !handoff.accountId || handoff.accountVersion == null) throw new UnauthorizedError('Device sign-in is no longer valid.');
  const device = await currentSigninDevice(handoff.deviceId, handoff.orgId, handoff.enrollmentHash, handoff.keyId);
  if ((device.enrollment.authKeyId ?? null) !== (handoff.keyId ?? null) || device.phone !== handoff.phone) throw new UnauthorizedError('Device sign-in is no longer valid.');
  if (handoff.accountId && !await CustomerAccount.exists({ _id: handoff.accountId, phone: handoff.phone, tokenVersion: handoff.accountVersion })) throw new UnauthorizedError('Device sign-in is no longer valid.');
}
