import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { handle, json, parsePagination, requirePermission, requireUser } from '@/server/api'
import { serializeAuditEvent } from '@/server/serializers'
import type { Prisma } from '@prisma/client'

/** GET /api/audit/events — filterable, paginated audit trail (auditor/admin). */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'audit.view')
    const url = new URL(req.url)
    const { page, pageSize, skip, take } = parsePagination(url, 25)
    const action = url.searchParams.get('action')
    const actorEmail = url.searchParams.get('actorEmail')
    const entityType = url.searchParams.get('entityType')
    const entityId = url.searchParams.get('entityId')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')

    const where: Prisma.AuditEventWhereInput = {
      ...(action ? { action } : {}),
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to + 'T23:59:59.999Z') } : {}),
            },
          }
        : {}),
      ...(actorEmail ? { actor: { email: { contains: actorEmail } } } : {}),
    }

    const [total, events] = await Promise.all([
      db.auditEvent.count({ where }),
      db.auditEvent.findMany({
        where,
        include: { actor: { select: { name: true, email: true } } },
        orderBy: { seq: 'desc' },
        skip,
        take,
      }),
    ])

    return json({
      items: events.map(serializeAuditEvent),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    })
  })
}
