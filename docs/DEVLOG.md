# FlowControl — Development Log

A factual, chronological log of the project's execution. Dates are recorded
as sessions (no fabricated calendar dates). Each entry states what was done,
what was verified, and what was deliberately left out.

---

## Session 1

### Phase 1 — Requirements analysis

- Extracted the business domain from the specification: document types
  (purchase requests/orders, expense claims, contracts), the 8 business
  roles, and the approval chains typical for a 150,000 MAD-class purchase
  order (department manager → financial control → accounting →
  high-value authorization → payment execution).
- Mapped the internal-control requirements that shape the architecture:
  - Segregation of duties: no self-approval; no double-approval of stages;
    admin/auditor exclusion from approval chains.
  - Per-role approval thresholds (financial limits).
  - Mandatory supporting evidence per document category.
  - SLA per approval stage with escalation.
  - Tamper-evident audit trail for every security-relevant event.
  - Approval delegation with traceability.
- Identified the environment constraint that drives ADR-001 (no Python/Redis/
  PostgreSQL/SMTP available; Next.js 16 + TypeScript + Prisma/SQLite
  mandated).

**Deliverable:** requirement checklist used as the acceptance baseline for
every later phase.

### Phase 2 — Architecture & ADR-001

- Recorded **ADR-001**: substitute Django/PostgreSQL/Celery/Redis with
  Next.js 16 route handlers + Prisma/SQLite + lazy monitors, keeping 100% of
  business logic server-side (concept mapping table in
  docs/ARCHITECTURE.md §1).
- Designed the 18-model schema (identity, documents + versions, workflow
  engine with snapshot `stagePath`, append-only `Approval` with denormalized
  stage/user snapshots, hash-chained `AuditEvent`, control configuration
  with `SoDRule`/`ApprovalRule`, `ControlException`).
- Fixed the key invariants up front: money as `BigInt`; string enums with
  zod validation at the boundary; no SQLite-specific types (PostgreSQL
  portability); append-only audit/approval/version tables; snapshot
  denormalization so configuration changes never rewrite history.
- Defined the RBAC taxonomy as code (fixed 8 roles; configurable parts —
  SoD rules, thresholds, workflow stages — as data).
- Specified the concurrency model: compare-and-swap step advancement and
  serialized audit appends.

## Session 2

### Phase 3 — Implementation

- **Schema:** `prisma/schema.prisma` (18 models, indexes, cascade policies).
- **Server core (`src/server/`), in dependency order:**
  - `rbac.ts` — roles, 18-key permission matrix, `APPROVER_ROLES`.
  - `auth.ts` — scrypt (N=16384, r=8, p=1), policy, lockout (5/15 min),
    HMAC-digested sessions, httpOnly SameSite=Lax cookies.
  - `api.ts` — `ApiError`, error envelope, `assertSameOrigin` CSRF check,
    guards, pagination, BigInt amount parsing.
  - `documents.ts` — upload validation (extension/MIME/magic bytes/size),
    SHA-256, private vault with randomized keys, append-only versions.
  - `audit.ts` — canonical JSON, chain hashing, serialized appends,
    full-chain verification.
  - `notify.ts` — in-app notifications + honest `EmailLog`
    (`SKIPPED_NO_SMTP`).
  - `engine.ts` — stage-path resolution, submission/resubmission cycles,
    eligibility incl. delegation, SoD enforcement, thresholds, evidence
    control, CAS advancement, cancellation/suspension, inbox, object-level
    document visibility.
  - `monitors.ts` — overdue + escalation, repeated returns/rejections.
  - `stats.ts` — role-scoped dashboard/report aggregations.
  - `serializers.ts` — DTO mapping (BigInt/Date/JSON normalization).
- **API routes:** 47 handlers across 40 route files under `src/app/api/`
  (auth, meta, dashboard, documents + lifecycle actions, approvals,
  notifications, delegations, admin configuration, audit, reports).
- **Frontend:** single-route SPA (`src/app/page.tsx`) rendering the login
  view plus an application shell with 10 in-app views in
  `src/components/flowcontrol/`, driven by the
  typed DTO contract (`src/types/flowcontrol.ts`), zustand store and a
  credentials-including fetch wrapper. The frontend contains no business
  rules.

## Session 2–3

### Phase 4 — Seed & verification (EXECUTED)

- Demo dataset built in `prisma/seed.ts` **through the engine services**
  (`submitDocument` / `actOnInstance` with hash-bound backdated timestamps),
  so the audit chain, approval records and workflow states are genuine
  engine output: 9 departments, 10 demo accounts (password `FlowDemo#2024`,
  fictional), 8 categories, 4 workflows (incl. a parallel-step contract
  workflow), thresholds, SoD rules and 10 documents covering approved /
  in-progress / overdue / rejected / returned / draft states. Chain verified
  at 60 events after seeding.
- **End-to-end verification executed (results below).**

### Phase 5 — Internal code audit (EXECUTED — findings & fixes)

The audit loop between implementation and verification surfaced five real
defects, all fixed and re-verified:

1. **Threshold semantics flaw** (found by the seeder itself): the per-role
   approval limit blocked upstream *operational* reviews (a department
   manager reviewing a 150,000 MAD PO with a 50,000 limit). Corrected to the
   documented semantics: the limit binds when the actor's stage is the
   **final financial authorization point** of the resolved chain.
2. **`null ?? 0n` conflation**: a configured "unlimited" (`maxAmount =
   null`) threshold was collapsed to 0 (cannot approve). Distinguished
   explicitly (missing rule row = 0; configured null = unlimited).
3. **Fast-track false positives**: the rubber-stamping heuristic compared
   the gap against the completing approval itself (fired on nearly every
   step advance). Now compares the current approval with the immediately
   preceding decision on the instance.
4. **Circular Prisma `where`** (found in browser verification): unscoped
   document lists for non-admin roles built `where.AND = [{OR}, where]` — a
   self-referential object causing `RangeError: Maximum call stack size
   exceeded`. Rewritten as non-circular `{ AND: [filters, visibility] }` in
   both `/api/documents` and `/api/reports/export`.
5. **Plain `Response` re-wrapping**: file downloads and CSV exports returned
   plain web `Response` objects that the `handle()` wrapper re-serialized to
   `{}` (it only passed through `NextResponse`). Fixed to pass through any
   `Response`.

Additionally: delegation targets are now required to already hold
`approvals.act` (delegating to a non-approver created tasks the target could
never perform); department managers received `documents.create` (managers
originate contracts/budget/admin requests in practice — this also makes the
self-approval SoD control reachable and demonstrable); an `expectedStep`
optimistic-concurrency hint lets racing approvers receive a clean 409
instead of an eligibility 403 (and no false control exception).

Static review categories (auth/sessions, authorization coverage, CSRF, XSS,
SQLi, IDOR, upload security, races, audit integrity, disclosure,
configuration) are recorded with file references in docs/SECURITY.md,
including what was **not** verified (no external pentest, no dependency
audit run in-sandbox, no automated security tests — environment policy).

### Phase 6 — Final verification (EXECUTED — results)

Scripted API verification (curl with per-role session cookies) and browser
verification (headless agent-browser against the running dev server):

| Verification | Result |
|---|---|
| Login success / failure / generic error (no account enumeration) | PASS |
| Lockout policy configured (5 attempts / 15 min, audited) | PASS (policy verified in code; lockout path exercised by failed-attempt recording) |
| RBAC: role-scoped navigation; auditor denied `approvals.act` (403) and exception resolution (403); admin has no approval power | PASS |
| IDOR: non-participant manager denied document detail + download (403) with `UNAUTHORIZED_ACCESS` exception; current-step approver allowed (200) | PASS |
| Threshold control: limit lowered to 3,000 → manager-only 4,800 PO blocked (403 `THRESHOLD_EXCEEDED` + HIGH exception); limit restored → approved | PASS |
| SoD self-approval: manager-created request, own-stage approval blocked (403 `SOD_SELF_APPROVAL` + CRITICAL exception) | PASS |
| Delegation: invalid target rejected (422); controller→treasury delegation; treasury approved the controller stage "on behalf of" with `delegatedFromId` recorded | PASS |
| Parallel step: controller (delegated treasury) + accountant approvals → single advance to director | PASS |
| Concurrency: two simultaneous director approvals — exactly one approval row, one advance; loser receives clean 409 | PASS |
| Evidence control: draft with missing mandatory evidence blocked (422 `EVIDENCE_MISSING` listing items) | PASS |
| Full 5-stage chain: 150,000 MAD PO walked manager → controller → accountant → director → treasury, all approvals pinned to version + SHA-256 | PASS |
| Audit chain: verified at 100+ events (`valid: true`), anchor hash exposed; CSV/JSON exports working (retrieved full hash columns) | PASS |
| Document vault: authorized PDF download returns correct magic bytes/content-type; unauthorized 403 | PASS |
| UI: login, dashboard (role-scoped KPIs from live data), request register with scope selector, request detail (stage timeline, approval history, versions with hash copy, exceptions), approvals inbox, audit dashboard (chain integrity card, exceptions, failed logins), admin console (overview, users, workflows editor, thresholds, SoD rules), dark mode, mobile layout | PASS |
| Sticky footer: bottom-anchored on short pages (measured 900/900 px), pushed down naturally on long pages | PASS |
| Lint + typecheck (`eslint .`, `tsc --noEmit`) | PASS (zero issues) |

Known cosmetic notes: overdue KPI has equal visual weight to neutral KPIs
(improvement candidate); notification count appears in both sidebar and
topbar bell (consistent, intentional).

### Phase 6 — Final verification & documentation (continued)

- CI pipeline (`.github/workflows/ci.yml`) locked to the honest scope:
  ESLint, `tsc --noEmit` (authoritative — `next.config.ts` sets
  `typescript.ignoreBuildErrors`), Prisma generate, production build; test
  job present as a clearly commented placeholder because **no automated
  tests exist in this delivery**.
- Container artifacts: multi-stage `Dockerfile` (Bun standalone build,
  volume-backed `/app/db` + `/app/storage`), `docker-compose.yml` (health
  check, named volumes, optional PostgreSQL profile).
- Documentation set finalized: README, ARCHITECTURE, SECURITY, DATABASE,
  LIMITATIONS, this DEVLOG, `.env.example`.

---

## Verification status summary (FINAL)

| Activity | Status |
|---|---|
| Requirements checklist | Complete (Phase 1) |
| ADR-001 recorded | Complete (Phase 2) |
| Implementation (schema, services, 47 API handlers, frontend) | Complete (Phase 3) |
| Seed dataset (engine-generated, chain-valid) | Complete (Phase 4) |
| Internal code audit (Phase 5 categories) | Complete — 5 defects found and fixed |
| Scripted API verification of all critical controls | Complete — all PASS (Phase 6 table above) |
| Browser verification (UI golden paths, dark mode, mobile, sticky footer) | Complete — all PASS |
| CI (lint + typecheck + build) | Configured |
| Docker artifacts | Complete |
| Automated test suite | **Not included in this delivery** (environment policy) — recommended follow-up |
