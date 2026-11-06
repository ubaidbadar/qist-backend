

## Deferred customer app installation — 6 November 2026

Scope: QR setup downloads only the locker. Customer app installation is a separate durable job, first eligible 15 minutes after enrollment, on unmetered connections by default. Enrollment and lock commands never wait for it. No fabricated customer web portal link.

1. Add an optional validated customer release manifest delivered through existing authenticated check-ins; persist sanitized customer-app reports during existing check-ins. Existing devices and unset configuration remain compatible.
2. Extend locker scheduling with unique delayed installation work. Resume HTTP Range downloads, validate package/version/checksum/signing certificate, then use public PackageInstaller sessions and an explicit result receiver. Reconcile sessions after restart; retry transient errors with backoff and surface permanent failures. Stop installation management after release/revocation.
3. Show reported customer-app status separately from successful device enrollment in the existing portal components and tokens.
4. Add targeted tests for manifest validation, range handling, retry/state behavior, enrollment independence, API authorization and portal labels. No extra release request is needed. Run available type, lint, build and test tasks; document SDK/device/network limitations.
5. Prepare reviewable branches/PRs; do not deploy or merge to production during this implementation. Deployment requires a real approved APK and its signing information, which must never be invented.

Use existing dependencies and current public APIs. No dependency migration, deprecated install intents, Accessibility automation, or changes to existing lock/release behavior.
