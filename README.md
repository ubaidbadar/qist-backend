# Shop API (Server)

The backend API server for the multi-tenant installment management portal. Built with Bun, Hono, Mongoose (MongoDB Atlas), and Jose (JWT).

## Prerequisites

- [Bun](https://bun.sh/) (v1.1+ recommended)
- A running MongoDB Atlas instance (or local MongoDB replica set with transactions enabled)

## Quick Start

1. Install dependencies:
   ```bash
   bun install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   ```
   Fill in your `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTERNAL_JOB_SECRET`, and `APP_ORIGIN` (e.g. `http://localhost:3000`).
   Generate random 48-byte secrets using:
   ```bash
   openssl rand -base64 48
   ```

3. Ensure database indexes:
   ```bash
   bun run db:indexes
   ```

4. Start development server:
   ```bash
   bun run dev
   ```
   The API server runs at `http://localhost:5001`.
   API documentation is served at `http://localhost:5001/docs`.

## Scripts

- `bun run dev` - Start development server with live reload (`bun --watch src/index.ts`)
- `bun run start` - Start production server (`bun src/index.ts`)
- `bun test` - Run test suite with throwaway test database
- `bun run db:indexes` - Create required MongoDB indexes
- `bun run typecheck` - Typecheck with TypeScript (`tsc --noEmit`)
- `bun run lint` - Lint source files with ESLint
- `bun run check` - Run typecheck, lint, and all tests

## Deployment

The server runs directly with the [Bun](https://bun.sh/) runtime.

### Production Execution

```bash
# Start production server
bun run start
```

### Hosting Platforms

- **Render / Railway / Fly.io / VPS**: Deploy in a Bun environment. Configure environment variables (`MONGODB_URI`, `APP_ORIGIN`, JWT secrets, etc.) and expose `PORT` (default 5001).
### Customer app maintenance, updates and account deletion

`GET /api/v1/customer-app/config` is public and uncached. `CUSTOMER_APP_MAINTENANCE=true` gates customer routes with HTTP 503 / `MAINTENANCE_MODE` (default false). Staff portal and device APIs remain available. Restart the backend after environment changes. Updates are optional Google Play flexible updates in the Android app; there is no minimum-version sign-in block.

`DELETE /api/v1/customer-app/account` requires a signed customer token and active unexpired session. It removes CustomerAccount (password, setup/reset challenges and all sessions), customer push registrations and the notification inbox. Retailer customers, contracts, payments and devices remain. Valid signed retries after successful deletion are idempotent; revoked sessions cannot delete an existing identity. Deletion remains reachable during maintenance. The Android app clears its local encrypted session/snapshot after success.

### Customer realtime notifications

`POST /customer-app/push-token` registers the current installation token against a verified customer session; `DELETE` unregisters that session. Each session has at most one token; tokens move to the new account/session on sign-in. Invalid/expired/revoked sessions cannot subscribe. Logout removes registrations for its session; password changes invalidate their session authorization. Account deletion clears all registrations and inbox entries. `POST /customer-app/notifications/read` accepts at most 30 IDs, always scoped to the signed-in account.

Plan creation/cancellation, payment creation/voiding and successful device acknowledgements enqueue a generic customer event after the business transaction commits. Unique account/event keys prevent duplicate inbox entries on retries. The daily 09:00 Pakistan reminder job enqueues due-day reminders for unpaid installments. Each inbox event expires after 90 days. The existing overview aggregate returns the latest 30 events; no second fetch is required for the badge or inbox.

FCM HTTP v1 uses the existing `GOOGLE_APPLICATION_CREDENTIALS` service account, with cached OAuth credentials shared with locker push. Messages contain only an action/event ID; names, phone numbers, amounts and lock state stay in the authenticated API. Failed deliveries use bounded durable retries (up to five attempts); the minute job resumes pending delivery after restarts. Invalidated FCM registrations are removed. A push outage never reverses a committed payment or device acknowledgment. Permission/Android background restrictions can delay delivery; foreground refresh repairs missed events.

Run `bun run db:indexes` on the chosen backend before enabling the feature to create the inbox uniqueness, delivery queue and TTL indexes and the unique per-session push-token index. No Firebase server keys belong in the Android app. The client’s existing Firebase project registration must match this service account project. Deployment and production end-to-end FCM testing remain separate from committing this code.

Verification errors distinguish incorrect/expired codes and exhausted attempts. The fifth wrong attempt returns HTTP 429 / `OTP_ATTEMPTS_EXCEEDED`, with the actual remaining challenge lifetime in `Retry-After` and `error.details.retryAfterSeconds`. Resends cannot bypass that lockout; the app does not invent a ten-minute timer.
