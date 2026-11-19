import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit'
import {
  ApiError,
  assertSameOrigin,
  getClientIp,
  handle,
  json,
  parseBody,
  requireRole,
  requireUser,
} from '@/server/api'

const resolveSchema = z.object({ resolution: z.string().min(3).max(500) })

/**
 * POST /api/audit/exceptions/[id]/resolve — administrators document how a
 * control exception was handled. Resolution is additive (resolution note +
 * timestamp); the exception record itself is never rewritten.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requireRole(user, 'SUPER_ADMIN')
    const { id } = await ctx.params
    const { resolution } = await parseBody(req, resolveSchema)

    const exception = await db.controlException.findUnique({ where: { id } })
    if (!exception) throw new ApiError(404, 'NOT_FOUND', 'Exception not found.')
    if (exception.resolvedAt) throw new ApiError(409, 'ALREADY_RESOLVED', 'This exception is already resolved.')

    await db.$transaction(async (tx) => {
      await tx.controlException.update({ where: { id }, data: { resolvedAt: new Date(), resolution } })
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'CONTROL_EXCEPTION_RESOLVED',
        entityType: 'control_exception',
        entityId: id,
        details: { type: exception.type, resolution },
        ip: getClientIp(req),
      })
    })

    return json({ ok: true })
  })
}
