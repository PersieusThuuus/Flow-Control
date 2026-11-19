import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit'
import { ApiError, assertSameOrigin, getClientIp, handle, json, requireUser } from '@/server/api'

/** POST /api/delegations/[id]/revoke — revoke a delegation (delegator or admin). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    const { id } = await ctx.params

    const delegation = await db.approvalDelegation.findUnique({ where: { id } })
    if (!delegation) throw new ApiError(404, 'NOT_FOUND', 'Delegation not found.')
    if (delegation.fromUserId !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ApiError(403, 'FORBIDDEN', 'Only the delegator or an administrator may revoke a delegation.')
    }
    if (!delegation.isActive) throw new ApiError(409, 'INVALID_STATE', 'This delegation is already revoked.')

    await db.$transaction(async (tx) => {
      await tx.approvalDelegation.update({ where: { id }, data: { isActive: false, revokedAt: new Date() } })
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'DELEGATION_REVOKED',
        entityType: 'delegation',
        entityId: id,
        details: { revokedBy: user.email },
        ip: getClientIp(req),
      })
    })

    return json({ ok: true })
  })
}
