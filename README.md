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
### Customer app service controls and deletion

`GET /api/v1/customer-app/config` is public and uncached. `CUSTOMER_APP_MAINTENANCE=true` gates customer routes with HTTP 503 / `MAINTENANCE_MODE`; `CUSTOMER_APP_MIN_VERSION_CODE=N` requires `X-Customer-App-Version >= N`, returning HTTP 426 / `CLIENT_UPDATE_REQUIRED`. Defaults are false / 0. Maintenance takes precedence. Staff portal, device APIs and configuration remain reachable. Restart the backend after changing environment values. Only enable a minimum version after that version is available on Google Play.

`DELETE /api/v1/customer-app/account` requires a valid signed customer token and an active, unexpired session on the account. It deletes the CustomerAccount identity (password, setup/reset challenges and all sessions) only. Retailer customers, contracts, payments and devices remain. Valid signed retries after a successful deletion are idempotent; revoked sessions cannot remove an existing identity. Deletion remains reachable during maintenance/update gates. The Android client deletes its local encrypted session and overview after success. A subsequent verified sign-up may access the same retained retailer records.
