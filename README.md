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

## Docker & Deployment

The server includes a multi-stage production Dockerfile.

### Building and running with Docker

```bash
# Build the Docker image
docker build -t shop-api .

# Run the container
docker run -p 5001:5001 --env-file .env shop-api
```

### Hosting Platforms

- **Render / Railway / Fly.io**: Connect repository directly; select Dockerfile or Bun environment. Configure environment variables (`MONGODB_URI`, `APP_ORIGIN`, JWT secrets, etc.).
- **AWS ECS / Google Cloud Run / DigitalOcean App Platform**: Build the container image and deploy with PORT 5001.
