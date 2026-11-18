# Recovering a Qist Device Owner after an accidental business-database wipe

This is a backend-only **prevention and recovery mechanism for enrolled phones that have been recorded before the wipe**.
It does **not** recover the Nokia X20 if its original enrollment verifier was deleted before this code was installed.
An unchanged `JWT_REFRESH_SECRET` cannot reconstruct a randomly generated credential or an FCM registration token.

## Why a separate recovery database is necessary

The original device app stores a randomly generated `<deviceId>.<secret>` bearer credential, and Android holds Device Owner
locally. The Qist backend previously saved only `HMAC(JWT_REFRESH_SECRET, secret)` and the FCM registration in the
`qist.devices` collection. Clearing that collection removes both verifiers. The app receives HTTP 401, enters
`Enrolment.Revoked`, stops check-ins, and keeps Android's anti-reset protections.

New enrollments atomically mirror the minimal recovery metadata to `<MONGODB_DB>_recovery.deviceEnrollments`, **outside**
the business database that the existing Qist clear-data script wipes. Subsequent valid check-ins refresh the backup.
Only a credential that matches the saved HMAC can obtain any recovery response.

The recovery store contains only device ID, organization/branch IDs, the device credential **HMAC verifier**,
FCM registration, connection timestamps, and limited release status. It does not contain customer, installment,
contract, IMEI, or raw bearer tokens.

## Install / preparation

- **No Android code or APK changes**, new routes, or new environment variables.
- MongoDB must allow the Qist API credential to read/write both `<MONGODB_DB>` and `<MONGODB_DB>_recovery`.
- MongoDB must support transactions (the app already requires this). Enrollment snapshots and regular writes use the same session across both databases.
- After deploying compatible backend code, run the existing `bun run db:indexes` to initialize the extra database and its index.
- Run `bun --env-file=/srv/qist/.env scripts/device_recovery.ts backfill` once on the VPS to mirror **currently enrolled** device records, or allow their authenticated 15-minute check-ins to populate the registry.
- Include `<MONGODB_DB>_recovery` in independent secure backup policies and do not make this database accessible to the public portal.

A normal client credential remains valid only against the primary record. Once the primary record disappears,
**valid backup credentials receive 503 (retry) rather than 401 (permanent revocation)**. All other invalid credentials
receive 401. A deliberately revoked enrollment is marked revoked in both databases and remains invalid.

## Explicit recovery release

The recovery procedure is **SSH-only**: there is no HTTP API to request release and no public admin bypass.
A release is allowed only if a survival record exists and the primary business device record is absent.

```bash
# On the Qist VPS, as the deploy user, in the checked-out qist-backend directory
bun --env-file=/srv/qist/.env scripts/device_recovery.ts list
bun --env-file=/srv/qist/.env scripts/device_recovery.ts release <24-hex-device-id>
```

The utility requires a real interactive terminal. Read the phone ID/last contact and type the exact confirmation
`RELEASE <device-id>`. It then atomically marks only that recovery record as `release_requested` and sends the existing
high-priority `action=checkin` FCM wake-up to the backed-up token. The FCM message contains no command.

On check-in, the backend re-verifies the original credential's HMAC, returns the **existing** `release` command,
then accepts only the matching command ID's acknowledgement. The installed app clears Qist policies and attempts to
relinquish Device Owner; normal factory reset through Settings should then be possible if those restrictions have
actually been removed. FCM delivery, Android Device Owner removal and reset success require real-phone verification.

## Safeguards

- Missing recovery record: cannot send FCM, recover the lost secret, or release via backend alone
- Unknown/bad credential: 401
- Previously revoked enrollment: 401, no recovery
- Valid orphan with no explicit approval: 503; the phone keeps retrying rather than revoking
- Valid orphan after release approval: receives `release` only
- Only matching release acknowledgements succeed; duplicate success acknowledgement is allowed for retries
- Recovery credentials cannot invoke customer sign-in, register new signing keys, or access staff/tenant APIs
- Normal paid-off release invalidates the survival record; re-enrollment generates a new verifier
- Registry must be protected with the same care as the normal backend credentials and backed up separately

**Do not use `list` or `release` against an unexpected MongoDB target.** Confirm `MONGODB_DB`, `MONGODB_URI`
and the authenticated server/OS user through your existing deployment controls before running them. Do not paste
secrets, raw device credentials or FCM registration tokens into terminal transcripts.

## Important Nokia X20 limitation

Your test `qist` database was deleted **before** this recovery store existed, and the old phone was online.
If it already received HTTP 401 and persisted `Enrolment.Revoked`, it will not check in again even when sent a push.
There is no recoverable FCM token or HMAC in the backend unless they were saved separately beforehand.
This change is not evidence that a backend-only rescue can reach that device.

To recover an already-revoked test Nokia, a controlled same-signed APK update (if Android permits installation)
or an owner-approved physical factory-reset/service recovery is required. Do not change the production API to accept
arbitrary device IDs or unauthenticated release commands.

## Test and release gate

Run `bun run check` against an isolated MongoDB replica set; the integration suite creates and cleans independent
`*_test_* ` databases for both the primary and recovery collections. Verify enrollment, normal check-ins,
intentional revocation, missing-primary 503, wrong-secret 401, one-time authorized orphan release, acknowledgement
retries, normal paid-off releases and live FCM delivery.

This branch is **not deployed**. Do not deploy to production until the integration tests pass, secondary database
permissions are verified, and one non-customer physical Device Owner test has completed successfully.
