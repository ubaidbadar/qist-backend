# Trusted Locker customer authentication

## Goals and rollout
Same-phone sign-in requires explicit confirmation of the backend-verified linked number. First identity verification requires password creation; existing customer sessions restore normally. A different phone requires an explicit approval on the enrolled financed phone, with a number shown on the requesting phone entered on the approving phone. Password sign-in remains available. Customer authentication does not use WhatsApp or SMS. Finance lock/unlock/release behavior is preserved.

Implement backend contracts and adversarial integration tests first, then Locker key registration, signature-protected IPC and approval UI, then Customer app orchestration. Deploy backwards-compatible APIs before distributing updated signed APKs. Existing apps retain recovery and current sign-in routes. Do not treat host tests as proof of physical device behavior or publish incompatible APKs before verification.

## Trust boundaries
- Enrollment bearer credentials remain inside the Locker. A separate P-256 signing key is generated in Android Keystore; private material is never exported. Hardware backing is device-dependent, not assumed or advertised as attested.
- Register the public key only through authenticated current enrollment, with proof of possession. The key is immutable for that enrollment. Re-enrollment replaces the enrollment and invalidates key binding, challenges and outstanding tickets. Missing or changed keys fail closed; recovery does not silently replace them.
- Local IPC is an explicit bound service guarded by an Android signature permission. Each Binder transaction verifies the calling UID belongs to pk.qist.customer and the apps have matching signing certificates. The Customer app verifies the Locker package/certificate before binding. An installed package name alone is never trusted. APKs using different signing identities cannot use this channel and fall back to recovery.
- Silent local proof is available only when Android reports the user unlocked. A client-generated 256-bit nonce binds the resulting ticket to that requesting app instance. No customer session, enrollment token or signing key crosses IPC.
- FCM carries the existing generic check-in wake-up hint only. The Locker fetches the authoritative challenge through its authenticated API. Delivery is not approval. Pending requests are also recoverable through check-ins/UI so notification permission or unreliable delivery is not an authorization bypass.
- Remote approval requires deliberate user interaction and number matching. Notifications contain no code or identity data and open a review-only launcher screen; intent extras never approve. Kiosk users can review requests within the Locker UI. Reject/expire/cancel is explicit; never auto-approve a remote request.

## Server invariants
P-256 signatures cover a versioned canonical payload containing purpose, request ID, device ID, challenge, requester nonce hash, expiration and decision/number where relevant. Local and remote purposes cannot be substituted. Server-generated random challenges expire within minutes, are single-use via atomic conditional writes, and are tied to the current enrollment and the actual tenant-scoped contract/customer association. Public status/claim endpoints require the high-entropy requester nonce and do not expose whether an arbitrary number is registered. Store hashes of bearer-like tickets/nonces; TTL indexes are cleanup only, every read enforces expiration. Rate-limit creation, polling and approval; limit remote creation to one per phone per minute and five per hour, expire challenges after three minutes, and cap wrong number attempts at five.

At grant and ticket exchange, re-check current enrollment, key binding and eligible contract/customer association. Reject released/revoked/reassigned phones and expired, replayed, mismatched or consumed proofs. A first-login setup proof must not grant normal customer API access, change an existing password, or survive enrollment/contract revocation or token-version/account deletion changes. Existing-account device sign-in creates a bounded customer session, never staff access. Concurrent claims mint at most one grant.

## Verification matrix
- Same phone: valid peer vs wrong UID/certificate, missing/released Locker, locked OS user, disconnect, timeout, cancellation and rotation.
- Cryptography: valid key, wrong key, altered purpose/nonce/expiry/decision, malformed/oversized key/signature, key replacement, replay and simultaneous approval/claim.
- Backend: cross-tenant/customer/device confusion, expired/revoked/re-enrolled/released devices at approval and exchange, first password setup, existing account session, cancellation and unavailable delivery.
- Remote UI: first/resumed pending request, notification denied, kiosk display, deliberate approve/reject, wrong number and retry limit, expiry, offline recovery, no secrets in notifications/logs/backups.
- Customer lifecycle: no automatic loops after logout, no concurrent sign-in operations, no secret SavedState/rememberSaveable values, session persistence failures, account deletion/recovery revocation.

## References
Android IPC security checklist: https://developer.android.com/privacy-and-security/security-tips
Binder calling UID: https://developer.android.com/reference/android/os/Binder#getCallingUid()
Bound service lifecycle: https://developer.android.com/develop/background-work/services/bound-services
Android Keystore: https://developer.android.com/privacy-and-security/keystore
Android coroutine cancellation: https://developer.android.com/kotlin/coroutines/coroutines-best-practices
Saved state: https://developer.android.com/develop/ui/compose/state-saving
NIST authentication intent/out-of-band requirements: https://pages.nist.gov/800-63-4/sp800-63b.html
Firebase message handling constraints: https://firebase.google.com/docs/cloud-messaging/android/receive

## Protocol and rollout details
1. Customer creates a random nonce in memory and an anonymous local challenge. An explicit signature-checked Binder call passes only the request ID and nonce to Locker. Locker obtains server metadata, proves possession of its registered key and returns a boolean. Customer claims a one-use ticket over HTTPS and exchanges it with the same nonce. No tickets or sessions cross Binder.
2. A remote request returns a three-digit number and an opaque request ID, including for unknown numbers. The requester retains the nonce. Locker fetches pending requests through enrollment authentication; the number is deliberately absent. Approval requires entering the number from the requesting phone and a signed decision. Request status polling runs every five seconds only while visible.
3. First sign-in returns only a five-minute password-setup proof, bound to the account/version and enrollment. Existing accounts get a bounded customer session. Fresh sign-in always requires an explicit customer action; existing verified sessions restore normally.
4. Unsigned legacy `/device/customer-auth/issue` and raw-code `channel: device` delivery are disabled with an update/recovery response. Old production Android apps have no caller of the former endpoint; existing password and session restoration remain available. Pre-rollout unbound handoff tickets are rejected.
5. Key registration is cached per enrollment in the Locker process. Optional sign-in refresh follows the existing finance check-in and cannot change a successful finance outcome. Notifications contain no account identity or code. If notifications are unavailable, open **Qist sign-in**, or use **Review sign-in requests** on the finance lock screen.

Contract/customer/active-organization joins use aggregation with explicit tenant predicates and narrow projections. Security mutations (rate counters, approval state, claim, one-use exchange and session insertion) remain distinct atomic operations. A single total database operation per authentication API would remove essential replay/revocation protections; ordinary identity reads avoid N+1 queries.

### Release gate
Deploy the backend before new clients. Both installed APKs must have compatible signing identities for signature permission/Binder authentication. The Play **app-signing certificate** may differ from the **upload certificate**; compare the certificate of the actually installed/Play-delivered customer APK against Locker. Do not weaken the signature check or rotate the financed-phone signing key to work around this. Different certificates fail closed and retain password/recovery/remote approval.

Host tests do not establish Android Keystore, real cross-process Binder, Vivo kiosk navigation, FCM delivery or release APK update behavior. Verify these on an enrolled Android 12 test phone with the production signing identity before promoting the APKs. Keep the existing Cloudflare APK in place until this check passes; do not reset or re-enroll a live financed phone to test login.

Adaptive Customer layouts keep Android dp/sp and font scaling, bound large-window content to 840dp (600dp for authentication), reduce narrow-window spacing and stack money/details on narrow screens or enlarged fonts. Normal phone geometry is retained. No global density override or font-size clamp is used.

Additional current Android guidance:
- Adaptive layouts: https://developer.android.com/develop/adaptive-apps/guides/support-different-display-sizes
- Compose state reads: https://developer.android.com/develop/ui/compose/performance/bestpractices
- Signing permissions: https://developer.android.com/guide/topics/permissions/defining

## Locker code sign-in (current customer flow)
The current Customer app requests `method: otp` at `/customer-app/auth/device/request`; it receives only request ID and expiry, never a code. Locker fetches generic pending metadata through enrollment authentication. After the user taps **Show sign-in code** with the Android user unlocked, Locker signs the `display_code` purpose with its enrolled P-256 key and calls `/device/customer-auth/code`. Only this authenticated signed endpoint returns the six-digit code. FCM and public notifications contain no OTP. Codes remain only in visible Locker UI memory and clear when it stops or expires.

The code is derived with a purpose-separated HMAC keyed by the server refresh secret and bound to request ID, random challenge, requester nonce hash and enrollment key. No raw OTP is stored. `/customer-app/auth/device/verify-code` requires the original 256-bit requester nonce; allows five guesses within three minutes; revalidates enrollment, customer ownership and account token version; atomically claims once; and returns a one-use nonce-bound handoff. The existing exchange produces either a session or a first-password proof. OTP requests cannot be approved through the legacy decision endpoint.

The older three-digit number-matching remote approval protocol remains for previously installed clients. The current Customer app uses OTP and does not poll approval status. Legacy WhatsApp request/verify/forgot/reset routes return 410 without issuing any proof or contacting a provider. An existing password cannot be overwritten with a first-password token. If Locker is unavailable, an existing password works; first-time users must regain access to the enrolled phone. No unverified alternate-number recovery is offered.
