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
  parsePagination,
  requirePermission,
  requireUser,
} from '@/server/api'
import { ROLE_KEYS } from '@/server/rbac'
import { serializeUser } from '@/server/serializers'

/** GET /api/admin/users — user management list (admin only). */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'admin.users')
    const url = new URL(req.url)
    const { page, pageSize, skip, take } = parsePagination(url, 50)
    const q = url.searchParams.get('q')
    const role = url.searchParams.get('role')

    const where = {
      ...(role ? { role } : {}),
      ...(q
        ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] }
        : {}),
    }
    const [total, users] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({ where, include: { department: true }, orderBy: { createdAt: 'asc' }, skip, take }),
    ])
    return json({
      items: users.map(serializeUser),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    })
  })
}

const createSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  role: z.enum(ROLE_KEYS),
  departmentId: z.string().nullable().optional(),
  jobTitle: z.string().max(120).nullable().optional(),
})

/** POST /api/admin/users — create a user with server-side password policy. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const admin = await requireUser()
    requirePermission(admin, 'admin.users')
    const body = await parseBody(req, createSchema)

    const policy = validatePasswordPolicy(body.password)
    if (!policy.valid) throw new ApiError(422, 'WEAK_PASSWORD', `Password policy: ${policy.errors.join('; ')}.`)

    const email = body.email.toLowerCase()
    const existing = await db.user.findUnique({ where: { email } })
    if (existing) throw new ApiError(422, 'DUPLICATE', 'A user with this email already exists.')
    if (body.departmentId) {
      const dept = await db.department.findUnique({ where: { id: body.departmentId } })
      if (!dept) throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown department.')
    }

    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: body.name,
          email,
          passwordHash: hashPassword(body.password),
          role: body.role,
          departmentId: body.departmentId ?? null,
          jobTitle: body.jobTitle ?? null,
        },
      })
      await recordAudit(tx, {
        actor: { id: admin.id, role: admin.role },
        action: 'USER_CREATED',
        entityType: 'user',
        entityId: created.id,
        details: { email, name: body.name, role: body.role, departmentId: body.departmentId ?? null },
        ip: getClientIp(req),
      })
      return tx.user.findUnique({ where: { id: created.id }, include: { department: true } })
    })
    if (!user) throw new ApiError(500, 'INTERNAL', 'User creation failed unexpectedly.')

    return json({ user: serializeUser(user) }, 201)
  })
}
