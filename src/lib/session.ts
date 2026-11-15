import type { Context } from 'hono';
import type { Types } from 'mongoose';
import type { Me } from '@shop/shared';
import { acrossTenants } from '../db/tenant_guard';
import { RefreshToken } from '../models/refresh_token';
import { User } from '../models/user';
import { ForbiddenError, UnauthorizedError } from './errors';
import { signAccessToken } from './jwt';
import { setRefreshCookie } from './refresh_cookie';
import { userAgentOf } from './request';
import { createSecretToken, readSecretToken, secretMatches } from './tokens';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Two tabs refreshing with the same cookie at once is normal; inside this window it is not treated as theft. */
const ROTATION_RACE_WINDOW_MS = 30_000;

/**
 * The signed-in user, organization and active branches in one MongoDB aggregation command.
 * The branch lookup applies the same tenant, active-branch and role scope as the former separate queries.
 */
export async function loadMe(userId: Types.ObjectId, orgId: Types.ObjectId): Promise<Me> {
  const [me] = await User.aggregate<Me>([
    { $match: { _id: userId, orgId } },
    {
      $lookup: {
        from: 'orgs',
        localField: 'orgId',
        foreignField: '_id',
        as: 'org',
      },
    },
    { $unwind: '$org' },
    {
      $lookup: {
        from: 'branches',
        let: { currentOrgId: '$orgId', currentRole: '$role', allowedBranchIds: '$branchIds' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$orgId', '$$currentOrgId'] },
                  { $eq: ['$active', true] },
                  {
                    $or: [
                      { $eq: ['$$currentRole', 'owner'] },
                      { $in: ['$_id', { $ifNull: ['$$allowedBranchIds', []] }] },
                    ],
                  },
                ],
              },
            },
          },
          { $sort: { name: 1 } },
        ],
        as: 'branches',
      },
    },
    {
      $project: {
        _id: 0,
        user: {
          _id: '$_id',
          orgId: '$orgId',
          email: '$email',
          fullName: '$fullName',
          role: '$role',
          branchIds: '$branchIds',
          active: '$active',
          emailVerifiedAt: '$emailVerifiedAt',
          mustChangePassword: '$mustChangePassword',
          lastLoginAt: '$lastLoginAt',
          createdAt: '$createdAt',
          updatedAt: '$updatedAt',
        },
        org: 1,
        branches: 1,
      },
    },
  ]).exec();

  if (!me) throw new UnauthorizedError();
  if (me.org.status === 'suspended') throw new ForbiddenError('This organization is suspended');
  return me;
}

/** Responds with a new session: access token and user in the body, a new refresh token in its httpOnly cookie. */
export async function sendSession(c: Context, user: { _id: Types.ObjectId; orgId: Types.ObjectId; tokenVersion: number }, status: 200 | 201 = 200) {
  const me = await loadMe(user._id, user.orgId);
  const { _id, token, secretHash } = createSecretToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await RefreshToken.create({ _id, userId: user._id, secretHash, expiresAt, userAgent: userAgentOf(c) });
  setRefreshCookie(c, token, expiresAt);

  const accessToken = await signAccessToken({ sub: String(user._id), org: String(user.orgId), ver: user.tokenVersion });
  return c.json({ data: { accessToken, refreshToken: token, ...me } }, status);
}

/** Signs a user out on every device. */
export const revokeAllSessions = (userId: Types.ObjectId) =>
  RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });

/** The refresh token document behind a cookie, if the cookie is genuine. */
async function findRefreshToken(cookie: string | undefined) {
  const parsed = readSecretToken(cookie);
  if (!parsed) return null;
  const record = await RefreshToken.findById(parsed._id).lean();
  return record && secretMatches(parsed.secret, record.secretHash) ? record : null;
}

/**
 * Uses up a refresh token and returns its user. A token that was exchanged a while ago is being replayed, most
 * likely because it was stolen: the user is signed out on every device.
 */
export async function useRefreshToken(cookie: string | undefined) {
  const now = new Date();
  const record = await findRefreshToken(cookie);
  if (!record || record.expiresAt <= now) throw new UnauthorizedError();

  if (record.revokedAt) {
    const isRecentRotation = record.rotated && now.getTime() - record.revokedAt.getTime() < ROTATION_RACE_WINDOW_MS;
    if (!isRecentRotation) await revokeAllSessions(record.userId);
    throw new UnauthorizedError();
  }

  // Claimed in one step, so two requests with the same token can't both succeed.
  const claimed = await RefreshToken.findOneAndUpdate({ _id: record._id, revokedAt: null }, { $set: { revokedAt: now, rotated: true } });
  if (!claimed) throw new UnauthorizedError();

  const user = await acrossTenants(User.findById(record.userId).select('+tokenVersion')).lean();
  if (!user?.active) {
    await revokeAllSessions(record.userId);
    throw new UnauthorizedError();
  }
  return user;
}

/** Logout: this device's token stops working (the ones it replaced already have). */
export async function endSession(cookie: string | undefined) {
  const record = await findRefreshToken(cookie);
  if (record) await RefreshToken.updateOne({ _id: record._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
