import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { hashPassword, validatePasswordPolicy } from '@/server/auth'
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

const schema = z.object({ password: z.string().min(8).max(200) })

/** POST /api/admin/users/[id]/reset-password — set a new password (policy-enforced). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const admin = await requireUser()
    requirePermission(admin, 'admin.users')
    const { id } = await ctx.params
    const { password } = await parseBody(req, schema)

    const policy = validatePasswordPolicy(password)
    if (!policy.valid) throw new ApiError(422, 'WEAK_PASSWORD', `Password policy: ${policy.errors.join('; ')}.`)

    const target = await db.user.findUnique({ where: { id } })
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found.')

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash: hashPassword(password), failedLogins: 0, lockedUntil: null },
      })
      // Password reset invalidates all existing sessions of the target user.
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })
      await recordAudit(tx, {
        actor: { id: admin.id, role: admin.role },
        action: 'USER_PASSWORD_RESET',
        entityType: 'user',
        entityId: id,
        details: { email: target.email },
        ip: getClientIp(req),
      })
    })

    return json({ ok: true })
  })
}
