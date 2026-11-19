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
import { ROLE_KEYS } from '@/server/rbac'
import { serializeUser } from '@/server/serializers'

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  role: z.enum(ROLE_KEYS).optional(),
  departmentId: z.string().nullable().optional(),
  jobTitle: z.string().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
})

/** PATCH /api/admin/users/[id] — update role/department/status with safeguards. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const admin = await requireUser()
    requirePermission(admin, 'admin.users')
    const { id } = await ctx.params
    const body = await parseBody(req, patchSchema)

    const target = await db.user.findUnique({ where: { id } })
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found.')

    // Guardrails: an administrator cannot deactivate their own account or
    // change their own role (prevents self-lockout / privilege escalation).
    if (target.id === admin.id && body.isActive === false) {
      throw new ApiError(422, 'SELF_LOCKOUT', 'You cannot deactivate your own account.')
    }
    if (target.id === admin.id && body.role && body.role !== admin.role) {
      throw new ApiError(422, 'SELF_ROLE_CHANGE', 'You cannot change your own role.')
    }
    if (body.departmentId) {
      const dept = await db.department.findUnique({ where: { id: body.departmentId } })
      if (!dept) throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown department.')
    }

    const updated = await db.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
          ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.isActive === false ? { failedLogins: 0, lockedUntil: null } : {}),
        },
        include: { department: true },
      })
      if (body.isActive === false) {
        // Deactivation revokes all active sessions immediately.
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })
      }
      await recordAudit(tx, {
        actor: { id: admin.id, role: admin.role },
        action: body.isActive === false ? 'USER_DEACTIVATED' : body.isActive === true ? 'USER_ACTIVATED' : 'USER_UPDATED',
        entityType: 'user',
        entityId: id,
        details: {
          email: target.email,
          changes: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
            ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          },
        },
        ip: getClientIp(req),
      })
      return user
    })

    return json({ user: serializeUser(updated) })
  })
}
