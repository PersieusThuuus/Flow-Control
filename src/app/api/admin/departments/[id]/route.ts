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
import { serializeDepartment } from '@/server/serializers'

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  code: z
    .string()
    .min(2)
    .max(20)
    .regex(/^[A-Z0-9_-]+$/)
    .optional(),
})

/** PATCH /api/admin/departments/[id] */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'admin.departments')
    const { id } = await ctx.params
    const body = await parseBody(req, patchSchema)

    const target = await db.department.findUnique({ where: { id } })
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'Department not found.')
    if (body.code && body.code !== target.code) {
      const existing = await db.department.findUnique({ where: { code: body.code } })
      if (existing) throw new ApiError(422, 'DUPLICATE', 'A department with this code already exists.')
    }

    const department = await db.$transaction(async (tx) => {
      const updated = await tx.department.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.code !== undefined ? { code: body.code } : {}),
        },
      })
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'DEPARTMENT_UPDATED',
        entityType: 'department',
        entityId: id,
        details: { before: { code: target.code, name: target.name }, after: body },
        ip: getClientIp(req),
      })
      return updated
    })
    return json({ department: serializeDepartment(department) })
  })
}
