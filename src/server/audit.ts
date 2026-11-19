// ============================================================================
// FlowControl — Audit Trail Service (tamper-evident hash chain)
//
// Every security-relevant event is appended to an append-only AuditEvent
// table. Each row stores:
//   hash = SHA-256( seq | prevHash | occurredAt | actorId | action |
//                   entityType | entityId | canonicalJSON(details) )
//
// The chain is sequential: each event references the hash of its predecessor
// (the first event references the literal "GENESIS"). Any modification or
// deletion of a historical row breaks every subsequent hash, which the
// verification endpoint (verifyAuditChain) detects.
//
// HONEST SECURITY LIMITATION (also documented in docs/SECURITY.md):
//   This mechanism defends against tampering *through the application* and
//   detects accidental or naive direct-database edits. It does NOT defend
//   against a database administrator who edits a row AND recomputes all
//   subsequent hashes. Stronger tamper resistance requires infrastructure
//   outside the application: append-only/WORM storage, database-level
//   restrictive permissions, periodic publication of the latest chain hash
//   to an independent system (the admin UI exposes this "chain anchor"),
//   or an external timestamping authority.
// ============================================================================

import { createHash } from 'crypto'
import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export const AUDIT_ACTIONS = [
  // Authentication
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'ACCOUNT_LOCKED',
  // Documents
  'DOCUMENT_CREATED',
  'DOCUMENT_VERSION_UPLOADED',
  'DOCUMENT_DOWNLOADED',
  'DOCUMENT_UPDATED',
  // Workflow
  'REQUEST_SUBMITTED',
  'REQUEST_RESUBMITTED',
  'APPROVAL_GRANTED',
  'APPROVAL_REJECTED',
  'RETURN_FOR_CORRECTION',
  'COMMENT_ADDED',
  'REQUEST_CANCELLED',
  'WORKFLOW_SUSPENDED',
  'WORKFLOW_RESUMED',
  'REQUEST_APPROVED',
  'OVERDUE_DETECTED',
  'CONTROL_MONITOR_RUN',
  // Delegations
  'DELEGATION_CREATED',
  'DELEGATION_REVOKED',
  // Internal control
  'SOD_VIOLATION_BLOCKED',
  'THRESHOLD_BREACH_BLOCKED',
  'UNAUTHORIZED_ACCESS_BLOCKED',
  'EVIDENCE_EXCEPTION_RECORDED',
  'CONTROL_EXCEPTION_RESOLVED',
  // Administration
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DEACTIVATED',
  'USER_ACTIVATED',
  'USER_PASSWORD_RESET',
  'DEPARTMENT_CREATED',
  'DEPARTMENT_UPDATED',
  'WORKFLOW_CONFIG_CHANGED',
  'THRESHOLD_CONFIG_CHANGED',
  'SOD_RULE_CHANGED',
  // Audit
  'AUDIT_EXPORTED',
  'AUDIT_CHAIN_VERIFIED',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

const GENESIS = 'GENESIS'

/** Deterministic JSON serialization: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return null
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v === 'bigint') return v.toString()
    if (v instanceof Date) return v.toISOString()
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      const out: Record<string, unknown> = {}
      for (const [k, val] of entries) out[k] = walk(val)
      return out
    }
    return v
  }
  return JSON.stringify(walk(value))
}

export function computeAuditHash(input: {
  seq: number
  prevHash: string
  occurredAt: Date
  actorId: string | null
  action: string
  entityType: string | null
  entityId: string | null
  details: string | null
}): string {
  const parts = [
    input.seq,
    input.prevHash,
    input.occurredAt.toISOString(),
    input.actorId ?? 'SYSTEM',
    input.action,
    input.entityType ?? '',
    input.entityId ?? '',
    input.details ?? '',
  ]
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex')
}

export type AuditClient = Prisma.TransactionClient | typeof db

export type AuditInput = {
  actor?: { id: string; role: string } | null
  action: AuditAction
  entityType?: string
  entityId?: string
  details?: unknown
  ip?: string | null
  /**
   * Explicit event timestamp. Used by the demo-data seeder to keep generated
   * history chronologically realistic; the timestamp is part of the hashed
   * payload, so the chain remains verifiable. Default: current time.
   */
  at?: Date
}

/**
 * In-process append mutex. The dev deployment runs a single Node process, so
 * serializing appends here guarantees that two concurrent transactions never
 * read the same "last event". The explicit monotonic `seq` primary key is a
 * second line of defense (a colliding insert fails the transaction).
 * Multi-instance deployments should use database-level locking instead
 * (documented in docs/ARCHITECTURE.md).
 */
let appendChain: Promise<unknown> = Promise.resolve()

export async function recordAudit(client: AuditClient, input: AuditInput): Promise<void> {
  const run = async (): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const last = await client.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } })
        const seq = (last?.seq ?? 0) + 1
        const prevHash = last?.hash ?? GENESIS
        const occurredAt = input.at ?? new Date()
        const details = input.details === undefined ? null : canonicalJson(input.details)
        const hash = computeAuditHash({
          seq,
          prevHash,
          occurredAt,
          actorId: input.actor?.id ?? null,
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          details,
        })
        await client.auditEvent.create({
          data: {
            seq,
            occurredAt,
            actorId: input.actor?.id ?? null,
            actorRole: input.actor?.role ?? null,
            action: input.action,
            entityType: input.entityType ?? null,
            entityId: input.entityId ?? null,
            details,
            ip: input.ip ?? null,
            prevHash,
            hash,
          },
        })
        return
      } catch (err) {
        // Unique PK collision on seq — another append won the race; retry.
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('Unique constraint') && attempt < 2) continue
        throw err
      }
    }
  }
  appendChain = appendChain.then(run, run)
  await appendChain
}

export type ChainIssue = { seq: number; problem: string }

export type ChainVerification = {
  valid: boolean
  eventCount: number
  firstBrokenSeq: number | null
  issues: ChainIssue[]
  latestHash: string | null
  verifiedAt: string
}

/**
 * Recompute the full chain and report the first inconsistency.
 * Detects: sequence gaps, broken prevHash linkage, and hash mismatches
 * (i.e., any field of a historical event was modified).
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const events = await db.auditEvent.findMany({ orderBy: { seq: 'asc' } })
  const issues: ChainIssue[] = []
  let firstBrokenSeq: number | null = null
  let expectedSeq = 1
  let prevHash = GENESIS

  for (const ev of events) {
    if (ev.seq !== expectedSeq) {
      issues.push({ seq: ev.seq, problem: `Sequence gap: expected ${expectedSeq}, found ${ev.seq}` })
      if (firstBrokenSeq === null) firstBrokenSeq = ev.seq
    }
    if (ev.prevHash !== prevHash) {
      issues.push({ seq: ev.seq, problem: 'prevHash does not match the hash of the preceding event' })
      if (firstBrokenSeq === null) firstBrokenSeq = ev.seq
    }
    const expectedHash = computeAuditHash({
      seq: ev.seq,
      prevHash: ev.prevHash,
      occurredAt: ev.occurredAt,
      actorId: ev.actorId,
      action: ev.action,
      entityType: ev.entityType,
      entityId: ev.entityId,
      details: ev.details,
    })
    if (expectedHash !== ev.hash) {
      issues.push({ seq: ev.seq, problem: 'Stored hash does not match recomputed hash (row modified or forged)' })
      if (firstBrokenSeq === null) firstBrokenSeq = ev.seq
    }
    prevHash = ev.hash
    expectedSeq = ev.seq + 1
  }

  return {
    valid: issues.length === 0,
    eventCount: events.length,
    firstBrokenSeq,
    issues: issues.slice(0, 20),
    latestHash: events.length > 0 ? events[events.length - 1].hash : null,
    verifiedAt: new Date().toISOString(),
  }
}
