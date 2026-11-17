import { randomInt, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import {
  localSigninSchema,
  remoteSigninSchema,
  signinClaimSchema,
  registerSigninKeySchema,
  approveSigninSchema,
  showSigninCodeSchema,
  verifySigninCodeSchema,
} from '@shop/shared';
import { publicController, deviceController } from '../lib/factory';
import { validate } from '../lib/validate';
import { DeviceSigninLimit } from '../models/device_signin';
import { DeviceSignin } from '../models/device_signin';
import { Device } from '../models/device';
import { Customer } from '../models/customer';
import { CustomerAccount } from '../models/customer_account';
import { AppError, RateLimitError, UnauthorizedError, ConflictError } from '../lib/errors';
import { wakeDevice } from '../lib/push';
import {
  lockerSigninCode,
  signinHash,
  signinRandom,
  signinPublicKey,
  validSigninSignature,
  keyRegistrationPayload,
  signinPayload,
  signinAccount,
  currentSigninDevice,
  createSigninHandoff,
  SIGNIN_TTL_MS,
  SIGNIN_SELECT,
  signinIdentityStages,
} from '../lib/trusted_device_auth';

const expired = () => new UnauthorizedError('This sign-in request is expired or no longer available.');
const fresh = () => ({ expiresAt: { $gt: new Date() } });
const visible = (r: {
  _id: unknown;
  kind: string;
  challenge: string;
  nonceHash: string;
  expiresAt: Date;
  createdAt: Date;
}) => ({
  requestId: String(r._id),
  kind: r.kind,
  challenge: r.challenge,
  nonceHash: r.nonceHash,
  expiresAt: r.expiresAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

export const localChallenge = publicController.createHandlers(
  validate('json', localSigninSchema),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const { nonce, phone } = c.req.valid('json');
    const request = await DeviceSignin.create({
      kind: 'local',
      phone,
      nonceHash: signinHash(nonce),
      challenge: signinRandom(),
      expiresAt: new Date(Date.now() + SIGNIN_TTL_MS),
    });
    return c.json(
      { data: { requestId: String(request._id), expiresAt: request.expiresAt.toISOString() } },
      201,
    );
  },
);

export const registerKey = deviceController.createHandlers(
  validate('json', registerSigninKeySchema),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const { device } = c.var;
    const { publicKey, signature } = c.req.valid('json');
    try {
      signinPublicKey(publicKey);
    } catch {
      throw new AppError('VALIDATION_ERROR', 400, 'Invalid signing key.');
    }
    const keyId = signinHash(publicKey);
    if (!validSigninSignature(publicKey, keyRegistrationPayload(String(device._id), keyId), signature))
      throw new UnauthorizedError('Invalid key proof.');
    const current = await Device.findOne({
      _id: device._id,
      orgId: device.orgId,
      'enrollment.secretHash': device.enrollmentHash,
    })
      .select(SIGNIN_SELECT)
      .lean();
    if (!current?.enrollment || current.stockStatus === 'released') throw expired();
    if (current.enrollment.authKeyId && current.enrollment.authKeyId !== keyId)
      throw new ConflictError('The enrollment already has a signing key. Use account recovery.');
    const result = await Device.updateOne(
      {
        _id: device._id,
        orgId: device.orgId,
        stockStatus: { $ne: 'released' },
        'enrollment.secretHash': current.enrollment.secretHash,
        $or: [{ 'enrollment.authKeyId': null }, { 'enrollment.authKeyId': keyId }],
      },
      { $set: { 'enrollment.authKeyId': keyId, 'enrollment.authPublicKey': publicKey } },
    );
    if (result.matchedCount !== 1) throw expired();
    return c.json({ data: { keyId } });
  },
);

/** This is called only by the signature-checked local IPC transaction on the enrolled Locker. */
export const localDetails = deviceController.createHandlers(
  validate('json', signinClaimSchema),
  async (c) => {
    const { device } = c.var;
    const { nonce, requestId } = c.req.valid('json');
    const current = await currentSigninDevice(device._id, device.orgId, device.enrollmentHash);
    if (!current.enrollment.authKeyId) throw expired();
    const phone = current.phone;
    const request = await DeviceSignin.findOneAndUpdate(
      {
        _id: requestId,
        kind: 'local',
        state: 'pending',
        nonceHash: signinHash(nonce),
        ...fresh(),
        $and: [
          {
            $or: [
              { deviceId: null },
              {
                deviceId: device._id,
                enrollmentHash: current.enrollment.secretHash,
                keyId: current.enrollment.authKeyId,
              },
            ],
          },
          { $or: [{ phone: null }, { phone }] },
        ],
      },
      {
        $set: {
          deviceId: device._id,
          orgId: device.orgId,
          phone,
          enrollmentHash: current.enrollment.secretHash,
          keyId: current.enrollment.authKeyId,
        },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!request) throw expired();
    c.header('Cache-Control', 'no-store');
    return c.json({ data: visible(request) });
  },
);

export const remoteChallenge = publicController.createHandlers(
  validate('json', remoteSigninSchema),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const { phone, nonce, method } = c.req.valid('json');
    const now = Date.now();
    // Unique bucket keys make limits atomic across requests and server instances; TTL is cleanup only.
    for (const [window, maximum] of [
      [60_000, 1],
      [3_600_000, 5],
    ]) {
      const bucket = Math.floor(now / window);
      try {
        await DeviceSigninLimit.findOneAndUpdate(
          { _id: `${signinHash(phone)}:${window}:${bucket}`, count: { $lt: maximum } },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 1) * window + 60_000) } },
          { upsert: true },
        );
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 11000)
          throw new RateLimitError(Math.ceil(window / 1000));
        throw error;
      }
    }
    const number = randomInt(1000).toString().padStart(3, '0');
    const request = await DeviceSignin.create({
      kind: method === 'otp' ? 'otp' : 'remote',
      phone,
      nonceHash: signinHash(nonce),
      numberHash: signinHash(number),
      challenge: signinRandom(),
      expiresAt: new Date(Date.now() + SIGNIN_TTL_MS),
    });
    // Reply shape is identical when no eligible device exists; do not reveal account registration.
    const [candidate] = await Customer.aggregate<{
      device: {
        _id: Types.ObjectId;
        orgId: Types.ObjectId;
        enrollment: { secretHash: string; authKeyId: string };
      };
    }>([
      { $match: { orgId: { $exists: true }, phone } },
      {
        $lookup: {
          from: 'contracts',
          let: { customer: '$_id', org: '$orgId' },
          pipeline: [
            {
              $match: {
                status: { $in: ['active', 'defaulted', 'completed'] },
                $expr: { $and: [{ $eq: ['$customerId', '$$customer'] }, { $eq: ['$orgId', '$$org'] }] },
              },
            },
            { $sort: { _id: -1 } },
            { $project: { deviceId: 1 } },
          ],
          as: 'agreements',
        },
      },
      { $unwind: '$agreements' },
      {
        $lookup: {
          from: 'devices',
          let: { device: '$agreements.deviceId', org: '$orgId' },
          pipeline: [
            {
              $match: {
                stockStatus: { $ne: 'released' },
                'enrollment.authKeyId': { $type: 'string' },
                $expr: { $and: [{ $eq: ['$_id', '$$device'] }, { $eq: ['$orgId', '$$org'] }] },
              },
            },
            ...signinIdentityStages(),
            { $match: { phone } },
            { $project: { _id: 1, orgId: 1, 'enrollment.secretHash': 1, 'enrollment.authKeyId': 1 } },
          ],
          as: 'device',
        },
      },
      { $unwind: '$device' },
      { $limit: 1 },
      { $project: { device: 1 } },
    ]);
    if (candidate) {
      const device = candidate.device;
      await DeviceSignin.updateOne(
        { _id: request._id, state: 'pending' },
        {
          $set: {
            deviceId: device._id,
            orgId: device.orgId,
            enrollmentHash: device.enrollment.secretHash,
            keyId: device.enrollment.authKeyId,
          },
        },
      );
      // A wake-up carries no code or authorization; pending requests survive missing FCM delivery.
      void wakeDevice(device.orgId, device._id);
    }
    return c.json(
      {
        data: {
          requestId: String(request._id),
          ...(method === 'otp' ? {} : { number }),
          expiresAt: request.expiresAt.toISOString(),
        },
      },
      201,
    );
  },
);

export const pendingRequests = deviceController.createHandlers(async (c) => {
  const { device } = c.var;
  const current = await Device.findOne({
    _id: device._id,
    orgId: device.orgId,
    'enrollment.secretHash': device.enrollmentHash,
  })
    .select(SIGNIN_SELECT)
    .lean();
  if (!current?.enrollment?.authKeyId || current.stockStatus === 'released')
    return c.json({ data: { requests: [] } });
  const requests = await DeviceSignin.find({
    deviceId: device._id,
    orgId: device.orgId,
    kind: { $in: ['remote', 'otp'] },
    state: 'pending',
    enrollmentHash: current.enrollment.secretHash,
    keyId: current.enrollment.authKeyId,
    attempts: { $lt: 5 },
    ...fresh(),
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { requests: requests.map(visible) } });
});

export const decide = deviceController.createHandlers(validate('json', approveSigninSchema), async (c) => {
  const { device } = c.var;
  const input = c.req.valid('json');
  const request = await DeviceSignin.findOne({
    _id: input.requestId,
    deviceId: device._id,
    orgId: device.orgId,
    state: 'pending',
    attempts: { $lt: 5 },
    ...fresh(),
  })
    .select('+enrollmentHash +numberHash +phone')
    .lean();
  if (!request?.enrollmentHash || !request.phone) throw expired();
  if (request.kind === 'otp' && input.decision === 'approve') throw expired();
  const current = await currentSigninDevice(device._id, device.orgId, request.enrollmentHash, request.keyId);
  if (current.enrollment.secretHash !== device.enrollmentHash) throw expired();
  if (
    !current.enrollment.authPublicKey ||
    !validSigninSignature(
      current.enrollment.authPublicKey,
      signinPayload(request, String(device._id), input.decision, input.number ?? ''),
      input.signature,
    )
  )
    throw new UnauthorizedError('Invalid signing proof.');
  if (current.phone !== request.phone) throw expired();
  if (
    request.kind === 'remote' &&
    input.decision === 'approve' &&
    signinHash(input.number ?? '') !== request.numberHash
  ) {
    await DeviceSignin.updateOne(
      { _id: request._id, state: 'pending', attempts: { $lt: 5 } },
      { $inc: { attempts: 1 } },
    );
    throw new AppError('VALIDATION_ERROR', 400, 'The number does not match.');
  }
  const account = input.decision === 'approve' ? await signinAccount(request.phone) : null;
  const result = await DeviceSignin.updateOne(
    { _id: request._id, state: 'pending', attempts: { $lt: 5 }, ...fresh() },
    {
      $set: {
        state: input.decision === 'approve' ? 'approved' : 'denied',
        accountId: account?._id ?? null,
        accountVersion: account?.tokenVersion ?? null,
      },
    },
  );
  if (result.modifiedCount !== 1) throw expired();
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { ok: true } });
});

export const claim = publicController.createHandlers(validate('json', signinClaimSchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  const { requestId, nonce } = c.req.valid('json');
  const request = await DeviceSignin.findOne({ _id: requestId, nonceHash: signinHash(nonce), ...fresh() })
    .select('+enrollmentHash +phone')
    .lean();
  if (!request || request.state === 'claimed' || request.state === 'cancelled') throw expired();
  if (request.state !== 'approved') return c.json({ data: { state: request.state } });
  if (!request.deviceId || !request.orgId || !request.enrollmentHash || !request.phone || !request.accountId)
    throw expired();
  const device = await currentSigninDevice(
    request.deviceId,
    request.orgId,
    request.enrollmentHash,
    request.keyId,
  );
  if (
    device.phone !== request.phone ||
    !(await CustomerAccount.exists({ _id: request.accountId, tokenVersion: request.accountVersion }))
  )
    throw expired();
  const consumed = await DeviceSignin.updateOne(
    { _id: request._id, state: 'approved', nonceHash: signinHash(nonce), ...fresh() },
    { $set: { state: 'claimed' } },
  );
  if (consumed.modifiedCount !== 1) throw expired();
  return c.json({
    data: {
      state: 'approved',
      phone: request.phone,
      name: device.customerName,
      ...(await createSigninHandoff(
        device,
        nonce,
        request.phone,
        request.accountId,
        request.accountVersion ?? 0,
      )),
    },
  });
});

export const cancel = publicController.createHandlers(validate('json', signinClaimSchema), async (c) => {
  const { requestId, nonce } = c.req.valid('json');
  await DeviceSignin.updateOne(
    { _id: requestId, nonceHash: signinHash(nonce), state: { $in: ['pending', 'approved'] } },
    { $set: { state: 'cancelled' } },
  );
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { ok: true } });
});

export const showCode = deviceController.createHandlers(validate('json', showSigninCodeSchema), async (c) => {
  const { device } = c.var;
  const input = c.req.valid('json');
  const request = await DeviceSignin.findOne({
    _id: input.requestId,
    deviceId: device._id,
    orgId: device.orgId,
    kind: 'otp',
    state: 'pending',
    attempts: { $lt: 5 },
    ...fresh(),
  })
    .select('+enrollmentHash +phone')
    .lean();
  if (!request?.enrollmentHash || !request.phone) throw expired();
  const current = await currentSigninDevice(device._id, device.orgId, request.enrollmentHash, request.keyId);
  if (
    current.enrollment.secretHash !== device.enrollmentHash ||
    current.phone !== request.phone ||
    !current.enrollment.authPublicKey ||
    !validSigninSignature(
      current.enrollment.authPublicKey,
      signinPayload(request, String(device._id), 'display_code', ''),
      input.signature,
    )
  )
    throw expired();
  const account = await signinAccount(request.phone);
  if (
    !account ||
    (request.otpReady &&
      (String(account._id) !== String(request.accountId) || account.tokenVersion !== request.accountVersion))
  )
    throw expired();
  const ready = await DeviceSignin.updateOne(
    {
      _id: request._id,
      state: 'pending',
      attempts: { $lt: 5 },
      ...fresh(),
      $or: [{ otpReady: false }, { accountId: account._id, accountVersion: account.tokenVersion }],
    },
    { $set: { otpReady: true, accountId: account._id, accountVersion: account.tokenVersion } },
  );
  if (!ready.matchedCount) throw expired();
  c.header('Cache-Control', 'no-store');
  return c.json({
    data: {
      code: lockerSigninCode(request),
      expiresAt: request.expiresAt.toISOString(),
      phone: request.phone,
    },
  });
});

export const verifyLockerCode = publicController.createHandlers(
  validate('json', verifySigninCodeSchema),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const { requestId, nonce, code } = c.req.valid('json');
    const request = await DeviceSignin.findOneAndUpdate(
      {
        _id: requestId,
        kind: 'otp',
        state: 'pending',
        otpReady: true,
        nonceHash: signinHash(nonce),
        attempts: { $lt: 5 },
        ...fresh(),
      },
      { $inc: { attempts: 1 } },
      { returnDocument: 'before' },
    )
      .select('+enrollmentHash +phone')
      .lean();
    if (
      !request?.phone ||
      !request.deviceId ||
      !request.orgId ||
      !request.enrollmentHash ||
      !request.accountId
    )
      throw expired();
    const actual = Buffer.from(signinHash(code), 'hex');
    const expected = Buffer.from(signinHash(lockerSigninCode(request)), 'hex');
    if (!timingSafeEqual(actual, expected)) {
      if (request.attempts >= 4)
        throw new RateLimitError(
          Math.max(1, Math.ceil((request.expiresAt.getTime() - Date.now()) / 1000)),
          'OTP_ATTEMPTS_EXCEEDED',
          'Too many incorrect codes. Request a new sign-in after this code expires.',
        );
      throw new AppError('OTP_CODE_INVALID', 400, 'That code is incorrect or expired.');
    }
    const device = await currentSigninDevice(
      request.deviceId,
      request.orgId,
      request.enrollmentHash,
      request.keyId,
    );
    if (
      device.phone !== request.phone ||
      !(await CustomerAccount.exists({ _id: request.accountId, tokenVersion: request.accountVersion }))
    )
      throw expired();
    const consumed = await DeviceSignin.updateOne(
      {
        _id: request._id,
        state: 'pending',
        otpReady: true,
        nonceHash: signinHash(nonce),
        attempts: { $lte: 5 },
        ...fresh(),
      },
      { $set: { state: 'claimed' } },
    );
    if (!consumed.modifiedCount) throw expired();
    return c.json({
      data: {
        phone: request.phone,
        ...(await createSigninHandoff(
          device,
          nonce,
          request.phone,
          request.accountId,
          request.accountVersion ?? 0,
        )),
      },
    });
  },
);
