import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit'
import {
  getClientIp,
  handle,
  parseFiltersFromUrl,
  requirePermission,
  requireUser,
} from '@/server/api'
import { hasPermission } from '@/server/rbac'
import type { Prisma } from '@prisma/client'

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** GET /api/reports/export — CSV export of requests (visibility-scoped). */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'reports.view')
    const f = parseFiltersFromUrl(new URL(req.url))

    const filters: Prisma.DocumentWhereInput = {
      ...(f.from || f.to
        ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } }
        : {}),
      ...(f.departmentId ? { departmentId: f.departmentId } : {}),
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.userId ? { createdById: f.userId } : {}),
      ...(f.q ? { OR: [{ reference: { contains: f.q } }, { title: { contains: f.q } }] } : {}),
    }

    let visibility: Prisma.DocumentWhereInput = {}
    if (!hasPermission(user, 'documents.view.all')) {
      const or: Prisma.DocumentWhereInput[] = [{ createdById: user.id }]
      if (hasPermission(user, 'documents.view.department') && user.departmentId) {
        or.push({ departmentId: user.departmentId })
      }
      const acted = await db.approval.findMany({
        where: { userId: user.id },
        select: { instance: { select: { documentId: true } } },
        distinct: ['instanceId'],
      })
      const docIds = acted.map((a) => a.instance.documentId)
      if (docIds.length > 0) or.push({ id: { in: docIds } })
      visibility = { OR: or }
    }

    const where: Prisma.DocumentWhereInput = { AND: [filters, visibility] }

    const documents = await db.document.findMany({
      where,
      include: { department: true, category: true, createdBy: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const columns = [
      'reference',
      'createdAt',
      'title',
      'category',
      'department',
      'createdBy',
      'supplier',
      'amount',
      'currency',
      'status',
      'versions',
    ]
    const rows = documents.map((d) => ({
      reference: d.reference,
      createdAt: d.createdAt.toISOString(),
      title: d.title,
      category: d.category.name,
      department: d.department.name,
      createdBy: d.createdBy.email,
      supplier: d.supplierName ?? '',
      amount: d.amount.toString(),
      currency: d.currency,
      status: d.status,
      versions: d.currentVersion,
    }))

    await recordAudit(db, {
      actor: { id: user.id, role: user.role },
      action: 'AUDIT_EXPORTED',
      entityType: 'system',
      details: { exportType: 'requests', rowCount: rows.length },
      ip: getClientIp(req),
    })

    const csv = `${columns.join(',')}\n${rows.map((r) => columns.map((c) => csvEscape(r[c])).join(',')).join('\n')}\n`
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="flowcontrol-requests-${Date.now()}.csv"`,
      },
    })
  })
}
