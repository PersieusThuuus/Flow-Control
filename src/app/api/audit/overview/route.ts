import { db } from '@/lib/db'
import { handle, json, requirePermission, requireUser } from '@/server/api'
import { computeAuditOverview } from '@/server/stats'
import { runControlMonitors } from '@/server/monitors'
import { verifyAuditChain } from '@/server/audit'
import { serializeException } from '@/server/serializers'

/**
 * GET /api/audit/overview — the Internal Audit dashboard. Runs the control
 * monitors lazily (no Celery in this deployment — documented deviation) so
 * overdue/escalation exceptions are up to date whenever an auditor opens the
 * dashboard, then returns exception aggregates, failed-login data and chain
 * integrity — all computed from live records.
 */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'audit.view')

    await runControlMonitors(user)
    const [overview, chain] = await Promise.all([computeAuditOverview(), verifyAuditChain()])

    return json({
      ...overview,
      exceptions: overview.exceptions.map((x) => serializeException(x)),
      failedLoginDetails: overview.failedLoginDetails.map((f) => ({
        email: f.email,
        reason: f.reason,
        ip: f.ip,
        createdAt: f.createdAt.toISOString(),
      })),
      chain: {
        valid: chain.valid,
        eventCount: chain.eventCount,
        latestHash: chain.latestHash,
        firstBrokenSeq: chain.firstBrokenSeq,
        issues: chain.issues,
        verifiedAt: chain.verifiedAt,
      },
    })
  })
}
