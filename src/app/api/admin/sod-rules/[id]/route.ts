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
  requirePermission,
  requireUser,
} from '@/server/api'
import { serializeSoDRule } from '@/server/serializers'

const patchSchema = z.object({
  isActive: z.boolean().optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  name: z.string().min(3).max(120).optional(),
  description: z.string().max(500).optional().nullable(),
})

/** PATCH /api/admin/sod-rules/[id] — toggle or adjust a SoD rule. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'admin.sod')
    const { id } = await ctx.params
    const body = await parseBody(req, patchSchema)

    const target = await db.soDRule.findUnique({ where: { id } })
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'Rule not found.')

    const rule = await db.$transaction(async (tx) => {
      const updated = await tx.soDRule.update({
        where: { id },
        data: {
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.severity !== undefined ? { severity: body.severity } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
        },
      })
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'SOD_RULE_CHANGED',
        entityType: 'sod_rule',
        entityId: id,
        details: { code: target.code, changes: body },
        ip: getClientIp(req),
      })
      return updated
    })
    return json({ rule: serializeSoDRule(rule) })
  })
}
