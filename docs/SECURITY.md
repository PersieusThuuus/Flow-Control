# FlowControl — Security Audit Report

**Scope:** the delivered FlowControl application (server logic in `src/server/*`,
API routes in `src/app/api/**`, Prisma schema in `prisma/schema.prisma`,
frontend in `src/components/flowcontrol/*`).
**Method:** source-level review of every security-relevant module, with
grep-verified claims where stated. This is an internal code audit, not an
external penetration test (see §6).

---

## 1. Threat model summary

FlowControl holds financially significant authorization data. The principal
threats considered:

| # | Threat | Actor |
|---|---|---|
| T1 | Unauthorized access to documents/approvals (IDOR, session hijack) | Authenticated user, network attacker |
| T2 | Approval of one's own request; approval-power accumulation (SoD abuse) | Insider (any approver) |
| T3 | Threshold circumvention (approving beyond one's financial limit) | Insider (approver) |
| T4 | Tampering with or deleting the audit history after a fraud/mistake | Privileged insider, DBA |
| T5 | Malicious file upload (polyglot, disguised executable, stored XSS via file) | Authenticated user |
| T6 | Credential attacks (brute force, credential stuffing) | Remote attacker |
| T7 | Cross-site request forgery on approval actions | Remote web page |
| T8 | Concurrency abuse (double approval / double advancement by racing two sessions) | Insider |
| T9 | Rubber-stamping (approvals without review) | Insider (approver) |
| T10 | Information leakage (error messages, log/audit exports, session tokens) | Any user |
| T11 | Privilege escalation via administration endpoints | SUPER_ADMIN-less user, or admin self-escalation |

The controls in §2 are mapped against these threats in §3.

---

## 2. Controls implemented (with evidence)

### 2.1 Authentication — `src/server/auth.ts`, `src/app/api/auth/login/route.ts`

- **Password storage:** scrypt with per-user 16-byte random salt,
  N=16384, r=8, p=1, 64-byte derived key, format
  `scrypt$N$r$p$salt$hash`, verification via `timingSafeEqual`
  (`hashPassword`/`verifyPassword`).
- **Password policy:** ≥10 characters with upper, lower, digit and special
  (`validatePasswordPolicy`); enforced at user creation and admin password
  reset (`/api/admin/users`, `/api/admin/users/[id]/reset-password`).
- **Lockout:** 5 consecutive failures → 15-minute lock
  (`MAX_FAILED_LOGINS`, `LOCKOUT_MINUTES`, `lockedUntil`).
- **Login telemetry:** every attempt (success or failure, with reason and IP)
  is recorded in `LoginAttempt` **and** appended to the audit chain
  (`LOGIN_SUCCESS` / `LOGIN_FAILED`).
- **Responses are generic** for bad credentials ("Invalid email or password"),
  with distinct codes only for locked (423) and disabled (403) accounts.

### 2.2 Session management — `src/server/auth.ts`

- 256-bit random tokens (`randomBytes(32)`); only the
  **HMAC-SHA256(token, SESSION_SECRET) digest** is stored — a database leak
  does not yield usable tokens.
- Cookie: `httpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`,
  8-hour expiry; expired/revoked sessions and deactivated users are rejected
  on every request (`getCurrentUser`).
- Revocation: logout revokes the current session; **deactivation** and
  **password reset** revoke all of the user's sessions transactionally
  (`/api/admin/users/[id]` PATCH, `/api/admin/users/[id]/reset-password`).
- `SESSION_SECRET` fails closed in production (< 16 chars → error); a dev-only
  default exists solely outside production.

### 2.3 Authorization — `src/server/rbac.ts`, `src/server/api.ts`, `src/server/engine.ts`

- Code-defined least-privilege matrix: 8 roles × 18 permissions; everything
  not granted is denied.
- Every route handler calls `requireUser()` and `requirePermission()` /
  `requireRole()` before touching data; approval actions additionally pass
  engine-level eligibility (role + department scope + delegation +
  already-decided filtering).
- **Object-level authorization (anti-IDOR):** `canViewDocument()` is applied
  to document detail and download; list endpoints build visibility `WHERE`
  clauses server-side (own / department / routed-participated / all).
  Unauthorized attempts are recorded as `ControlException UNAUTHORIZED_ACCESS`
  + `AUDIT` `UNAUTHORIZED_ACCESS_BLOCKED` — a refused attempt leaves evidence.
- Admins and auditors are structurally excluded from approval chains
  (`APPROVER_ROLES`), and the auditor cannot resolve exceptions
  (`requireRole(SUPER_ADMIN)` on the resolve endpoint).
- Admin self-protection guards: an admin cannot deactivate their own account
  or change their own role (`SELF_LOCKOUT` / `SELF_ROLE_CHANGE` blocks).

### 2.4 CSRF — `src/server/api.ts` (`assertSameOrigin`)

- Primary layer: `SameSite=Lax` session cookie.
- Secondary layer: on every non-GET/HEAD/OPTIONS request carrying an
  `Origin`/`Referer` header, the origin host must match the request host
  (honoring `x-forwarded-host` behind a proxy); mismatches → 403.
- Applied on every mutating route (login, act, submit, cancel, suspend,
  versions, delegations, notifications/read, all admin writes).

### 2.5 XSS

- React auto-escaping everywhere; user content (comments, titles, names,
  audit details) is rendered as text.
- **Grep-verified:** exactly **one** `dangerouslySetInnerHTML` occurrence in
  the codebase — `src/components/ui/chart.tsx` (vendored shadcn/ui
  `ChartStyle` helper) which injects CSS custom properties derived from the
  developer-defined chart color config, never from user input. No
  `dangerouslySetInnerHTML` in any FlowControl view or business component.
- Downloaded files are served with `X-Content-Type-Options: nosniff` and
  `Content-Disposition` (attachment for non-viewable types) plus
  `Cache-Control: private, no-store`
  (`src/app/api/documents/[id]/download/route.ts`), preventing
  content-sniffing and browser execution of vault files.

### 2.6 SQL injection

- **Grep-verified:** zero occurrences of `$queryRaw` / `$executeRaw` in
  `src/`. All database access goes through the Prisma query builder
  (parameterized). The one CSV-generation path (`/api/audit/export`,
  `/api/reports/export`) escapes quotes/commas/newlines for CSV formulas
  injection safety at the CSV layer.

### 2.7 File upload — `src/server/documents.ts`

- Validation pipeline, in order: non-empty file → size ≤ `MAX_UPLOAD_MB`
  (default 10) → extension whitelist (`.pdf .docx .xlsx .png .jpg`) →
  declared-MIME group check (normalizing `application/octet-stream`) →
  **magic-byte signature check** (`%PDF-`, `PK\x03\x04`, PNG/JPEG headers) →
  SHA-256 of the content.
- Storage: randomized `storageKey` (UUID + extension), written with mode
  `0640` under `STORAGE_DIR` — **outside `/public`**, never statically
  served. Reads re-apply `path.basename()` (path-traversal defense).
- Versioning is append-only: every upload creates a new immutable version;
  previous versions are never overwritten or deleted.
- Downloads require `canViewDocument` and are audited
  (`DOCUMENT_DOWNLOADED` with version + hash).

### 2.8 Workflow-level internal controls — `src/server/engine.ts`

- `SELF_APPROVAL` SoD: hard block (403) + `ControlException SOD_SELF_APPROVAL`
  (CRITICAL) + audit event, committed before the refusal is returned.
- `MULTI_STAGE_SAME_USER` SoD: hard block when the user already approved an
  earlier step (or any step of an earlier cycle) of the same instance.
- `ROLE_PAIR` SoD rules: configurable, alert-oriented (see §4 — single-role
  users limit full enforcement).
- Approval thresholds: per-role `ApprovalRule.maxAmount`; the limit binds
  when the actor's stage is the **final financial authorization point** of
  the resolved chain (upstream operational reviews are not amount-bound —
  downstream authority carries the financial responsibility; reject/return
  are never limit-bound). **Missing rule row = 0 = cannot approve** (least
  privilege; a configured `maxAmount = null` = unlimited); breaches blocked +
  recorded.
- Mandatory evidence per category: submission blocked without the required
  items unless a written justification exists; justified exceptions become
  `ControlException MISSING_EVIDENCE` + `EVIDENCE_EXCEPTION_RECORDED` audit.
- Every approval pins `documentVersionId` + `documentHash` (SHA-256) — the
  decision is provably bound to the exact bytes reviewed.
- Delegation: ≤30 days, target must hold an approver role, no self-delegation,
  start not in the past; approvals record `delegatedFromId`.

### 2.9 Concurrency / race conditions — `src/server/engine.ts`, `src/server/audit.ts`

- Step advancement uses compare-and-swap
  (`updateMany WHERE id AND status='IN_PROGRESS' AND currentStep=n`); a
  concurrent actor causes count 0 → transaction aborts → **HTTP 409
  CONCURRENT_MODIFICATION**. Double-advance/double-approve is impossible.
- Audit appends are serialized by an in-process mutex plus the explicit
  monotonic `seq` primary key (unique-constraint collisions retry).

### 2.10 Tamper-evident audit trail — `src/server/audit.ts`

- Append-only `AuditEvent`; each row stores
  `SHA-256(seq|prevHash|occurredAt|actorId|action|entityType|entityId|canonicalJSON(details))`,
  first row chained to `"GENESIS"`.
- **No API can modify or delete audit rows** — no route exposes update/delete
  on `AuditEvent`; the only writes are appends.
- `GET /api/audit/integrity` recomputes the full chain, reports the first
  broken sequence and exposes the latest hash ("anchor hash") for external
  anchoring. Every verification and every export is itself audited.
- Blocked control violations are committed to the chain, not just logged to
  stdout.

### 2.11 Information exposure & configuration

- `handle()` translates unhandled errors to a generic 500 envelope
  `{error, code}` — stack traces never reach the client.
- Audit exports and login telemetry are permission-gated
  (`audit.export`, `audit.view`).
- `SESSION_SECRET` required (fail-closed) in production; no secrets in the
  repository (`.env.example` contains placeholders only).

---

## 3. Vulnerability checklist

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Authentication | **Mitigated** | `auth.ts` scrypt + lockout + generic errors; login route records every attempt | T6. No MFA — acceptable for internal demo scope; add TOTP for production |
| Authorization (RBAC) | **Mitigated** | `rbac.ts` matrix; `requireUser/requirePermission/requireRole` on all 47 handlers | Verified per-route in review |
| CSRF | **Mitigated** | SameSite=Lax cookie + `assertSameOrigin` on all mutations | Defense in depth; header-less non-browser clients are out of CSRF scope by definition |
| XSS | **Mitigated (with one noted exception)** | React auto-escaping; grep: single `dangerouslySetInnerHTML` in vendored `components/ui/chart.tsx` (CSS variables from developer config, not user input) | No user-content HTML rendering anywhere |
| SQL injection | **Mitigated** | grep: zero `$queryRaw`/`$executeRaw`; Prisma query builder only | — |
| IDOR / object-level access | **Mitigated** | `canViewDocument` on detail/download; server-side visibility clauses on lists; violations recorded | — |
| File upload | **Mitigated** | `documents.ts`: whitelist + MIME + magic bytes + size cap; vault outside `/public`; randomized names; authorized+audited downloads; `nosniff` | A determined attacker with a valid session can still upload a *valid* file of an allowed type; content-level malware scanning is out of scope (see §5) |
| Sensitive data exposure | **Mitigated** | Tokens stored only as HMAC digests; scrypt hashes; generic 500s; export permission gates; `no-store` on downloads | — |
| Password policy | **Mitigated** | ≥10 chars, 4 character classes, enforced at create + reset | No expiry/rotation policy (documented decision, see §5) |
| Session management | **Mitigated** | 8h expiry, revocation on logout/deactivation/reset, digest-only storage, httpOnly/SameSite/Secure | No concurrent-session limit per user |
| Privilege escalation | **Mitigated** | Fixed role taxonomy; role changes admin-only with self-change guard; auditors cannot resolve exceptions; delegation cannot grant a non-approver role approval power (delegation only widens *who* acts for an eligible stage, eligibility still checked against the delegator's role) | Delegation allows acting for a delegator's stage — by design, with `delegatedFromId` traceability |
| Race conditions | **Mitigated** | CAS on step advance (409 on conflict); serialized audit appends with monotonic seq | Single-process assumption for the audit mutex (see §4) |
| Server-side validation | **Mitigated** | zod schemas on every body; multipart fields validated; `toBigIntAmount` bounds amounts to ≤ 999,999,999,999; workflow stage configs validated (scope/amount/role constraints) | — |
| Insecure configuration | **Partially mitigated** | `SESSION_SECRET` fail-closed in production; `.env.example` has no real secrets; Docker runs as non-root *image default user* | Production checklist (§5) still required: HTTPS/HSTS, CSP headers, proxy rate limiting. Dev default secret exists but only outside production |
| Dependency risk | **Not verified in-sandbox** | — | No dependency audit tool was run in the delivery environment. Run `bun audit` / `npm audit` and enable Dependabot in CI before production (§5, §6) |

---

## 4. Known residual risks

1. **Audit chain vs. a hostile DBA (principal residual risk, stated
   honestly).** The hash chain protects against tampering *through the
   application* and detects naive direct database edits (any modified row
   breaks every subsequent hash, and `verifyAuditChain` reports the first
   broken `seq`). It does **not** protect against an attacker with database
   write access who edits rows *and recomputes all subsequent hashes*. Full
   tamper resistance requires out-of-application mechanisms: WORM/append-only
   storage, restrictive DB-level permissions, periodic external publication of
   the latest "anchor hash" (exposed by `GET /api/audit/integrity` and in the
   admin UI), or an external timestamping authority.
2. **Single-process audit mutex.** The append mutex is in-process; correct
   for this single-instance deployment, insufficient for multi-instance
   horizontal scaling without DB-level locking (docs/ARCHITECTURE.md §12).
3. **SQLite file security.** The database is a file on disk; its protection
   is only as strong as host/volume permissions. Production should use the
   PostgreSQL path with DB-level ACLs.
4. **`ROLE_PAIR` SoD is alert-oriented.** Users hold exactly one role, so a
   role-pair conflict cannot be *blocked* by user identity alone; full
   enforcement awaits multi-role support (docs/LIMITATIONS.md).
5. **No content inspection of uploaded files.** Magic-byte checks prove type
   consistency, not benignity. Production should add antivirus scanning at
   the upload boundary.
6. **Client-IP headers are trusted from the proxy.** `getClientIp` honors
   `x-real-ip`/`x-forwarded-for`; the deployment must ensure these headers
   are set only by the trusted reverse proxy, never by clients.
7. **Dev-mode secret fallback.** Outside production, a fixed development
   secret is used if `SESSION_SECRET` is unset — acceptable only for local
   development; production fails closed.

---

## 5. Production hardening checklist

Before exposing FlowControl beyond a trusted internal network:

- [ ] **TLS everywhere + HSTS** — terminate HTTPS at the reverse proxy, set
      `Strict-Transport-Security`.
- [ ] **Strict CSP** — e.g. `default-src 'self'`; the app renders no inline
      scripts from user data (audit the single chart style injection when
      tightening `style-src`).
- [ ] **Secrets management** — generate `SESSION_SECRET` with
      `openssl rand -hex 32`, inject via orchestrator secret (never bake into
      images); rotate on staff changes.
- [ ] **WORM / append-only audit storage** — ship `AuditEvent` rows (or the
      daily anchor hash) to append-only storage; publish the anchor hash
      externally on a schedule.
- [ ] **Database permissions** — dedicated least-privilege DB account;
      consider revoking UPDATE/DELETE on `AuditEvent` at the database level;
      move to PostgreSQL with DB ACLs.
- [ ] **Backups & restore drills** — back up the SQLite file (or PostgreSQL)
      and the document vault (`STORAGE_DIR`) consistently; test restores.
- [ ] **Rate limiting at the proxy** — especially on `POST /api/auth/login`
      (the in-app lockout is per-account, not per-source-IP).
- [ ] **Dependency scanning** — `bun audit` / `npm audit` in CI, Dependabot
      or equivalent, pinned versions.
- [ ] **Virus scanning of uploads** (e.g. ClamAV) at the upload boundary.
- [ ] **Log shipping** — forward application logs and `LoginAttempt` /
      `AuditEvent` data to a central SIEM.
- [ ] **Change the seeded demo passwords** (or remove demo accounts) — the
      seed ships a shared demo password `FlowDemo#2024`.
- [ ] **MFA** for SUPER_ADMIN and GENERAL_DIRECTOR accounts.

---

## 6. What was NOT done (honest statement)

- **No external penetration test** was performed. This report is an internal,
  source-level audit by the development team.
- **No dependency vulnerability scan was run inside the delivery sandbox**
  (no registry access for audit tooling). Recommendation: run
  `bun audit`/`npm audit` locally and enable Dependabot/`npm audit` in CI —
  the CI workflow is structured so these steps can be added alongside the
  existing lint/typecheck/build.
- **No automated security test suite** exists (no unit/integration/e2e tests
  at all in this delivery — environment policy). Security-relevant behavior
  (login lockout, RBAC denials, SoD blocks, CSRF rejection, audit integrity)
  is verified by scripted end-to-end browser checks of the critical paths
  performed by the lead engineer (docs/DEVLOG.md, Phases 4–6).
- **No formal security certification** (no SOC 2 / ISO 27001 mapping, no
  threat-modeling workshop with the customer) was in scope.

Any statement claiming otherwise would be inaccurate; none is made elsewhere
in this documentation set.
