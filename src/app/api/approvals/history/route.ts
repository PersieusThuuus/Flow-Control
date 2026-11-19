import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { handle, json, parsePagination, requireUser } from '@/server/api'
import { serializeApproval, resolveUserNames } from '@/server/serializers'

/** GET /api/approvals/history — the current user's decision history. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    const url = new URL(req.url)
    const { page, pageSize, skip, take } = parsePagination(url)
    const action = url.searchParams.get('action')

    const where = {
      userId: user.id,
      ...(action ? { action } : {}),
    }

    const [total, approvals] = await Promise.all([
      db.approval.count({ where }),
      db.approval.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          documentVersion: { select: { version: true } },
          instance: { include: { document: { select: { id: true, reference: true, title: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ])

    // Resolve delegation display names (delegatedFromId is a scalar snapshot).
    const nameMap = await resolveUserNames(approvals.map((a) => a.delegatedFromId))

    return json({
      items: approvals.map((a) => ({
        ...serializeApproval(a),
        delegatedFromName: a.delegatedFromId ? nameMap.get(a.delegatedFromId) ?? null : null,
      })),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    })
  })
}
