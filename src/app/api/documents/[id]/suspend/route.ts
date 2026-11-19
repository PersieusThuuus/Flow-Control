import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ApiError, assertSameOrigin, getClientIp, handle, json, parseBody, requireUser } from '@/server/api'
import { setInstanceSuspension } from '@/server/engine'

const suspendSchema = z.object({
  suspend: z.boolean(),
  reason: z.string().min(3).max(500),
})

/**
 * POST /api/documents/[id]/suspend — administrator-only suspension/resumption
 * of the active workflow instance (e.g. pending an investigation).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    const { id } = await ctx.params
    const { suspend, reason } = await parseBody(req, suspendSchema)

    const instance = await db.workflowInstance.findFirst({
      where: { documentId: id, status: suspend ? 'IN_PROGRESS' : 'SUSPENDED' },
      orderBy: { createdAt: 'desc' },
    })
    if (!instance) {
      throw new ApiError(409, 'INVALID_STATE', suspend ? 'No in-progress workflow to suspend.' : 'This document has no suspended workflow.')
    }

    const result = await setInstanceSuspension({
      admin: user,
      instanceId: instance.id,
      suspend,
      reason,
      ip: getClientIp(req),
    })
    if (!result.ok) throw new ApiError(result.status, result.code, result.message)
    return json({ ok: true, message: result.message })
  })
}
