# Customer Android API

All endpoints use `/api/v1`, shared validation, JSON envelopes and the existing password hashing/session implementation. Customer identities remain separate from staff and enrollment credentials.

## Sign-in

The customer explicitly chooses this phone, a code on the financed phone, or a password. Same-phone sign-in uses certificate-checked Binder plus a signed, nonce-bound Locker challenge. After the backend identifies the current customer, the app asks the user to confirm the linked number before exchanging the proof. A typed number must match the enrolled device's customer. See [trusted-device protocol](TRUSTED_DEVICE_AUTH.md) for cryptographic boundaries and rollout checks.

Another phone requests `method: otp`. A generic wake-up asks Locker to fetch pending requests; no code is sent in FCM. The customer opens Locker and taps **Show sign-in code** while the Android user is unlocked. A purpose-specific P-256 signature authorizes the code-display endpoint. The six-digit code is valid for three minutes and five guesses, with one request per minute and five per hour per number. The requesting app must retain its random nonce. Code verification consumes the request once and returns a handoff, never a customer session directly.

Every successfully verified first-time customer creates a password. An existing password routes directly to password entry and also offers Locker sign-in. Only a current device-bound setup proof can set a first password; it cannot replace an existing password. WhatsApp and SMS authentication are removed. Legacy message endpoints return 410 with Locker guidance and never send a message. Without the enrolled phone, existing customers can use their password; first-time verification has no unverified fallback.

| Path under `/customer-app` | Request | Result |
| --- | --- | --- |
| POST `/auth/start` | `{phone}` | `next: password/device/unregistered`; one joined lookup |
| POST `/auth/device/local` | `{nonce,phone?}` | Anonymous local challenge |
| POST `/auth/device/request` | `{phone,nonce,method:otp}` | Request ID and expiry; identical shape for unknown phones |
| POST `/auth/device/claim` | `{requestId,nonce}` | Claims signed local proof with verified phone/name |
| POST `/auth/device/verify-code` | `{requestId,nonce,code}` | One-use handoff and verified phone |
| POST `/auth/device/exchange` | `{ticket,nonce}` | Session, or five-minute first-password proof |
| POST `/auth/set-password` | `{phone,setupToken,password}` | Consumes current device-bound proof; first password only |
| POST `/auth/login` | `{phone,password}` | Bounded customer session |
| POST `/auth/logout` | Customer bearer | Revokes current session |
| GET `/overview?contractId=...` | Customer bearer | Owned plans, selected plan, schedule, contacts, first payment page |
| GET `/payments?contractId=...&cursor=...` | Customer bearer | Next 20 non-voided payments |

## Data and query boundaries

Phones normalize to `03XXXXXXXXX`. Overview and pagination each use one account-rooted aggregation, validating session ID/expiry/version and joining phone-owned records at active retailers. Every nested join matches retailer ID and record ID. No customer CNIC, guarantor details, internal notes, inventory cost, staff secrets or enrollment credentials are exposed. Money uses integer paisa; remaining is totalPayable plus late fees minus paidTotal. Device status is last acknowledged state, not proof of current connectivity.

Security mutations use distinct conditional writes where needed: rate counters, attempt claims, signature checks, revocation checks, one-use handoff and session insertion. Collapsing these into a single total database operation would weaken replay/revocation protection. Ordinary identity reads use joins rather than N+1 lookups. Password verification occurs outside MongoDB and is followed by a version-checked session write.

Sessions use audience `qist-customer`, at most five active sessions and 30-day expiry. Existing sessions restore from encrypted backup-excluded storage. First-password proof, OTP and nonce never enter saved instance state or logs. Customer OTP entry reads the clipboard only after the user taps Paste.

## Rollout and verification

Deploy backend before new clients. Both actual installed APKs must have compatible signing identities for local signature permission/Binder; different certificates fail closed. Deploy an updater-enabled Locker once before future Cloudflare uploads can update it. Preserve enrollment, finance lock state and signing keys. Do not reset financed phones to test login.

Run `bun run check` with an isolated Mongo replica set for full integration tests. Tests cover signed code display, wrong key/purpose/nonce, five guesses, expiry, release, account deletion/version changes, concurrent consumption, first-password proof, retired provider routes, tenant isolation, money, pagination and financial commands. Host checks cannot establish real Vivo Android 12 Keystore/Binder, FCM delivery, kiosk navigation or package installation; record those physical-device results separately.
