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

/** GET /api/admin/sod-rules — configurable segregation-of-duties rules. */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'admin.sod')
    const rules = await db.soDRule.findMany({ orderBy: { code: 'asc' } })
    return json({ items: rules.map(serializeSoDRule) })
  })
}

const createSchema = z.object({
  code: z.string().min(2).max(40).regex(/^[A-Z0-9_-]+$/),
  name: z.string().min(3).max(120),
  ruleType: z.enum(['SELF_APPROVAL', 'ROLE_PAIR', 'MULTI_STAGE_SAME_USER']),
  roleA: z.string().optional().nullable(),
  roleB: z.string().optional().nullable(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
  description: z.string().max(500).optional().nullable(),
})

/** POST /api/admin/sod-rules — create a SoD rule. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'admin.sod')
    const body = await parseBody(req, createSchema)

    if (body.ruleType === 'ROLE_PAIR' && (!body.roleA || !body.roleB)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'ROLE_PAIR rules require two roles.')
    }
    const existing = await db.soDRule.findUnique({ where: { code: body.code } })
    if (existing) throw new ApiError(422, 'DUPLICATE', 'A rule with this code already exists.')

    const rule = await db.$transaction(async (tx) => {
      const created = await tx.soDRule.create({
        data: {
          code: body.code,
          name: body.name,
          ruleType: body.ruleType,
          roleA: body.roleA ?? null,
          roleB: body.roleB ?? null,
          severity: body.severity,
          description: body.description ?? null,
        },
      })
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'SOD_RULE_CHANGED',
        entityType: 'sod_rule',
        entityId: created.id,
        details: { code: body.code, ruleType: body.ruleType, created: true },
        ip: getClientIp(req),
      })
      return created
    })
    return json({ rule: serializeSoDRule(rule) }, 201)
  })
}
