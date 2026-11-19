import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { handle, json, parsePagination, requirePermission, requireUser } from '@/server/api'
import { serializeException } from '@/server/serializers'
import type { Prisma } from '@prisma/client'

/** GET /api/audit/exceptions — control exceptions with filters. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'audit.view')
    const url = new URL(req.url)
    const { page, pageSize, skip, take } = parsePagination(url, 25)
    const type = url.searchParams.get('type')
    const severity = url.searchParams.get('severity')
    const resolved = url.searchParams.get('resolved')

    const where: Prisma.ControlExceptionWhereInput = {
      ...(type ? { type } : {}),
      ...(severity ? { severity } : {}),
      ...(resolved === 'true' ? { resolvedAt: { not: null } } : resolved === 'false' ? { resolvedAt: null } : {}),
    }

    const [total, exceptions] = await Promise.all([
      db.controlException.count({ where }),
      db.controlException.findMany({
        where,
        include: {
          document: { select: { reference: true, title: true } },
          subject: { select: { id: true, name: true, email: true } },
        },
        orderBy: { detectedAt: 'desc' },
        skip,
        take,
      }),
    ])

    return json({
      items: exceptions.map(serializeException),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    })
  })
}
