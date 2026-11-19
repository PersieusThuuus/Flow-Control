// ============================================================================
// FlowControl — Statistics & Aggregation Service
//
// Every figure exposed by dashboards and reports is computed here from real
// database records. Nothing is hardcoded or simulated.
//
// Scope rules:
//   - SUPER_ADMIN / INTERNAL_AUDITOR: organization-wide statistics.
//   - DEPT_MANAGER: own department's requests plus requests routed to them.
//   - Other roles: their own requests, requests routed to them, and requests
//     they acted upon.
// ============================================================================

import { db } from '@/lib/db'
import type { Prisma as PrismaNamespace } from '@prisma/client'
import { hasPermission, type SessionUser } from './rbac'
import { currentStepOf, parseStagePath } from './engine'

export type DashboardFilters = {
  from?: Date | null
  to?: Date | null
  departmentId?: string | null
  categoryId?: string | null
  status?: string | null
  userId?: string | null
  minAmount?: bigint | null
  maxAmount?: bigint | null
}

function documentWhere(filters: DashboardFilters): PrismaNamespace.DocumentWhereInput {
  return {
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.userId ? { createdById: filters.userId } : {}),
    ...(filters.minAmount !== null && filters.minAmount !== undefined ? { amount: { gte: filters.minAmount } } : {}),
    ...(filters.maxAmount !== null && filters.maxAmount !== undefined
      ? { amount: { ...(filters.minAmount !== null && filters.minAmount !== undefined ? { gte: filters.minAmount } : {}), lte: filters.maxAmount } }
      : {}),
  }
}

/** Documents visible to the user, intersected with dashboard filters. */
async function scopedDocuments(user: SessionUser, filters: DashboardFilters) {
  const base = documentWhere(filters)
  if (hasPermission(user, 'documents.view.all')) {
    return db.document.findMany({ where: base, include: { department: true, category: true, createdBy: true } })
  }
  const or: PrismaNamespace.DocumentWhereInput[] = [{ createdById: user.id }]
  if (hasPermission(user, 'documents.view.department') && user.departmentId) {
    or.push({ departmentId: user.departmentId })
  }
  if (hasPermission(user, 'documents.view.routed')) {
    const actedInstanceIds = await db.approval.findMany({
      where: { userId: user.id },
      select: { instance: { select: { documentId: true } } },
      distinct: ['instanceId'],
    })
    const docIds = actedInstanceIds.map((a) => a.instance.documentId)
    if (docIds.length > 0) or.push({ id: { in: docIds } })
  }
  return db.document.findMany({ where: { AND: [base, { OR: or }] }, include: { department: true, category: true, createdBy: true } })
}

export type DashboardData = Awaited<ReturnType<typeof computeDashboard>>

export async function computeDashboard(user: SessionUser, filters: DashboardFilters) {
  const documents = await scopedDocuments(user, filters)
  const documentIds = documents.map((d) => d.id)

  const instances = await db.workflowInstance.findMany({
    where: { documentId: { in: documentIds } },
    include: { document: true, approvals: { orderBy: { createdAt: 'asc' } } },
  })

  const inProgress = instances.filter((i) => i.status === 'IN_PROGRESS')
  const approved = instances.filter((i) => i.status === 'APPROVED')
  const rejected = instances.filter((i) => i.status === 'REJECTED')
  const returned = instances.filter((i) => i.status === 'RETURNED_FOR_CORRECTION')
  const suspended = instances.filter((i) => i.status === 'SUSPENDED')

  // Overdue: in-progress instances whose current step exceeded its SLA.
  const now = Date.now()
  const overdueInstanceIds: string[] = []
  for (const instance of inProgress) {
    const step = currentStepOf(instance)
    if (!step) continue
    const slas = step.stages.filter((s) => s.isRequired && s.slaHours !== null).map((s) => s.slaHours as number)
    if (slas.length === 0) continue
    const dueAt = instance.currentStepStartedAt.getTime() + Math.min(...slas) * 3600_000
    if (dueAt < now) overdueInstanceIds.push(instance.id)
  }

  // Average approval time over completed instances.
  const durationsHours = approved
    .filter((i) => i.completedAt)
    .map((i) => (i.completedAt as Date).getTime() - i.submittedAt.getTime())
    .map((ms) => ms / 3600_000)
  const avgApprovalHours =
    durationsHours.length > 0 ? durationsHours.reduce((a, b) => a + b, 0) / durationsHours.length : null

  // Breakdown by department / category.
  const byDepartmentMap = new Map<string, { name: string; total: number; approved: number; pending: number; rejected: number; amount: number }>()
  const byCategoryMap = new Map<string, { name: string; total: number; approved: number; pending: number; rejected: number; amount: number }>()
  const statusOfDocument = (docId: string): string => {
    const doc = documents.find((d) => d.id === docId)
    return doc?.status ?? 'DRAFT'
  }
  for (const doc of documents) {
    const status = statusOfDocument(doc.id)
    for (const [map, key, name] of [
      [byDepartmentMap, doc.departmentId, doc.department.name] as const,
      [byCategoryMap, doc.categoryId, doc.category.name] as const,
    ]) {
      const entry = map.get(key) ?? { name, total: 0, approved: 0, pending: 0, rejected: 0, amount: 0 }
      entry.total++
      entry.amount += Number(doc.amount)
      if (status === 'APPROVED') entry.approved++
      else if (status === 'REJECTED') entry.rejected++
      else if (status === 'IN_REVIEW' || status === 'RETURNED') entry.pending++
      map.set(key, entry)
    }
  }

  // Monthly volume (last 6 months).
  const monthly: { month: string; total: number; approved: number }[] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date()
    d.setMonth(d.getMonth() - i, 1)
    d.setHours(0, 0, 0, 0)
    const next = new Date(d)
    next.setMonth(next.getMonth() + 1)
    const inMonth = documents.filter((doc) => doc.createdAt >= d && doc.createdAt < next)
    monthly.push({
      month: d.toLocaleString('en-US', { month: 'short' }),
      total: inMonth.length,
      approved: inMonth.filter((doc) => doc.status === 'APPROVED').length,
    })
  }

  // Stage-level average dwell time (bottleneck analysis).
  const stageDwell = new Map<string, { totalMs: number; count: number }>()
  for (const instance of instances) {
    const path = parseStagePath(instance)
    for (let stepIdx = 0; stepIdx < path.length; stepIdx++) {
      const stepApprovals = instance.approvals.filter(
        (a) => a.cycle === instance.cycle && a.stepIndex === stepIdx && a.action === 'APPROVE',
      )
      if (stepApprovals.length === 0) continue
      const stepStart = stepIdx === 0 ? instance.submittedAt.getTime() : null
      const lastAt = Math.max(...stepApprovals.map((a) => a.createdAt.getTime()))
      const prevStepApprovals = instance.approvals.filter(
        (a) => a.cycle === instance.cycle && a.stepIndex === stepIdx - 1 && a.action === 'APPROVE',
      )
      const start = stepStart ?? (prevStepApprovals.length > 0 ? Math.max(...prevStepApprovals.map((a) => a.createdAt.getTime())) : null)
      if (start === null) continue
      for (const stage of path[stepIdx].stages) {
        const entry = stageDwell.get(stage.name) ?? { totalMs: 0, count: 0 }
        entry.totalMs += lastAt - start
        entry.count++
        stageDwell.set(stage.name, entry)
      }
    }
  }
  const avgTimeByStage = [...stageDwell.entries()]
    .map(([stage, v]) => ({ stage, avgHours: v.count > 0 ? v.totalMs / v.count / 3600_000 : 0 }))
    .sort((a, b) => b.avgHours - a.avgHours)

  // Recent activity (audit events the user is allowed to see).
  const recentEvents =
    hasPermission(user, 'audit.view') || user.role === 'SUPER_ADMIN'
      ? await db.auditEvent.findMany({
          orderBy: { seq: 'desc' },
          take: 12,
          include: { actor: { select: { name: true, email: true } } },
        })
      : []

  // Pending actions for THIS user.
  const myPending = inProgress.filter((instance) => {
    const step = currentStepOf(instance)
    if (!step) return false
    const decidedStageIds = new Set(
      instance.approvals
        .filter((a) => a.cycle === instance.cycle && a.stepIndex === instance.currentStep && a.action === 'APPROVE')
        .map((a) => a.stageId),
    )
    return step.stages.some(
      (s) =>
        !decidedStageIds.has(s.stageId) &&
        s.approverRole === user.role &&
        (s.departmentScope === 'ANY' ||
          (s.departmentScope === 'DOCUMENT' && instance.document.departmentId === user.departmentId) ||
          (s.departmentScope === 'FIXED' && s.departmentId === user.departmentId)),
    )
  })

  const decidedTotal = approved.length + rejected.length

  return {
    scope: hasPermission(user, 'documents.view.all') ? 'GLOBAL' : 'SCOPED',
    kpis: {
      totalRequests: documents.length,
      inReview: instances.filter((i) => i.status === 'IN_PROGRESS').length,
      approved: approved.length,
      rejected: rejected.length,
      returned: returned.length,
      suspended: suspended.length,
      drafts: documents.filter((d) => d.status === 'DRAFT').length,
      overdue: overdueInstanceIds.length,
      avgApprovalHours,
      approvalRate: decidedTotal > 0 ? approved.length / decidedTotal : null,
      rejectionRate: decidedTotal > 0 ? rejected.length / decidedTotal : null,
      myPendingActions: myPending.length,
      totalAmount: documents.reduce((sum, d) => sum + Number(d.amount), 0),
    },
    byDepartment: [...byDepartmentMap.values()].sort((a, b) => b.total - a.total),
    byCategory: [...byCategoryMap.values()].sort((a, b) => b.total - a.total),
    monthly,
    avgTimeByStage,
    recentEvents,
    myPendingDocuments: myPending.slice(0, 10).map((instance) => ({
      documentId: instance.documentId,
      reference: instance.document.reference,
      title: instance.document.title,
      amount: Number(instance.document.amount),
      currency: instance.document.currency,
      currentStage: currentStepOf(instance)?.stages.map((s) => s.name).join(' + ') ?? '—',
      stepStartedAt: instance.currentStepStartedAt.toISOString(),
    })),
  }
}

/** Overview for the Internal Audit dashboard. */
export async function computeAuditOverview() {
  const [exceptions, failedLogins24h, unauthorizedAttempts, chainCounts] = await Promise.all([
    db.controlException.findMany({ where: { resolvedAt: null }, orderBy: { detectedAt: 'desc' }, take: 500, include: { document: { select: { reference: true, title: true } }, subject: { select: { id: true, name: true, email: true } } } }),
    db.loginAttempt.count({ where: { success: false, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    db.controlException.count({ where: { type: 'UNAUTHORIZED_ACCESS', resolvedAt: null } }),
    db.auditEvent.count(),
  ])

  const byType = new Map<string, number>()
  const bySeverity = new Map<string, number>()
  for (const ex of exceptions) {
    byType.set(ex.type, (byType.get(ex.type) ?? 0) + 1)
    bySeverity.set(ex.severity, (bySeverity.get(ex.severity) ?? 0) + 1)
  }

  const failedLoginDetails = await db.loginAttempt.findMany({
    where: { success: false },
    orderBy: { createdAt: 'desc' },
    take: 30,
  })

  return {
    unresolvedExceptions: exceptions.length,
    exceptionsByType: Object.fromEntries(byType),
    exceptionsBySeverity: Object.fromEntries(bySeverity),
    failedLogins24h,
    unauthorizedAttempts,
    auditEventCount: chainCounts,
    failedLoginDetails,
    exceptions: exceptions.slice(0, 100),
  }
}
