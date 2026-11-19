import { db } from '@/lib/db'
import { handle, json, requirePermission, requireUser } from '@/server/api'
import { recordAudit, verifyAuditChain } from '@/server/audit'

/**
 * GET /api/audit/integrity — verify the full audit hash chain and expose the
 * latest hash ("chain anchor") for external anchoring in production.
 */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'audit.view')
    const verification = await verifyAuditChain()
    await recordAudit(db, {
      actor: { id: user.id, role: user.role },
      action: 'AUDIT_CHAIN_VERIFIED',
      entityType: 'system',
      details: { valid: verification.valid, eventCount: verification.eventCount, firstBrokenSeq: verification.firstBrokenSeq },
    })
    return json(verification)
  })
}
