import { db } from '@/lib/db'
import { handle, json, requirePermission, requireUser } from '@/server/api'
import { verifyAuditChain } from '@/server/audit'

/** GET /api/admin/overview — system-wide statistics for the admin console. */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'admin.overview')

    const [users, activeSessions, documentsByStatus, storage, workflows, chain, emailsSkipped, unresolvedExceptions] =
      await Promise.all([
        db.user.groupBy({ by: ['role'], _count: true }),
        db.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
        db.document.groupBy({ by: ['status'], _count: true }),
        db.documentVersion.aggregate({ _sum: { sizeBytes: true } }),
        db.workflow.count({ where: { isActive: true } }),
        verifyAuditChain(),
        db.emailLog.count({ where: { status: 'SKIPPED_NO_SMTP' } }),
        db.controlException.count({ where: { resolvedAt: null } }),
      ])

    const usersByRole: Record<string, number> = {}
    for (const u of users) usersByRole[u.role] = u._count
    const docsByStatus: Record<string, number> = {}
    for (const d of documentsByStatus) docsByStatus[d.status] = d._count

    return json({
      usersByRole,
      totalUsers: Object.values(usersByRole).reduce((a, b) => a + b, 0),
      activeSessions,
      documentsByStatus: docsByStatus,
      totalDocuments: Object.values(docsByStatus).reduce((a, b) => a + b, 0),
      storageBytes: storage._sum.sizeBytes ?? 0,
      activeWorkflows: workflows,
      auditChain: { valid: chain.valid, eventCount: chain.eventCount, latestHash: chain.latestHash },
      emailsSkipped,
      unresolvedExceptions,
    })
  })
}
