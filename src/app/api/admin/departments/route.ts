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

/** GET /api/admin/departments */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'admin.departments')
    const [departments, counts] = await Promise.all([
      db.department.findMany({ orderBy: { name: 'asc' } }),
      db.user.groupBy({ by: ['departmentId'], where: { isActive: true }, _count: true }),
    ])
    const countMap = new Map(counts.map((c) => [c.departmentId, c._count]))
    return json({
      items: departments.map((d) => ({ ...serializeDepartment(d), userCount: countMap.get(d.id) ?? 0 })),
    })
  })
}

const createSchema = z.object({
  code: z.string().min(2).max(20).regex(/^[A-Z0-9_-]+$/, 'Code must be uppercase letters, digits, - or _'),
  name: z.string().min(2).max(120),
})

/** POST /api/admin/departments */
export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'admin.departments')
    const body = await parseBody(req, createSchema)

    const existing = await db.department.findUnique({ where: { code: body.code } })
    if (existing) throw new ApiError(422, 'DUPLICATE', 'A department with this code already exists.')

    const department = await db.$transaction(async (tx) => {
      const created = await tx.department.create({ data: { code: body.code, name: body.name } })
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'DEPARTMENT_CREATED',
        entityType: 'department',
        entityId: created.id,
        details: { code: body.code, name: body.name },
        ip: getClientIp(req),
      })
      return created
    })
    return json({ department: serializeDepartment(department) }, 201)
  })
}
