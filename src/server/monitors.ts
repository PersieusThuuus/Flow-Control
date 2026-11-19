// ============================================================================
// FlowControl — Internal Control Monitors
//
// Detects control exceptions across the system:
//   - Overdue approval stages -> ControlException + escalation notifications
//     to administrators and the General Director.
//   - Repeated returns for correction (>= 3 per instance).
//   - Repeated rejections per creator (>= 3 rejected requests).
//
// In this deployment (no Celery/Redis), monitors run:
//   1. lazily when an administrator or auditor opens the audit dashboard, and
//   2. on demand from the administration console.
// A production deployment would schedule runControlMonitors() periodically
// (documented in docs/ARCHITECTURE.md §Asynchronous processing).
// ============================================================================

import { db } from '@/lib/db'
import { currentStepOf } from './engine'
import { recordAudit } from './audit'
import { notify, notifyRole } from './notify'
import type { SessionUser } from './rbac'

export type MonitorSummary = {
  overdueDetected: number
  repeatedReturns: number
  repeatedRejections: number
  exceptionsCreated: number
}

const OVERDUE_RECHECK_HOURS = 24

export async function runControlMonitors(actor?: SessionUser | null, ip?: string | null): Promise<MonitorSummary> {
  const summary: MonitorSummary = { overdueDetected: 0, repeatedReturns: 0, repeatedRejections: 0, exceptionsCreated: 0 }
  const now = new Date()

  // ---- 1. Overdue stages with escalation ---------------------------------
  const activeInstances = await db.workflowInstance.findMany({
    where: { status: 'IN_PROGRESS' },
    include: { document: { include: { createdBy: { select: { id: true } } } } },
  })
  for (const instance of activeInstances) {
    const step = currentStepOf(instance)
    if (!step) continue
    const slas = step.stages.filter((s) => s.isRequired && s.slaHours !== null).map((s) => s.slaHours as number)
    if (slas.length === 0) continue
    const slaHours = Math.min(...slas)
    const dueAt = new Date(instance.currentStepStartedAt.getTime() + slaHours * 3600_000)
    if (dueAt >= now) continue
    const alreadyCheckedRecently =
      instance.lastOverdueCheckAt !== null &&
      now.getTime() - instance.lastOverdueCheckAt.getTime() < OVERDUE_RECHECK_HOURS * 3600_000
    if (alreadyCheckedRecently) continue

    await db.controlException.create({
      data: {
        type: 'OVERDUE_STAGE',
        severity: 'HIGH',
        message: `${instance.document.reference} is overdue at stage "${step.stages.map((s) => s.name).join(' + ')}" (SLA ${slaHours}h exceeded).`,
        documentId: instance.documentId,
        instanceId: instance.id,
        details: JSON.stringify({
          step: instance.currentStep + 1,
          stages: step.stages.map((s) => s.name),
          slaHours,
          startedAt: instance.currentStepStartedAt.toISOString(),
          dueAt: dueAt.toISOString(),
        }),
      },
    })
    await db.workflowInstance.update({
      where: { id: instance.id },
      data: { escalatedAt: now, lastOverdueCheckAt: now },
    })
    await recordAudit(db, {
      actor: actor ? { id: actor.id, role: actor.role } : null,
      action: 'OVERDUE_DETECTED',
      entityType: 'document',
      entityId: instance.documentId,
      details: { reference: instance.document.reference, slaHours, dueAt: dueAt.toISOString() },
      ip: ip ?? null,
    })
    // Escalation: administrators and the General Director.
    await notifyRole(db, 'SUPER_ADMIN', {
      type: 'ALERT',
      title: `Overdue approval: ${instance.document.reference}`,
      body: `Stage "${step.stages.map((s) => s.name).join(' + ')}" exceeded its ${slaHours}h SLA. Escalated to management.`,
      link: `document:${instance.documentId}`,
      email: true,
    })
    await notifyRole(db, 'GENERAL_DIRECTOR', {
      type: 'ALERT',
      title: `Escalation: ${instance.document.reference} is overdue`,
      body: `The approval stage "${step.stages.map((s) => s.name).join(' + ')}" is past its deadline. Your attention is required.`,
      link: `document:${instance.documentId}`,
      email: true,
    })
    await notify(db, {
      userId: instance.document.createdBy.id,
      type: 'ALERT',
      title: `Your request ${instance.document.reference} is overdue at an approval stage`,
      body: 'The current approver has exceeded the stage deadline; the request has been escalated.',
      link: `document:${instance.documentId}`,
    })
    summary.overdueDetected++
    summary.exceptionsCreated++
  }

  // ---- 2. Repeated returns for correction ---------------------------------
  const returnedInstances = await db.workflowInstance.findMany({
    where: { returnCount: { gte: 3 } },
    include: { document: { select: { id: true, reference: true } } },
  })
  for (const instance of returnedInstances) {
    const existing = await db.controlException.findFirst({
      where: { type: 'REPEATED_RETURN', instanceId: instance.id, resolvedAt: null },
    })
    if (existing) continue
    await db.controlException.create({
      data: {
        type: 'REPEATED_RETURN',
        severity: 'MEDIUM',
        message: `${instance.document.reference} has been returned for correction ${instance.returnCount} times — review the quality of submissions or the clarity of workflow requirements.`,
        documentId: instance.documentId,
        instanceId: instance.id,
        details: JSON.stringify({ returnCount: instance.returnCount }),
      },
    })
    summary.repeatedReturns++
    summary.exceptionsCreated++
  }

  // ---- 3. Repeated rejections per creator ---------------------------------
  const rejectedInstances = await db.workflowInstance.findMany({
    where: { status: 'REJECTED' },
    include: { document: { select: { createdById: true, reference: true } } },
  })
  const rejectionsByCreator = new Map<string, { count: number; references: string[] }>()
  for (const instance of rejectedInstances) {
    const entry = rejectionsByCreator.get(instance.document.createdById) ?? { count: 0, references: [] }
    entry.count++
    if (entry.references.length < 10) entry.references.push(instance.document.reference)
    rejectionsByCreator.set(instance.document.createdById, entry)
  }
  for (const [userId, entry] of rejectionsByCreator) {
    if (entry.count < 3) continue
    const existing = await db.controlException.findFirst({
      where: { type: 'REPEATED_REJECTION', userId, resolvedAt: null },
    })
    if (existing) continue
    await db.controlException.create({
      data: {
        type: 'REPEATED_REJECTION',
        severity: 'MEDIUM',
        message: `A requestor has had ${entry.count} requests rejected (${entry.references.slice(0, 5).join(', ')}${entry.count > 5 ? '…' : ''}) — possible misunderstanding of requirements or control circumvention attempt.`,
        userId,
        details: JSON.stringify({ rejectedCount: entry.count, references: entry.references }),
      },
    })
    summary.repeatedRejections++
    summary.exceptionsCreated++
  }

  await recordAudit(db, {
    actor: actor ? { id: actor.id, role: actor.role } : null,
    action: 'CONTROL_MONITOR_RUN',
    entityType: 'system',
    details: { ...summary, triggeredBy: actor ? actor.email : 'system' },
    ip: ip ?? null,
  })

  return summary
}
