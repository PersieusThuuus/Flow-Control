# FlowControl — Architecture

This document describes the delivered architecture of FlowControl: the
layering, the request lifecycle, every server module's responsibility, the
workflow engine semantics, the audit chain design, the RBAC model, the API
surface, and the reasoning behind the stack substitution (ADR-001). Every
statement is verifiable against the source under `src/` and `prisma/`.

---

## 1. ADR-001 — Stack substitution (Django/PostgreSQL → Next.js/SQLite)

### Context

The original specification targeted a Django monolith on PostgreSQL with
Celery + Redis for asynchronous jobs and an SMTP relay for email.

### Decision environment

The delivery environment mandates **Next.js 16 + TypeScript + Prisma/SQLite**,
and exposes **no** Python application server, PostgreSQL daemon, Redis broker,
or SMTP relay. Substituting the stack was a hard constraint, not a preference.

### Decision

Deliver the same business system as a Next.js 16 full-stack application in
which **100% of the business logic lives in server-side TypeScript services**
(`src/server/*`). The browser is a thin, authorized view layer. Substitutions:

| Original concept (Django stack) | Delivered equivalent (this system) |
|---|---|
| Django ORM + models | Prisma ORM, `prisma/schema.prisma` (18 models) |
| Django views / DRF endpoints | Next.js route handlers, `src/app/api/**` (47 handlers) |
| Service layer (`services.py`) | `src/server/*` TypeScript services |
| Django templates / frontend | React SPA at `src/app/page.tsx` + `src/components/flowcontrol/*` (authorized view layer only) |
| Django permissions/decorators | `src/server/rbac.ts` matrix + `src/server/api.ts` guards |
| Celery tasks (periodic monitors) | Lazy control monitors (`src/server/monitors.ts`) run when an auditor/admin opens the audit dashboard + on-demand admin trigger (`POST /api/admin/monitors`) |
| Celery email tasks + SMTP | Inline notification + `EmailLog` with honest `SKIPPED_NO_SMTP` status until an SMTP transport is integrated (`src/server/notify.ts`) |
| PostgreSQL | SQLite via Prisma; schema deliberately avoids SQLite-specific types so switching to PostgreSQL is a datasource change |
| Django admin | Administration console views backed by `/api/admin/*` |

### Consequences

- No background scheduler exists in this deployment: monitors are lazy and
  admin-triggered (documented in §10).
- Email delivery is not wired to a real transport: attempts are recorded
  honestly (see §11 and docs/LIMITATIONS.md).
- The automated test suite was not part of the delivery-environment policy;
  verification is by scripted end-to-end browser checks of critical paths plus
  CI (lint + typecheck + build). This is stated plainly wherever relevant.
- PostgreSQL portability is preserved at the schema level (§12).

---

## 2. Layered architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│ L4  Presentation (browser)                                               │
│     src/app/page.tsx (single route "/")                                  │
│     src/components/flowcontrol/* — 11 view components (login + 10        │
│     in-app views), driven by the zustand store                            │
│     src/lib/client/* — fetch wrapper (credentials: include), store, formatters │
│     Contains NO business rules; renders what the authorized API returns.  │
├───────────────────────────────────────────────────────────────────────────┤
│ L3  API layer (edge of the server)                                       │
│     src/app/api/** — 40 route files, 47 handlers                          │
│     Responsibilities ONLY: parse input (zod), guard (requireUser,          │
│     requirePermission, assertSameOrigin), delegate to L2, shape response. │
│     src/server/api.ts — ApiError, uniform error envelope, CSRF origin     │
│     check, client IP resolution, pagination, BigInt amount parsing        │
├───────────────────────────────────────────────────────────────────────────┤
│ L2  Domain services (all business logic)                                 │
│     rbac.ts      — roles, permission matrix (single source of truth)      │
│     auth.ts      — scrypt hashing, sessions, lockout, password policy     │
│     engine.ts    — workflow engine: stage paths, eligibility, SoD,         │
│                    thresholds, cycles, CAS concurrency, inbox, visibility │
│     documents.ts — upload validation (magic bytes), vault, versioning      │
│     audit.ts     — append-only hash-chained audit trail + verification    │
│     monitors.ts  — overdue / repeated return / repeated rejection scans   │
│     notify.ts    — in-app notifications + honest EmailLog                 │
│     stats.ts     — role-scoped dashboard and report aggregations          │
│     serializers.ts — DB rows → DTOs (BigInt→number, dates→ISO, JSON parse)│
├───────────────────────────────────────────────────────────────────────────┤
│ L1  Persistence                                                           │
│     src/lib/db.ts — Prisma client singleton                               │
│     Prisma + SQLite: 18 models (see docs/DATABASE.md)                     │
│     Filesystem: private document vault (STORAGE_DIR, outside /public)     │
└───────────────────────────────────────────────────────────────────────────┘
```

Rules:

- L3 never contains business rules; L2 never reads cookies or request objects
  (it receives already-validated parameters and actor identities).
- L4 is never trusted: every permission check repeated server-side, every
  list endpoint re-scopes its queries per user.
- Money is `BigInt` in the database and at the service boundary; API DTOs
  carry it as JS numbers bounded to ≤ 999,999,999,999 (`toBigIntAmount`).

---

## 3. Request lifecycle

Example: an approval decision (`POST /api/approvals/[instanceId]/act`).

```
Browser                     Next.js server                          Database
   │  POST + session cookie      │                                     │
   ├────────────────────────────►│                                     │
   │                             │ 1. assertSameOrigin (CSRF)           │
   │                             │ 2. requireUser → session lookup      │────► Session (tokenHash)
   │                             │ 3. requirePermission('approvals.act')│
   │                             │ 4. zod parse body                    │
   │                             │ 5. actOnInstance() — transaction:    │
   │                             │    a. load instance + document       │────► WorkflowInstance/Document
   │                             │    b. eligibility (role, scope,      │
   │                             │       delegation, already-decided)   │
   │                             │    c. SoD checks (self, multi-stage) │
   │                             │    d. threshold check                │
   │                             │    e. blocked? → ControlException    │
   │                             │       + audit event COMMIT, then 403 │
   │                             │    f. persist Approval (pinned to    │
   │                             │       document version hash)         │
   │                             │    g. step complete? → CAS advance   │────► updateMany WHERE status+step
   │                             │       (conflict ⇒ P2004 ⇒ HTTP 409)  │
   │                             │    h. recordAudit (hash chain)       │────► AuditEvent append
   │                             │    i. notify (in-app + email log)    │
   │◄────────────────────────────┤ 6. json({ok, message})               │
```

Key invariants:

- Every mutation runs inside a `db.$transaction` so that state changes,
  control exceptions, audit events and notifications commit atomically.
- Blocked control violations are **committed** (exception + audit event) and
  only then surfaced as API errors — the evidence of the attempt matters more
  than the HTTP status code.
- Unhandled errors are translated by `handle()` into a uniform envelope
  (`{error, code}`) with generic 500 messages — internals are never leaked.

---

## 4. Module map

| File | Responsibility (verified against source) |
|---|---|
| `src/server/rbac.ts` | 8 roles (`SUPER_ADMIN`, `PURCHASING`, `DEPT_MANAGER`, `FIN_CONTROLLER`, `ACCOUNTANT`, `TREASURY`, `GENERAL_DIRECTOR`, `INTERNAL_AUDITOR`), 18 permission keys, least-privilege matrix, `APPROVER_ROLES` (admins/auditors excluded), `hasPermission()` |
| `src/server/auth.ts` | scrypt hash/verify (N=16384, r=8, p=1, 16-byte salt, 64-byte key, timing-safe), password policy, login with lockout (5 fails / 15 min), 256-bit tokens, HMAC-SHA256 digests, cookie management (httpOnly, SameSite=Lax, secure in production, 8h TTL), `getCurrentUser`, session revocation |
| `src/server/api.ts` | `ApiError`, `handle()` error translation (ApiError / ZodError→422 / generic 500), `assertSameOrigin` CSRF check, `getClientIp` (x-real-ip / x-forwarded-for), `requireUser`, `requirePermission`, `requireRole`, `parseBody`, `parsePagination`, `toBigIntAmount`, `parseFiltersFromUrl` |
| `src/server/engine.ts` | Stage-path resolution (amount windows, parallel steps by shared sequence), submission/resubmission cycles, `actOnInstance` (eligibility incl. delegation, SoD self/multi-stage blocks, thresholds, version pinning, step completion, CAS advance), cancellation rules, admin suspend/resume, inbox computation, `canViewDocument` object-level authorization |
| `src/server/documents.ts` | Upload validation pipeline (size, extension whitelist, MIME group check, magic-byte signatures), SHA-256 hashing, randomized storage keys (UUID), vault writes (mode 0640) outside `/public`, append-only versioning, path-traversal defense (`path.basename`), document reference generation (`DOC-YYYY-NNNNN`) |
| `src/server/audit.ts` | 39 audited action types, canonical JSON (sorted keys, BigInt→string, Date→ISO), chain hash computation, serialized appends (in-process mutex + monotonic `seq` PK with collision retry), full-chain verification with first-broken-seq reporting |
| `src/server/monitors.ts` | Overdue-stage detection (SLA per stage, 24h re-check interval) with escalation to SUPER_ADMIN + GENERAL_DIRECTOR + creator, repeated-return (≥3 per instance) and repeated-rejection (≥3 per creator) exception detection, `CONTROL_MONITOR_RUN` audit |
| `src/server/notify.ts` | In-app `Notification` creation, role-wide notification, `EmailLog` with honest `SKIPPED_NO_SMTP` when SMTP is unconfigured (transport seam documented in-code) |
| `src/server/stats.ts` | Role-scoped document visibility for statistics, KPI computation (overdue via SLA, average approval time, approval/rejection rates), department/category/monthly breakdowns, per-stage average durations |
| `src/server/serializers.ts` | DB rows → API DTOs matching `src/types/flowcontrol.ts` (BigInt→Number, DateTime→ISO string, JSON columns parsed) |
| `src/lib/db.ts` | Prisma client singleton (dev hot-reload safe) |
| `src/lib/client/*` | Browser-side fetch wrapper with unified error handling, zustand store (session + active view), formatting helpers |
| `src/types/flowcontrol.ts` | The complete frontend/backend DTO contract (single source of truth for view components) |

---

## 5. Workflow engine semantics

### 5.1 Workflow and stage resolution

- A document is matched to the **active workflow** of its category whose
  amount window (`minAmount`/`maxAmount`) contains the document amount. If
  several workflows overlap, the most recently updated wins (documented
  assumption; administrators should avoid overlaps).
- Each **stage** may itself carry amount conditions (e.g. "General Director
  only ≥ 100,000"). Out-of-window stages are dropped from the path.
- Stages sharing a `sequence` number form **one parallel step**; different
  sequence numbers are strictly sequential.
- The resolved path is snapshotted as JSON into `WorkflowInstance.stagePath`
  and is immutable for the cycle — later workflow reconfiguration never
  rewrites a running instance, and historical approvals keep their own
  denormalized `stageName`.

### 5.2 Department scoping

| Scope | Meaning |
|---|---|
| `ANY` | any active user with the stage's role |
| `DOCUMENT` | only users of the document's own department |
| `FIXED` | only users of one specific department (set per stage) |

### 5.3 Acting on a step

- Eligibility: role match + department scope + stage not yet decided (this
  cycle/step), either directly or via an **active delegation** (delegations
  consider `startAt`/`endAt`, `isActive`, `revokedAt`; the acting user's
  Approval records `delegatedFromId` for traceability). Delegation targets
  must already hold the `approvals.act` permission (manager, controller,
  accountant, treasury, director) — delegating to a user who could never act
  would create tasks they cannot perform.
- Delegated approvals remain fully subject to segregation of duties
  (self-approval, multi-stage) and threshold controls.
- `COMMENT` requires being a participant (eligible approver, creator, or
  admin) and changes no state.
- A step completes when **all required stages** of the step have an `APPROVE`
  (optional stages that did not fire are simply left undecided — they become
  moot when the step advances).
- `REJECT` is terminal for the instance and the document.
- `RETURN_FOR_CORRECTION` sends the document back to the creator
  (`RETURNED`); **resubmission starts a new cycle from step 1** — the same
  instance row increments `cycle`, `currentStep` resets to 0, the stage path
  is re-resolved against the current amount, and the full history of previous
  cycles is preserved in `Approval` rows.
- Every decision is pinned to the exact reviewed content: `documentVersionId`
  + `documentHash` (SHA-256) are stored on the Approval.

### 5.4 Internal controls enforced inside the engine

| Control | Behavior |
|---|---|
| `SELF_APPROVAL` (SoD) | Hard block: the creator can never approve/decide their own request — `ControlException SOD_SELF_APPROVAL` (CRITICAL) + audit + HTTP 403 |
| `MULTI_STAGE_SAME_USER` (SoD) | Hard block: a user who already approved a stage of this instance (earlier step in this cycle, or any earlier cycle) cannot approve another — `SOD_MULTI_STAGE` (HIGH) + audit + 403 |
| `ROLE_PAIR` (SoD) | Configurable rule (roleA/roleB), alert-oriented — see docs/LIMITATIONS.md on single-role users |
| Approval thresholds (`ApprovalRule`) | On `APPROVE`, the actor's role limit must cover the instance amount **when the actor's stage is the final financial authorization point of the resolved chain** (upstream stages — e.g. the department manager's operational review — are not amount-bound because higher authority downstream carries the financial responsibility; `REJECT`/`RETURN` are never limit-bound). **Missing rule row = 0 = the role cannot approve; a configured `maxAmount = null` = unlimited.** Breaches: `THRESHOLD_BREACH` (HIGH) + audit + 403 |
| Mandatory evidence | Submission is blocked (422) when category-required evidence is missing unless a written justification exists; justified submissions record `ControlException MISSING_EVIDENCE` + `EVIDENCE_EXCEPTION_RECORDED` audit |

### 5.5 Concurrency (compare-and-swap)

Step advancement executes as:

```sql
UPDATE WorkflowInstance
SET currentStep = <n+1>, currentStepStartedAt = now, ...
WHERE id = <id> AND status = 'IN_PROGRESS' AND currentStep = <n>
```

If a concurrent actor advanced the instance first, `updateMany` returns
count 0, the transaction throws `P2004`, and the API returns **HTTP 409
CONCURRENT_MODIFICATION** ("refresh and try again"). This makes double-advance
and double-approval of a stage impossible. Audit appends are serialized by an
in-process mutex plus the explicit monotonic `seq` primary key (a colliding
insert fails and retries) — see §7.

### 5.6 Lifecycle operations

- **Cancel**: creator only while no decisive approval exists yet; an
  administrator may cancel at any time before completion.
- **Suspend / resume**: SUPER_ADMIN only (`WORKFLOW_SUSPENDED` /
  `WORKFLOW_RESUMED` audited; resume restarts the stage deadline clock).
- **Notifications**: at submission and at every step transition, all users
  eligible for the new step receive an in-app notification (+ email attempt);
  creators are notified of every decision on their requests.

---

## 6. Dashboard & report scoping

`src/server/stats.ts` computes every figure from live records:

| Role | Scope |
|---|---|
| SUPER_ADMIN, INTERNAL_AUDITOR | Organization-wide (`documents.view.all`) |
| DEPT_MANAGER | Own department's requests + requests routed to them |
| All other roles | Own requests + requests routed to them + requests they acted upon |

The same scoping is applied by the documents list endpoint and the reports
export; there is no client-trusted scope parameter for broadening visibility.

---

## 7. Audit chain design

- Every security-relevant event appends one `AuditEvent` row with:
  `hash = SHA-256(seq | prevHash | occurredAt | actorId | action | entityType | entityId | canonicalJSON(details))`;
  the first event's `prevHash` is the literal `"GENESIS"`.
- `canonicalJson` sorts object keys recursively, stringifies BigInts and
  ISO-dates — the hash input is deterministic.
- 39 action types cover authentication, documents, workflow decisions,
  delegation, control blocks, administration and audit operations
  (`AUDIT_EXPORTED`, `AUDIT_CHAIN_VERIFIED` included).
- `GET /api/audit/integrity` recomputes the whole chain and reports sequence
  gaps, broken `prevHash` linkage and hash mismatches, with the **first broken
  seq** and the **latest hash** (the "anchor hash" exposed for external
  anchoring in production).
- Audit rows have **no update/delete API** — no route touches `AuditEvent`
  except append, read, export.
- Exports (`/api/audit/export`, CSV or JSON, events/exceptions/logins) are
  permission-gated (`audit.export`) and themselves audited.

**Honest limitation** (also in docs/SECURITY.md): the chain defends against
application-level tampering and detects naive direct DB edits; a DBA with
write access could edit rows and recompute subsequent hashes. Full tamper
resistance requires WORM/append-only storage, DB-level permissions, periodic
external publication of the anchor hash, or an external timestamping
authority.

---

## 8. RBAC permission matrix

Legend: ● = granted. Everything not granted is denied by default.

| Permission | SUPER_ADMIN | PURCHASING | DEPT_MANAGER | FIN_CONTROLLER | ACCOUNTANT | TREASURY | GENERAL_DIRECTOR | INTERNAL_AUDITOR |
|---|---|---|---|---|---|---|---|---|
| `admin.users` | ● | | | | | | | |
| `admin.departments` | ● | | | | | | | |
| `admin.workflows` | ● | | | | | | | |
| `admin.thresholds` | ● | | | | | | | |
| `admin.sod` | ● | | | | | | | |
| `admin.monitors` | ● | | | | | | | |
| `admin.overview` | ● | | | | | | | |
| `documents.create` | | ● | ● | | | | | |
| `documents.view.own` | | ● | | | | | | |
| `documents.view.department` | | ● | ● | | | | | |
| `documents.view.routed` | | | ● | ● | ● | ● | ● | |
| `documents.view.all` | ● | | | | | | | ● |
| `requests.view` | ● | ● | ● | ● | ● | ● | ● | ● |
| `approvals.act` | | | ● | ● | ● | ● | ● | |
| `delegations.manage` | ● | | ● | ● | ● | ● | ● | |
| `reports.view` | ● | | ● | ● | ● | ● | ● | ● |
| `audit.view` | ● | | | | | | | ● |
| `audit.export` | ● | | | | | | | ● |

Design notes (from `src/server/rbac.ts`):

- Roles are a **fixed, code-defined taxonomy** — the 8 business roles are part
  of the business model. What administrators must configure without code
  (SoD rules, thresholds, workflow stages) lives in the database.
- `SUPER_ADMIN` and `INTERNAL_AUDITOR` are excluded from `APPROVER_ROLES`:
  administrators configure the system, auditors observe it — neither belongs
  in an approval chain.
- The auditor holds `audit.view` + `audit.export` + `documents.view.all` but
  no `approvals.act`, no `admin.*` and cannot resolve exceptions (admin
  responsibility).

---

## 9. API surface

47 handlers across 40 route files under `src/app/api/`. All list/detail data
is visibility-scoped; all mutations require a session and pass
`assertSameOrigin`.

| Method & path | Purpose | Guard |
|---|---|---|
| `GET /api` | Service health (unauthenticated) | — |
| `POST /api/auth/login` | Login (lockout enforced, attempts logged + audited) | public + CSRF |
| `POST /api/auth/logout` | Revoke current session | session |
| `GET /api/auth/me` | Current user | session |
| `GET /api/meta` | Reference data (categories, departments, roles, workflow catalogue) | session |
| `GET /api/dashboard` | Role-scoped dashboard KPIs + charts data | session |
| `GET /api/documents` | Visible documents (filters: status, category, department, scope, q, amount range; paginated) | session (scoped) |
| `POST /api/documents` | Create draft (multipart; file fully validated, stored as version 1) | `documents.create` |
| `GET /api/documents/[id]` | Full detail (document, versions, instances, approvals, exceptions, permissions) | `canViewDocument` |
| `GET /api/documents/[id]/download?version=N` | Authorized download from the vault (nosniff, Content-Disposition, audited) | `canViewDocument` |
| `POST /api/documents/[id]/versions` | Append a new immutable version (creator/admin, DRAFT/RETURNED only, identical SHA-256 rejected) | creator/admin |
| `POST /api/documents/[id]/submit` | Submit for approval (evidence control + workflow resolution) | creator/admin |
| `POST /api/documents/[id]/cancel` | Cancel (creator before decisive approvals; admin anytime) | session (rules in engine) |
| `POST /api/documents/[id]/suspend` | Suspend/resume the active instance | SUPER_ADMIN |
| `GET /api/approvals/inbox` | Tasks awaiting this user (incl. delegated), with SLA due dates | session |
| `GET /api/approvals/history` | This user's past decisions | session |
| `POST /api/approvals/[instanceId]/act` | APPROVE / REJECT / RETURN_FOR_CORRECTION / COMMENT (confirm required) | `approvals.act` + engine eligibility |
| `GET /api/notifications` | Own notifications (paginated) | session |
| `POST /api/notifications/read` | Mark notifications read | session |
| `GET /api/delegations` | Delegations given/received | session |
| `POST /api/delegations` | Create delegation (≤30 days, approver-role targets only, no self) | `delegations.manage` |
| `POST /api/delegations/[id]/revoke` | Revoke a delegation | `delegations.manage` (own) |
| `GET /api/admin/users` | User list (search, filter, paginate) | `admin.users` |
| `POST /api/admin/users` | Create user (password policy enforced) | `admin.users` |
| `PATCH /api/admin/users/[id]` | Update user (self-lockout / self-role-change guarded; deactivation revokes sessions) | `admin.users` |
| `POST /api/admin/users/[id]/reset-password` | Reset password (policy enforced; revokes sessions) | `admin.users` |
| `GET /api/admin/departments` | Department list | `admin.departments` |
| `POST /api/admin/departments` | Create department | `admin.departments` |
| `PATCH /api/admin/departments/[id]` | Update department | `admin.departments` |
| `GET /api/admin/workflows` | Workflow configs with stages | `admin.workflows` |
| `POST /api/admin/workflows` | Create workflow + stages (validated) | `admin.workflows` |
| `PATCH /api/admin/workflows/[id]` | Update workflow + stages | `admin.workflows` |
| `GET /api/admin/thresholds` | Approval limits per role | `admin.thresholds` |
| `PUT /api/admin/thresholds` | Upsert one or more role limits | `admin.thresholds` |
| `GET /api/admin/sod-rules` | SoD rules | `admin.sod` |
| `POST /api/admin/sod-rules` | Create SoD rule | `admin.sod` |
| `PATCH /api/admin/sod-rules/[id]` | Update/toggle SoD rule | `admin.sod` |
| `GET /api/admin/overview` | System overview (users, sessions, documents, storage, chain, exceptions) | `admin.overview` |
| `POST /api/admin/monitors` | Run control monitors on demand | `admin.monitors` |
| `GET /api/audit/events` | Audit events (filterable, paginated) | `audit.view` |
| `GET /api/audit/overview` | Audit dashboard (runs monitors lazily; exceptions, failed logins, chain) | `audit.view` |
| `GET /api/audit/exceptions` | Control exceptions | `audit.view` |
| `POST /api/audit/exceptions/[id]/resolve` | Resolve an exception (additive note + timestamp; never rewrites the record) | `requireRole(SUPER_ADMIN)` |
| `GET /api/audit/integrity` | Verify the hash chain (anchor hash exposed) | `audit.view` |
| `GET /api/audit/export` | CSV/JSON export: events / exceptions / logins (audited) | `audit.export` |
| `GET /api/reports/summary` | Role-scoped report aggregations | `reports.view` |
| `GET /api/reports/export` | CSV export of requests (visibility-scoped, audited) | `reports.view` |

---

## 10. Asynchronous processing (deviation from Celery)

Without Redis/Celery, `src/server/monitors.ts` runs:

1. **Lazily** — `GET /api/audit/overview` executes `runControlMonitors()`
   before aggregating, so overdue/escalation state is current whenever an
   auditor or admin opens the audit dashboard.
2. **On demand** — `POST /api/admin/monitors` (administrators).

Overdue detection is rate-limited per instance (24h re-check interval) so
lazy runs do not spam duplicate exceptions. A production deployment with a
scheduler should call `runControlMonitors()` periodically; the function is
the single seam for that.

---

## 11. Email delivery (deviation)

`src/server/notify.ts` creates in-app notifications inline (inside the
business transaction). Email attempts are recorded in `EmailLog`:

- No `SMTP_HOST`/`SMTP_PORT` configured → status **`SKIPPED_NO_SMTP`** with an
  explicit detail string. The system never claims an email was sent when it
  was not.
- The `queueEmail()` function is the marked seam for a real transport
  (e.g. nodemailer); no transport library is wired in this delivery (no SMTP
  relay is available). See docs/LIMITATIONS.md.

---

## 12. Scaling notes and PostgreSQL migration

### Multi-instance deployment

- The audit append mutex in `src/server/audit.ts` is **in-process**; it
  serializes appends correctly for the single-process deployment. Multiple
  application instances must move to database-level serialization (e.g. a
  `SELECT ... FOR UPDATE` on the last chain row / advisory locks on
  PostgreSQL) — the `seq` PK already guarantees no lost updates, only
  retry churn.
- SQLite is single-writer; scale-out requires the PostgreSQL switch below.
- Email/notification creation is inline within request transactions; under
  load, `notify()` is the natural seam for a background queue.

### Queue introduction point

When a broker becomes available, replace the two monitor triggers (§10) with
a scheduled worker and move `queueEmail()` (§11) onto an async queue. No
business logic change is required — both are already isolated functions.

### PostgreSQL migration steps

1. In `prisma/schema.prisma` change `provider = "sqlite"` to
   `"postgresql"` (the schema uses no SQLite-specific types — no arrays, no
   `Decimal`; money is `BigInt`).
2. Set `DATABASE_URL` to the PostgreSQL connection string.
3. `bun run db:generate` and introduce Prisma migrations
   (`prisma migrate dev`) instead of `db push`.
4. Data transfer: export/import via scripts (demo scale) or a one-off ETL.
5. Revisit audit serialization (DB-level locking) per the multi-instance note.

The commented `postgres` service in `docker-compose.yml` is provided for this
path.
