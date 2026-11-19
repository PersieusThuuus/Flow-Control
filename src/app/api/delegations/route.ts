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
import { serializeDelegation } from '@/server/serializers'

/** GET /api/delegations — delegations given by and received by the current user. */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    const rows = await db.approvalDelegation.findMany({
      where: { OR: [{ fromUserId: user.id }, { toUserId: user.id }] },
      include: {
        fromUser: { select: { id: true, name: true, email: true, role: true } },
        toUser: { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    return json({
      given: rows.filter((r) => r.fromUserId === user.id).map(serializeDelegation),
      received: rows.filter((r) => r.toUserId === user.id).map(serializeDelegation),
    })
  })
}

const createSchema = z.object({
  toUserEmail: z.string().email(),
  reason: z.string().min(5).max(500),
  startAt: z.string(), // ISO date
  endAt: z.string(), // ISO date
})

const MAX_DELEGATION_DAYS = 30

/** POST /api/delegations — delegate approval authority with traceability. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'delegations.manage')
    const body = await parseBody(req, createSchema)

    const toUser = await db.user.findUnique({ where: { email: body.toUserEmail.toLowerCase() } })
    if (!toUser || !toUser.isActive) throw new ApiError(422, 'VALIDATION_ERROR', 'Target user not found or inactive.')
    if (toUser.id === user.id) throw new ApiError(422, 'VALIDATION_ERROR', 'You cannot delegate to yourself.')
    // Delegation targets must already hold approval authority (approvals.act):
    // delegating to a user who could never act would create tasks they cannot
    // perform. PURCHASING, SUPER_ADMIN and INTERNAL_AUDITOR are excluded.
    if (!['DEPT_MANAGER', 'FIN_CONTROLLER', 'ACCOUNTANT', 'TREASURY', 'GENERAL_DIRECTOR'].includes(toUser.role)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Delegation targets must hold an approval role (manager, controller, accountant, treasury or director).')
    }

    const startAt = new Date(body.startAt)
    const endAt = new Date(body.endAt)
    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'The delegation period is invalid (end must be after start).')
    }
    if (endAt.getTime() - startAt.getTime() > MAX_DELEGATION_DAYS * 24 * 3600_000) {
      throw new ApiError(422, 'VALIDATION_ERROR', `Delegations cannot exceed ${MAX_DELEGATION_DAYS} days.`)
    }
    if (startAt.getTime() < Date.now() - 24 * 3600_000) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'The delegation start cannot be in the past.')
    }

    const delegation = await db.$transaction(async (tx) => {
      const created = await tx.approvalDelegation.create({
        data: {
          fromUserId: user.id,
          toUserId: toUser.id,
          reason: body.reason,
          startAt,
          endAt,
          createdById: user.id,
        },
      })
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'DELEGATION_CREATED',
        entityType: 'delegation',
        entityId: created.id,
        details: { from: user.email, to: toUser.email, reason: body.reason, startAt: startAt.toISOString(), endAt: endAt.toISOString() },
        ip: getClientIp(req),
      })
      return tx.approvalDelegation.findUnique({
        where: { id: created.id },
        include: {
          fromUser: { select: { id: true, name: true, email: true, role: true } },
          toUser: { select: { id: true, name: true, email: true, role: true } },
        },
      })
    })
    if (!delegation) throw new ApiError(500, 'INTERNAL', 'Delegation creation failed unexpectedly.')

    return json({ delegation: serializeDelegation(delegation) }, 201)
  })
}
