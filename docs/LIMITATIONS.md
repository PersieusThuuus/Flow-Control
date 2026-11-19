# FlowControl — Known Limitations & Future Improvements

This document lists, honestly and without mitigation marketing, what the
delivered system does **not** do. Items are grouped by area; each ends with
the recommended future improvement.

---

## Internal controls

### 1. Single-role users — `ROLE_PAIR` SoD is alert-oriented
Users hold exactly one role (`User.role` is a scalar). Consequently a
`ROLE_PAIR` SoD rule (e.g. "PURCHASING must not also act as ACCOUNTANT on the
same document") cannot be *hard-blocked* by user identity — the same person
simply cannot hold both roles, and a genuine pair conflict requires
multi-role identities or role-assignment history to detect.
`SELF_APPROVAL` and `MULTI_STAGE_SAME_USER` **are** hard-blocked and enforced
today.
**Future:** multi-role support (or role-assignment history) to make
`ROLE_PAIR` enforceable rather than alert-oriented.

### 2. Purchase-splitting (threshold circumvention) detection not implemented
A user could split a large purchase into several smaller requests to stay
below thresholds that would otherwise trigger the General Director stage or
exceed a role's approval limit. The current engine evaluates each document in
isolation.
**Future:** duplicate/similar-amount analytics — flag same creator +
same supplier + clustered amounts within a time window as a
`SPLIT_PURCHASE_SUSPECT` control exception.

### 3. Budget consumption checking not implemented
`FIN_CONTROLLER` verifies budget availability as a workflow stage, but the
system has no budget ledger: it cannot compute remaining budget or block
requests that exceed an envelope automatically.
**Future:** budget lines per department/category with consumption tracking
against approved amounts.

### 4. Fast-track heuristic is coarse
`FAST_TRACK_SEQUENCE` (rubber-stamping detection) compares the current
approval with the *immediately preceding decision* on the same instance
(`src/server/engine.ts`) and flags gaps under 60 seconds at LOW severity.
The comparison excludes the triggering approval itself, so it detects
genuinely rapid consecutive decisions; however the fixed 60-second window
and LOW-only severity make it a coarse screening signal — a sophisticated
colluder approving just outside the window would not be flagged.
**Future:** per-approver baseline timing, out-of-business-hours detection,
and statistical anomaly scoring.

---

## Notifications & asynchronous processing

### 5. Email delivery requires SMTP configuration — and a transport
Without `SMTP_HOST`/`SMTP_PORT`, every email attempt is recorded as
`SKIPPED_NO_SMTP` (honest by design). Note additionally that **no SMTP
transport library is wired in this delivery** (no relay was available in the
environment): `queueEmail()` in `src/server/notify.ts` is the marked seam
where a transport (e.g. nodemailer) must be integrated before the `SENT`
status reflects actual delivery.
**Future:** integrate a transport behind the existing seam + queue.

### 6. No scheduler — monitors are lazy/admin-triggered
Control monitors (overdue/escalation, repeated returns, repeated rejections)
run (a) lazily when an auditor/admin opens the audit dashboard and (b) on
demand from the administration console. Without a scheduler, escalation of an
overdue stage waits until someone opens the dashboard or runs the monitors.
The 24h per-instance re-check guard prevents duplicate exceptions.
**Future:** cron/container scheduler calling `runControlMonitors()`
periodically; the function is the single seam.

---

## Audit & compliance

### 7. Audit chain needs external anchoring for full tamper resistance
The hash chain detects application-level tampering and naive DB edits, but a
DBA with write access could edit rows and recompute subsequent hashes
(docs/SECURITY.md §4).
**Future:** WORM storage, DB-level ACLs, periodic external publication of the
anchor hash, or an external timestamping authority.

### 8. No qualified electronic signature
Approvals are authenticated, authorized, hash-bound to the reviewed document
version, and fully audited — but they are not legally qualified e-signatures
(no certificate-based signing, no identity verification per eIDAS or
equivalent).
**Future:** integration point is `actOnInstance` + `Approval` (add signature
metadata / call an external signing service before persisting the decision).

---

## Engineering & delivery

### 9. No automated test suite in this delivery
Delivery-environment policy excluded an automated test suite. Verification is
by scripted end-to-end browser checks of the critical paths (login, RBAC,
approval chain, SoD block, audit chain integrity) performed by the lead
engineer, plus CI (lint + `tsc --noEmit` + Prisma generate + production
build). CI contains a clearly commented, disabled placeholder job for tests.
**Future:** vitest for unit/integration tests of `src/server/*`
(RBAC matrix, engine transitions, SoD/threshold blocks, audit chain
verification), Playwright for browser flows.

### 10. Approval inbox pagination is in-memory
`getInbox()` loads up to 500 in-progress instances and filters eligibility
in memory (correct, but O(instances × stages) per request). Fine at demo
scale; not fine at tens of thousands of concurrent instances.
**Future:** SQL-level eligibility filtering or a materialized "pending task"
table.

### 11. Single-process audit mutex
Audit appends are serialized by an in-process promise chain plus the
monotonic `seq` PK. Correct for a single application process (this
deployment, and the Docker setup as shipped); wrong for horizontal scaling.
**Future:** database-level serialization (row lock / advisory lock on the
last chain entry) when running multiple instances.

### 12. SQLite in production
The delivered deployment uses SQLite (single file, single writer). Adequate
for the pilot; the schema is PostgreSQL-portable by design and the switch is
documented (docs/DATABASE.md).
**Future:** PostgreSQL for concurrency, DB-level permissions and managed
backups.

---

## Product scope (future work)

- **Split-purchase analytics** — see #2.
- **Budget consumption checking** — see #3.
- **Mobile app / responsive companion** — the web UI is desktop-first; no
  dedicated mobile application exists.
- **Internationalization (i18n)** — the interface ships in English only; the
  platform's default `next-intl` dependency is not wired for FlowControl
  strings.
- **MFA** — not implemented (recommended for admin/director accounts; see
  docs/SECURITY.md §5).
- **Password rotation policy** — password *strength* is enforced; expiry /
  reuse-prevention policies are not.

---

## Summary table

| # | Limitation | Impact today | Mitigation shipped |
|---|---|---|---|
| 1 | `ROLE_PAIR` SoD alert-oriented | Pair conflicts not hard-blocked | `SELF_APPROVAL`, `MULTI_STAGE_SAME_USER` hard-blocked; all exceptions recorded |
| 2 | No split-purchase detection | Threshold circumvention possible via splitting | Thresholds + GD stage per amount window; audit trail enables after-the-fact review |
| 3 | No budget ledger | Budget control is procedural (FIN_CONTROLLER stage) | Stage exists in every purchasing workflow |
| 4 | Noisy fast-track heuristic | Many LOW exceptions on step advances | Informational severity only |
| 5 | Email not sent | Notifications are in-app only | Honest `SKIPPED_NO_SMTP` EmailLog |
| 6 | No scheduler | Escalation waits for dashboard/admin trigger | Lazy run on audit dashboard + on-demand endpoint |
| 7 | Audit chain vs. DBA | Determined privileged tampering possible | Chain verification + anchor hash exposure |
| 8 | No qualified e-signature | Legal e-signature requirements unmet | Hash-bound, audited approvals; documented integration point |
| 9 | No automated tests | Regressions detected by manual verification | CI lint+typecheck+build; E2E scripts; disabled test job placeholder |
| 10 | In-memory inbox scoping | Fine at demo scale | Capped at 500 instances |
| 11 | Single-process audit mutex | No horizontal scaling | `seq` PK guard; DB locking documented as the path |
| 12 | SQLite single-writer | Pilot-scale concurrency | PostgreSQL-portable schema + documented migration |
