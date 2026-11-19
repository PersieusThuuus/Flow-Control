import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, assertSameOrigin, getClientIp, handle, json, parseBody, requirePermission, requireUser } from '@/server/api'
import { actOnInstance } from '@/server/engine'

const actSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'RETURN_FOR_CORRECTION', 'COMMENT']),
  comment: z.string().max(2000).optional().nullable(),
  confirm: z.boolean(),
  stageId: z.string().max(100).optional().nullable(),
  expectedStep: z.number().int().min(0).max(999).optional().nullable(),
})

/**
 * POST /api/approvals/[instanceId]/act — the electronic approval endpoint.
 * Enforces: authentication, approvals.act permission, engine-level
 * eligibility, segregation of duties, thresholds and explicit confirmation.
 * Every decision (and every blocked attempt) is audited.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ instanceId: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'approvals.act')
    const { instanceId } = await ctx.params
    const body = await parseBody(req, actSchema)

    const result = await actOnInstance({
      user,
      instanceId,
      action: body.action,
      comment: body.comment ?? null,
      confirm: body.confirm,
      stageId: body.stageId ?? null,
      expectedStep: body.expectedStep ?? null,
      ip: getClientIp(req),
    })
    if (!result.ok) throw new ApiError(result.status, result.code, result.message)
    return json({ ok: true, message: result.message })
  })
}
