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
import { APPROVER_ROLES } from '@/server/rbac'
import { serializeApprovalRule } from '@/server/serializers'

/** GET /api/admin/thresholds — per-role approval amount limits. */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'admin.thresholds')
    const rules = await db.approvalRule.findMany({ orderBy: { role: 'asc' } })
    return json({
      items: rules.map(serializeApprovalRule),
      approverRoles: APPROVER_ROLES,
    })
  })
}

const putSchema = z.object({
  rules: z
    .array(
      z.object({
        role: z.enum(APPROVER_ROLES as [string, ...string[]]),
        maxAmount: z.number().int().min(0).max(999_999_999_999).nullable(),
      }),
    )
    .min(1),
})

/** PUT /api/admin/thresholds — upsert the approval limit of one or more roles. */
export async function PUT(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'admin.thresholds')
    const body = await parseBody(req, putSchema)

    await db.$transaction(async (tx) => {
      for (const rule of body.rules) {
        await tx.approvalRule.upsert({
          where: { role: rule.role },
          create: { role: rule.role, maxAmount: rule.maxAmount === null ? null : BigInt(rule.maxAmount) },
          update: { maxAmount: rule.maxAmount === null ? null : BigInt(rule.maxAmount) },
        })
      }
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'THRESHOLD_CONFIG_CHANGED',
        entityType: 'system',
        details: { rules: body.rules },
        ip: getClientIp(req),
      })
    })

    const rules = await db.approvalRule.findMany({ orderBy: { role: 'asc' } })
    return json({ items: rules.map(serializeApprovalRule) })
  })
}
