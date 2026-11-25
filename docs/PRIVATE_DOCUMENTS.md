# Private customer and contract documents

Uploads are disabled per retailer by default. No document is sent to the public APK bucket. Existing check-in, lock/unlock and payment paths do not call the document processor.

## Cloudflare-hosted processor for Qist

Build and deploy from a Docker-capable development machine or CI runner using
`npx wrangler deploy --config wrangler.documents.json` on a Workers Paid account.
Set `DOCUMENT_PROCESSOR_SECRET` with `npx wrangler secret put DOCUMENT_PROCESSOR_SECRET --config wrangler.documents.json`.
Use a random secret of at least 32 characters. The Worker authenticates requests before starting the container.
The container downloads antivirus definitions on startup and may initially return 503.

Use Operations to configure the same secret, the Worker's HTTPS origin as
`DOCUMENT_PROCESSOR_URL`, and the private R2 settings on Qist API. Verify authenticated
health and sample uploads before enabling a retailer. Cloudflare runs the scanner;
the VPS only runs the existing API. For this deployment skip the internal processor
installation in step 3 below.

## Deploy before enabling uploads

1. Deploy this backend and confirm `GET /api/v1/capabilities` reports `documents: 1` and `organizationSettings: 2`. Do not deploy the new Settings save UI before this route is available.
2. Create a **separate private R2 bucket**, with both `r2.dev` and custom-domain public access disabled. Create a dedicated server-only R2 API credential restricted to that bucket; do not reuse the public APK credential. Never point `DOCUMENTS_R2_BUCKET` at the public APK bucket. The API startup rejects equality with `R2_BUCKET`; operators must still verify R2 public access settings.
3. Build `processor.Dockerfile` from this repository root. Run the processor on an internal network reachable only by the API. Set the same random 32+ character `DOCUMENT_PROCESSOR_SECRET` on both services. Use HTTPS if crossing hosts/networks; never put this secret in Android or browser builds. Apply a 2 GB memory limit, two CPU limit, unprivileged user, read-only root filesystem, writable `/var/lib/clamav` volume owned by `bun`, and a bounded 256 MB `/tmp` tmpfs. Permit signature-update egress; do not expose port 3030 publicly. AV startup fails if signatures cannot be downloaded; uploads fail closed if update checks are older than 48 hours. Keep the base image, ClamAV and parser dependencies patched.
4. Set API `DOCUMENTS_R2_BUCKET`, `DOCUMENTS_R2_ACCESS_KEY_ID`, `DOCUMENTS_R2_SECRET_ACCESS_KEY`, the existing account ID, `DOCUMENT_PROCESSOR_URL` and `DOCUMENT_PROCESSOR_SECRET`. Do not remove existing APK configuration. Confirm the authenticated processor `/health` route is reachable, then upload synthetic JPEG and PDF files in a test retailer. A health response only checks process reachability; an actual synthetic processing test is required to verify signatures, parsers and storage.
5. Run `bun scripts/migrate_guarantor_ids.ts` once against the intended database after taking the normal backup. It only adds stable IDs to existing customer guarantors using compare-and-set. It cannot reconstruct historical guarantors. New contracts freeze the guarantor snapshot; older agreements explicitly show that no snapshot exists.
6. Deploy portal/customer changes. In owner Settings → Documents, choose a truthful retention notice and enable uploads. Test staff submission, customer submission, rejection/replacement, acceptance, unauthorized access and private object deletion before enabling for other retailers.

## Data flow and access

The API creates a tenant-bound, idempotent upload intent. The caller explicitly confirms permission to share the file. It streams a bounded file into a private quarantine object; it cannot create a public URL or mark it accepted. The job uses DB leases, verifies the source SHA-256, and calls the isolated processor. Antivirus and complete image/PDF parsing must succeed. Images are re-encoded with metadata removed and a small preview; PDFs retain their bytes after format/action checks, so digital signatures are not altered. Only checked files become readable; authenticated downloads verify the immutable file or preview hash again. Scanning reduces risk; it does not prove a document is authentic or guarantee all malware will be detected. PDF previews are not embedded in browser HTML. No OCR, automatic identity verification, public links or third-party document scanning is included.

Staff may submit. Owners/managers review and retrieve files within authorized branches. Customers select a plan/retailer and may retrieve only their own permitted submissions. Staff-uploaded documents are not automatically shared to customer accounts. Ordinary staff have upload and status access; file content is restricted to owners/managers because an uploader can mislabel an identity scan as a warranty or phone-box image. Guarantor identity scans require a specific staff request for customer submission and are never downloadable by customers. Every content request rechecks ownership/session and is audited. No original filenames, CNIC values, tokens or bucket keys are returned in metadata or audit summaries. Accepted means staff review only.

Replacements are immutable new versions. The original remains accessible until the replacement is accepted; acceptance atomically supersedes it and releases its active-file quota. Reviews, removal and holds require a matching version. Owners may hold a document during a dispute; a hold blocks deletion and retention expiry. Only owners can remove that hold.

## Retention and recovery

The upload stores the disclosed policy snapshot. New policy settings do not silently shorten prior disclosures. Standalone customer identity records count retention from upload. Contract documents start counting when the scheduled job first observes completed/cancelled status, giving older contracts a full grace period. A hold suspends automatic expiry. Removing a mistaken customer revokes their document access unless a hold requires the customer record to stay.

The minute job processes at most three files, with five bounded attempts and exponential client retries. Monitor queue age and provision additional workers only after preserving the leases and private processor resource limits. Old unfinished intents expire after a day. Failed/rejected file checks expire after 30 days. Removing a file revokes access immediately; private-object purge retries until successful. Raw quarantine images are removed after normalization. Deletion intents also track uncertain writes, so a storage outage does not discard cleanup keys. Inspect durable `garbageKeys`, unpurged deleted records and processing age without logging object content. Keep R2 backup/version retention consistent with the displayed notice; this application cannot delete independent operator backups.

Customer uploads use Android system photo/document pickers, encrypted backup-excluded copies, connectivity-constrained WorkManager and session-bound idempotency keys. No broad media/storage permission is requested. Sign-out cancels queued work and deletes copies. Android may defer work; queued is never displayed as accepted.

## Verification and rollout limits

Integration tests use a throwaway Mongo replica-set database and an in-memory storage adapter. Parser tests decode real synthetic images and exercise the isolated service authentication/fail-closed behavior. These do not prove actual R2 permissions, live ClamAV definitions, host isolation, OEM background scheduling or physical Android behavior. Validate those in the target environment before enabling production uploads. Publish updated Play Data safety disclosures for optional photos/files, identity information, account identifiers and retailer sharing when releasing this feature. No live identity documents should be used as test fixtures.

Primary references: [OWASP file uploads](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [Android photo picker](https://developer.android.com/training/data-storage/shared/photo-picker), [WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent), [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/), [Sharp](https://sharp.pixelplumbing.com/api-constructor/), [PDF.js](https://mozilla.github.io/pdf.js/api/).
