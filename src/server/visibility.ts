import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { hasPermission, type SessionUser } from './rbac'

/** The single source of truth for document list/report visibility. */
export async function visibleDocumentsWhere(user: SessionUser): Promise<Prisma.DocumentWhereInput> {
  if (hasPermission(user, 'documents.view.all')) return {}
  const or: Prisma.DocumentWhereInput[] = [{ createdById: user.id }]
  if (hasPermission(user, 'documents.view.department') && user.departmentId) {
    or.push({ departmentId: user.departmentId })
  }
  if (hasPermission(user, 'documents.view.routed')) {
    const approvals = await db.approval.findMany({
      where: { userId: user.id },
      select: { instance: { select: { documentId: true } } },
      distinct: ['instanceId'],
    })
    const documentIds = approvals.map((approval) => approval.instance.documentId)
    if (documentIds.length > 0) or.push({ id: { in: documentIds } })
  }
  return { OR: or }
}
