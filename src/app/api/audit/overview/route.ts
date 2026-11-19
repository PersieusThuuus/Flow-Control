import { db } from '@/lib/db'
import { handle, json, requirePermission, requireUser } from '@/server/api'
import { computeAuditOverview } from '@/server/stats'
import { verifyAuditChain } from '@/server/audit'
import { serializeException } from '@/server/serializers'

/**
 * GET /api/audit/overview — read-only audit aggregates and chain integrity.
 * Monitor execution is explicit through the administrator monitor action.
 */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'audit.view')

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
