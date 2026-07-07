# GPT UPI Hub

A Next.js + PostgreSQL application for managing QR/payment-link extraction tasks, scanner workers, Telegram login, user wallets, CDKs, and admin operations.

> Before publishing this repository, make sure no real `.env*`, logs, uploads, database dumps, session credentials, wallet mnemonics, proxy credentials, or QA artifacts are committed.


## Project status

This repository is an application skeleton and operational codebase. It does **not** include production secrets, runtime data, Telegram tokens, wallet mnemonics, proxy credentials, user sessions, uploaded images, or historical QA artifacts.

## Features

- **Public user portal**
  - Telegram-based login
  - Wallet balance, deposit orders, withdrawal requests, CDK redemption
  - Extraction task submission, task history, retry-until-success, optional scan-order publishing
- **Worker portal**
  - Telegram login for scanners/workers
  - Online/offline state, auto-accept, order hall, current orders, history, withdrawals
- **Admin portal**
  - Dashboard, users, workers, orders, billing records, CDKs, proxy checks, extraction records, site settings
- **Background workers**
  - Extraction runner (`npm run upi:worker`)
  - Telegram polling bot (`npm run tg:poll`)
  - BSC/BEP20 USDT deposit watcher integrated in the server runtime
- **Operational safety**
  - Encrypted temporary session credentials
  - DB-backed task restore for external extraction workers
  - Optional Redis cache for hot APIs
  - Local-test helper scripts that can isolate development into a separate PostgreSQL schema

## Tech stack

- Next.js 16 / React 19 / TypeScript
- Prisma + PostgreSQL
- shadcn-style UI components + Tailwind CSS
- Telegram Bot API
- ethers.js for BSC deposit address and chain event handling
- Optional Redis (`ioredis`) cache


## Architecture

```mermaid
flowchart LR
  U[Public user] --> W[Next.js web app]
  A[Admin] --> W
  S[Scanner / worker] --> W
  W --> DB[(PostgreSQL)]
  W --> R[(Optional Redis cache)]
  W --> TG[Telegram Bot API]
  W --> BSC[BSC RPC]
  X[Extraction runner] --> DB
  X --> P[Configured upstream proxies]
  B[Telegram polling worker] --> TG
  B --> DB
```

Recommended production layout:

- Web/API process: `npm run start`
- Extraction process: `npm run upi:worker` with `UPI_EXTRACT_RUNNER=external`
- Telegram polling process: `npm run tg:poll`
- PostgreSQL as the source of truth
- Redis optional, used only as a short cache for hot read APIs

## Repository layout

```text
src/app/                 Next.js App Router pages and route handlers
src/components/app/      Feature UI clients for public/admin/worker pages
src/components/ui/       Shared UI primitives
src/lib/server/          Server-side business logic, queues, wallets, Telegram, proxies
src/lib/client/          Browser-side helpers
src/lib/types/           Shared public DTO types
prisma/schema.prisma     Database schema
scripts/                 Local/dev/worker/deploy helper scripts
public/uploads/          Runtime uploads; only .gitkeep is committed
```

## Local setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill at least:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/gpt_upi?schema=public"
JWT_SECRET="replace-with-a-long-random-secret"
SESSION_TOKEN_ENCRYPTION_KEY="replace-with-a-different-long-random-secret"
NEXT_PUBLIC_APP_URL="http://127.0.0.1:3001"
```

Optional integrations such as Telegram bot, Redis, BSC RPC, deposit mnemonic, and upstream proxy pools are documented in `.env.example`.

### 3. Prepare Prisma

```bash
npm run prisma:generate
npm run prisma:push
```

Optional seed:

```bash
npm run db:seed
```

### 4. Run the web app

```bash
npm run dev
```

The default dev script starts Next.js on `0.0.0.0:3001` using the `DATABASE_URL` in `.env.local`. Use the local-test commands below when you want an isolated PostgreSQL schema.

Open:

- Public portal: <http://127.0.0.1:3001/>
- Worker portal: <http://127.0.0.1:3001/worker>
- Admin portal: <http://127.0.0.1:3001/admin>

## Background processes

Run each in a separate terminal/session when needed:

```bash
npm run tg:poll        # Telegram bot polling
npm run upi:worker     # external extraction runner
```

For production-style deployments, set:

```env
UPI_EXTRACT_RUNNER="external"
```

Then keep the web process and extraction runner as separate supervised services. This avoids restarting active extraction tasks when only the web UI changes.

## Local-test helpers

The repo includes helper scripts for safer local testing:

```bash
npm run prisma:push:local-test
npm run dev:local-test
npm run dev:shared-with-bot
```

`dev:local-test` reads `.env`, `.env.local`, and `.env.local.test`, then overrides `DATABASE_URL` to use `LOCAL_TEST_SCHEMA` (default: `gpt_upi_local_test`) so tests do not touch the main schema. Run `npm run prisma:push:local-test` before the first local-test boot.

## Security checklist before publishing

- [ ] Do not commit `.env`, `.env.local`, `.env.local.test`, or production service files.
- [ ] Do not commit `dev-*.log`, `*.log`, `.tmp/`, `qa/`, screenshots, HAR files, or reverse-engineering traces.
- [ ] Do not commit real Telegram bot tokens, admin IDs, JWT secrets, Redis passwords, RPC keys, wallet mnemonics, proxy URLs, or user sessions.
- [ ] Do not commit runtime uploads; `public/uploads/*` is ignored except `.gitkeep`.
- [ ] If secrets or logs were ever committed in Git history, publish a fresh repository or rewrite history before making it public.
- [ ] Confirm third-party asset licenses, including any local font files.
- [ ] Choose and add a `LICENSE` file before public release.

## Useful commands

```bash
npm run lint
npm run build
npm run prisma:generate
npm run prisma:push
npm run tg:poll
npm run upi:worker
```

## Deployment note

`scripts/deploy-production.sh` is a generic launchd-oriented example. It uses placeholder paths, repository URLs, and service names. Configure all deployment values through environment variables in your own infrastructure.
