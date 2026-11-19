# FlowControl

**Enterprise workflow, document approval and internal control management platform.**

FlowControl manages the complete life cycle of business documents (purchase
requests, orders, expense claims, contracts): secure upload with versioning,
multi-stage approval workflows with parallel steps, segregation-of-duties
enforcement, per-role approval thresholds, SLA monitoring with escalation, and
a tamper-evident hash-chained audit trail. Every figure on every dashboard is
computed live from database records — nothing is simulated.

All business logic is server-side (TypeScript services under `src/server/`).
The browser is a thin, authorized view layer: hiding a button in the UI is
never the access control — the server is.

> **Note on the stack (ADR-001).** The original specification targeted
> Django/PostgreSQL/Celery/Redis. The delivery environment mandates
> Next.js 16 + TypeScript + Prisma/SQLite and exposes no Python app server,
> PostgreSQL daemon, Redis or SMTP relay. The architecture was substituted
> accordingly, with 100% of business logic kept on the server. See
> [docs/ARCHITECTURE.md § ADR-001](docs/ARCHITECTURE.md) for the full
> decision record and the Django-to-Next.js concept mapping.

---

## Features

- **Authentication & sessions** — scrypt password hashing (N=16384, r=8, p=1,
  per-user salt, timing-safe comparison), password policy (≥10 chars with
  upper/lower/digit/special), lockout after 5 failed logins for 15 minutes,
  256-bit session tokens stored only as HMAC-SHA256 digests in httpOnly
  SameSite=Lax cookies, 8-hour expiry.
- **RBAC** — 8 fixed business roles with a least-privilege permission matrix
  enforced server-side on every API route.
- **Documents** — validated uploads (extension whitelist, MIME check, magic
  byte signatures, size cap), SHA-256 content hashes, append-only versioning,
  private vault outside the web root, authorized downloads only.
- **Workflow engine** — amount-conditional workflow matching, sequential steps
  with parallel stages (stages sharing a sequence number run in parallel),
  required vs optional stages, per-stage SLA hours, department scopes
  (ANY / DOCUMENT / FIXED), return-for-correction with review cycles,
  terminal rejection, admin suspend/resume, delegation (max 30 days, fully
  traced).
- **Internal controls** — segregation-of-duties rules (self-approval block,
  multi-stage-same-user block, configurable role pairs), per-role approval
  thresholds (missing rule = cannot approve), mandatory supporting evidence
  per category with justified-exception recording.
- **Control monitors** — overdue-stage detection with escalation to
  administrators and the General Director, repeated returns (≥3), repeated
  rejections per creator (≥3), fast-track (rubber-stamping) detection,
  unauthorized access attempts.
- **Audit trail** — append-only, hash-chained `AuditEvent` rows with chain
  verification, CSV/JSON export (each export itself audited), and an exposed
  "anchor hash" for external anchoring.
- **Dashboards & reports** — role-scoped KPIs, per-department/category
  breakdowns, monthly trends, average stage durations, exportable reports.
- **Notifications** — in-app notifications always; email attempts recorded
  honestly (`SKIPPED_NO_SMTP` when no SMTP relay is configured — the system
  never claims an email was sent when it was not).

## Tech stack

| Component | Technology | Version |
|---|---|---|
| Framework | Next.js (App Router, `output: "standalone"`) | ^16.1.1 |
| UI runtime | React / React DOM | ^19.0.0 |
| Language | TypeScript | ^5 |
| ORM / DB | Prisma + SQLite (portable schema, no SQLite-specific types) | ^6.11.1 |
| Styling | Tailwind CSS (+ tw-animate-css) | ^4 |
| Validation | zod (all API inputs) | ^4.0.2 |
| Client state | zustand | ^5.0.6 |
| Charts | recharts | ^2.15.4 |
| Toasts | sonner | ^2.0.6 |
| Icons | lucide-react | ^0.525.0 |
| Theme switching | next-themes | ^0.4.6 |
| Runtime | Bun (dev + container) / Node-compatible standalone build | Bun 1.x |
| Package manager | Bun (bun.lock committed) | 1.x |

## Architecture at a glance

```
                       ┌─────────────────────────────────────────────┐
                       │                Browser (thin view)          │
                       │  React SPA at "/"  ·  src/components/       │
                       │  flowcontrol/*  (no business logic)         │
                       └───────────────────────┬─────────────────────┘
                                               │ https (cookies)
                       ┌───────────────────────▼─────────────────────┐
                       │        Next.js route handlers (src/app/api) │
                       │  auth guard · permission guard · CSRF · zod │
                       └───────────────────────┬─────────────────────┘
                                               │ delegates 100%
                       ┌───────────────────────▼─────────────────────┐
                       │      Server services (src/server/*)         │
                       │  rbac · auth · engine · documents · audit   │
                       │  monitors · notify · stats · serializers    │
                       └───────┬───────────────────────────┬─────────┘
                               │ Prisma (parameterized)    │ fs
                     ┌─────────▼─────────┐      ┌──────────▼──────────┐
                     │  SQLite (Prisma)  │      │  Private doc vault  │
                     │  18 models        │      │  STORAGE_DIR        │
                     │  hash-chained     │      │  (outside /public)  │
                     │  audit trail      │      │  randomized names   │
                     └───────────────────┘      └─────────────────────┘
```

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

### Prerequisites

- [Bun](https://bun.sh) 1.x (recommended; matches the committed lockfile and the Docker image), or
- Node.js 20+ with npm (see the variant below).

### With Bun

```bash
# 1. Install dependencies
bun install

# 2. Configure the environment
cp .env.example .env
#    Edit .env: set DATABASE_URL and a SESSION_SECRET (>= 16 chars).

# 3. Create the database schema
bun run db:push        # prisma db push
bun run db:generate    # prisma generate (usually already run via install)

# 4. Seed demo data (departments, users, workflows, documents)
bun run db:seed        # runs prisma/seed.ts

# 5. Start the dev server (port 3000)
bun run dev
```

### With Node.js / npm

```bash
npm install
cp .env.example .env          # set DATABASE_URL + SESSION_SECRET
npx prisma db push
npx prisma generate
npx tsx prisma/seed.ts        # or your TypeScript runner of choice
npm run dev                   # next dev -p 3000
```

### Production build (standalone)

```bash
bun run build    # next build + copies .next/static and public/ into the standalone tree
bun run start    # NODE_ENV=production bun .next/standalone/server.js
```

`SESSION_SECRET` is **required** in production (fail-closed — login refuses to
run without it).

### Available scripts

| Script | What it does |
|---|---|
| `bun run dev` | Dev server on port 3000 |
| `bun run lint` | ESLint |
| `bun run db:push` | `prisma db push --accept-data-loss` (dev convenience — use Prisma migrations for real environments) |
| `bun run db:generate` | `prisma generate` |
| `bun run db:migrate` | `prisma migrate dev` (migration workflow for real environments) |
| `bun run db:reset` | `prisma migrate reset` |
| `bun run db:seed` | Seeds the demo dataset (`prisma/seed.ts`) |
| `bun run build` | Standalone production build |
| `bun run start` | Runs the standalone server |

## Demo accounts

All demo users share the password **`FlowDemo#2024`** (fictional demo data —
change or remove before any real use).

| Email | Role | Notes |
|---|---|---|
| `admin@flowcontrol.local` | SUPER_ADMIN | Configuration only; does not approve documents |
| `purchasing@flowcontrol.local` | PURCHASING | Creates requests |
| `purchasing2@flowcontrol.local` | PURCHASING | Second purchasing agent (for parallel-stage demos) |
| `manager.ops@flowcontrol.local` | DEPT_MANAGER | Operations department manager |
| `controller@flowcontrol.local` | FIN_CONTROLLER | Budget verification |
| `accountant@flowcontrol.local` | ACCOUNTANT | Accounting / supporting documents |
| `treasury@flowcontrol.local` | TREASURY | Payment execution |
| `director@flowcontrol.local` | GENERAL_DIRECTOR | High-value final authorization |
| `auditor@flowcontrol.local` | INTERNAL_AUDITOR | Read-only audit access |

## Role matrix

Permissions are code-defined (`src/server/rbac.ts`) and enforced server-side.
Admins and auditors are deliberately excluded from approval chains
(segregation of duties by design).

| Role | Approves? | Key capabilities |
|---|---|---|
| SUPER_ADMIN | No | Users, departments, workflows, thresholds, SoD rules, monitors; view all documents; audit access |
| PURCHASING | No | Create requests, view own/department requests |
| DEPT_MANAGER | Yes (own department) | Approve department requests, delegate, reports |
| FIN_CONTROLLER | Yes | Budget verification step, delegate, reports |
| ACCOUNTANT | Yes | Accounting/documentation step, delegate, reports |
| TREASURY | Yes | Payment execution step, delegate, reports |
| GENERAL_DIRECTOR | Yes | Final authorization for high-value requests, delegate, reports |
| INTERNAL_AUDITOR | No | View all documents, audit trail + export, reports; can never approve or resolve exceptions |

Full permission matrix: [docs/ARCHITECTURE.md § RBAC](docs/ARCHITECTURE.md).

## Workflow example — a 150,000 MAD purchase order

The engine matches a document to a workflow by **category + amount window**,
then resolves the concrete stage path (stages may carry their own amount
conditions; stages sharing a sequence number run in **parallel** as one step).
The following illustrates the mechanics with a representative purchasing
workflow — the exact stage configuration is administrator-defined (the seed
data ships a purchasing workflow; see `prisma/seed.ts`):

```
Amount: 150,000 MAD → matches the "Purchase Order" workflow window

 Step 1  Department Manager (Operations, scope DOCUMENT)      required, SLA 24h
 Step 2  Financial Controller  ∥  Accountant                  required, parallel
 Step 3  General Director      (stage applies ≥ 100,000)      required, SLA 48h
 Step 4  Treasury              (payment execution)            required, SLA 24h
```

What the engine enforces along the way:

- **SoD** — the purchasing agent who created the request can never approve it
  (`SELF_APPROVAL` hard block); no user may approve two different steps of the
  same instance (`MULTI_STAGE_SAME_USER` hard block). Blocked attempts are
  recorded as `ControlException` rows **and** audit events before the API
  refuses.
- **Thresholds** — each approver's role must have an `ApprovalRule` whose
  limit covers the amount; a missing rule means the role cannot approve at all.
- **Version pinning** — every approval records the SHA-256 of the exact
  document version reviewed.
- **SLA** — if a step exceeds its SLA, the monitors raise an `OVERDUE_STAGE`
  exception and escalate to administrators and the General Director.
- **Return for correction** — the request goes back to the creator;
  resubmission starts a **new review cycle from step 1** (cycle counter
  increments, full history preserved). Rejection is terminal.
- **Concurrency** — two approvers acting simultaneously cannot double-advance
  a step: state transitions use compare-and-swap; the loser receives HTTP 409.

## Security highlights

- Scrypt password hashing, lockout, httpOnly SameSite=Lax sessions with
  HMAC-digested tokens; sessions revoked on logout, deactivation and password
  reset.
- CSRF: SameSite cookies + Origin/Referer validation on every mutating
  request.
- SQL injection: Prisma parameterized queries only — zero `$queryRaw` /
  `$executeRaw` occurrences in the codebase (grep-verified).
- XSS: React auto-escaping; no `dangerouslySetInnerHTML` in any FlowControl
  view (one occurrence exists in the vendored shadcn/ui chart helper, which
  injects CSS variables from developer-defined chart config, not user input).
- IDOR: object-level authorization on every document access; unauthorized
  attempts are recorded as control exceptions.
- File uploads: extension whitelist (.pdf/.docx/.xlsx/.png/.jpg) + declared
  MIME check + **magic byte** signature check + 10 MB cap + randomized storage
  names outside `/public` + `nosniff` + `Content-Disposition` + audited,
  authorized downloads only.
- Tamper-evident audit chain: every security-relevant event is appended with
  `hash = SHA-256(seq|prevHash|occurredAt|actorId|action|entityType|entityId|
  canonicalJSON(details))`; the verification endpoint recomputes the chain and
  reports the first broken sequence.

Full audit report, residual risks and production hardening checklist:
[docs/SECURITY.md](docs/SECURITY.md).

## Testing & verification (honest statement)

**This delivery contains no automated test suite** (delivery-environment
policy). Verification of the delivered system is performed through:

1. **CI** (`.github/workflows/ci.yml`): ESLint, `tsc --noEmit` (the
   authoritative typecheck — `next.config.ts` sets
   `typescript.ignoreBuildErrors: true`), Prisma client generation, and a
   production build. CI does **not** run tests, because none exist.
2. **Scripted end-to-end browser verification** of the critical paths —
   login, role-based access, the approval chain, SoD blocks, and audit chain
   integrity — executed by the lead engineer against the running application
   (see [docs/DEVLOG.md](docs/DEVLOG.md), Phases 4–6).

When a test suite is added (recommended: vitest for `src/server/*` unit and
integration tests, Playwright for browser flows), the commented `test` job in
the CI workflow is the designated place to enable it.

## Docker

```bash
cp .env.example .env        # set SESSION_SECRET (required) 
docker compose up -d --build

# One-time initialization against the mounted volumes:
docker compose exec app bunx prisma db push
docker compose exec app bun prisma/seed.ts
```

- The image is a multi-stage build (`oven/bun:1`): build stage runs
  `bun install` + `bun run build`; runtime stage contains only the standalone
  Next.js output, the Prisma schema and volume mount points.
- Named volumes: `fc-db` → `/app/db` (SQLite), `fc-storage` → `/app/storage`
  (private document vault).
- Healthcheck: `curl -fsS http://localhost:3000/api` (the unauthenticated
  service health endpoint).
- A commented `postgres` service profile is included for switching the Prisma
  datasource to PostgreSQL in production (see
  [docs/DATABASE.md](docs/DATABASE.md) for the migration steps).
- Recommended (not shipped): add a `.dockerignore` excluding `node_modules/`,
  `.next/`, `db/`, `storage/`, `dev.log` and `server.log` before building
  images, and ignore the local `db/` and `storage/` directories in git.

## Project structure

```
flowcontrol/
├── docs/                      # Documentation set (see index below)
├── prisma/
│   ├── schema.prisma          # 18-model Prisma schema (SQLite, portable to PostgreSQL)
│   └── seed.ts                # Demo dataset (departments, users, workflows, documents)
├── src/
│   ├── app/
│   │   ├── api/               # 40 route files / 47 handlers — thin guards, no business logic
│   │   ├── layout.tsx         # Root layout
│   │   └── page.tsx           # Single user-visible route (SPA shell)
│   ├── components/
│   │   ├── flowcontrol/       # Feature views (login, dashboard, approvals, audit, admin, …)
│   │   └── ui/                # shadcn/ui primitives
│   ├── lib/
│   │   ├── client/            # Browser API client, zustand store, formatters
│   │   ├── db.ts              # Prisma client singleton
│   │   └── utils.ts
│   ├── server/                # ALL business logic
│   │   ├── api.ts             # ApiError, CSRF origin check, auth/permission guards, parsing
│   │   ├── audit.ts           # Hash-chained audit trail + verification
│   │   ├── auth.ts            # scrypt, sessions, lockout, password policy
│   │   ├── documents.ts       # Upload validation (magic bytes), SHA-256, private vault
│   │   ├── engine.ts          # Workflow engine (paths, SoD, thresholds, CAS, cycles)
│   │   ├── monitors.ts        # Overdue / repeated return / repeated rejection detection
│   │   ├── notify.ts          # In-app notifications + honest EmailLog
│   │   ├── rbac.ts            # 8 roles, permission matrix
│   │   ├── serializers.ts     # DB rows → API DTOs
│   │   └── stats.ts           # Role-scoped dashboard/report aggregations
│   └── types/
│       └── flowcontrol.ts     # Shared frontend/backend DTO contract
├── .env.example
├── .github/workflows/ci.yml   # Lint + typecheck + build (no tests — honest)
├── Dockerfile                 # Multi-stage standalone build (Bun)
├── docker-compose.yml
├── next.config.ts             # output: "standalone"
└── package.json
```

## Documentation index

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layered architecture, request lifecycle, module map, workflow engine semantics, audit chain design, RBAC matrix, API surface, ADR-001, scaling notes |
| [docs/SECURITY.md](docs/SECURITY.md) | Structured security audit report: threat model, implemented controls with file references, vulnerability checklist, residual risks, production hardening checklist |
| [docs/DATABASE.md](docs/DATABASE.md) | All 18 Prisma models, design decisions (BigInt money, JSON snapshots, string enums), indexes, SQLite→PostgreSQL migration path |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Known limitations and future improvements |
| [docs/DEVLOG.md](docs/DEVLOG.md) | Chronological development log (phases and verification process) |

## License

Internal project — not licensed for external distribution. All rights
reserved by the commissioning organization.
