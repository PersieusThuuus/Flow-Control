// ============================================================================
// FlowControl — Workflow Engine
//
// All workflow business logic lives here (never in views/routes):
//   - Stage path resolution (amount-conditional, parallel steps by sequence)
//   - Submission, resubmission cycles, cancellation, suspension
//   - Approve / Reject / Return-for-correction / Comment with:
//       * role + department-scope eligibility (incl. delegation)
//       * segregation-of-duties enforcement (self-approval, multi-stage)
//       * per-role approval thresholds
//       * explicit confirmation requirement
//   - Optimistic concurrency: instance state advances via compare-and-swap
//     (UPDATE ... WHERE status AND currentStep match), so two users acting
//     simultaneously can never double-advance or double-approve a stage.
//
// Blocked control violations (SoD, threshold, unauthorized access) are
// COMMITTED to the database (ControlException + audit event) and only then
// surfaced as API errors — committing the evidence of the attempt matters
// more than the HTTP status code.
// ============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import type { WorkflowInstance, Document, DocumentCategory, Department } from '@prisma/client'
import { hasPermission, type RoleKey, type SessionUser } from './rbac'
import { recordAudit } from './audit'
import { notify } from './notify'

export type StageSnapshot = {
  stageId: string
  name: string
  approverRole: RoleKey
  departmentScope: 'ANY' | 'DOCUMENT' | 'FIXED'
  departmentId: string | null
  isRequired: boolean
  slaHours: number | null
}

export type StepSnapshot = {
  sequence: number
  stages: StageSnapshot[]
}

export type StagePath = StepSnapshot[]

export const DECISIVE_ACTIONS = ['APPROVE', 'REJECT', 'RETURN_FOR_CORRECTION'] as const
export type DecisiveAction = (typeof DECISIVE_ACTIONS)[number]
export type ApprovalAction = DecisiveAction | 'COMMENT'

/** Amount window filter used for both workflow and stage resolution. */
function inAmountRange(amount: bigint, min: bigint | null, max: bigint | null): boolean {
  if (min !== null && amount < min) return false
  if (max !== null && amount > max) return false
  return true
}

/**
 * Resolve the ordered list of steps for a given workflow and amount.
 * Stages sharing a `sequence` form ONE parallel step; different sequences
 * are strictly sequential. Stages may carry their own amount conditions
 * (e.g. "General Director required only above 100,000").
 */
export function resolveStagePath(
  stages: {
    id: string
    sequence: number
    name: string
    approverRole: string
    departmentScope: string
    departmentId: string | null
    minAmount: bigint | null
    maxAmount: bigint | null
    isRequired: boolean
    slaHours: number | null
  }[],
  amount: bigint,
): StagePath {
  const bySequence = new Map<number, StepSnapshot>()
  for (const s of stages) {
    if (!inAmountRange(amount, s.minAmount, s.maxAmount)) continue
    const stage: StageSnapshot = {
      stageId: s.id,
      name: s.name,
      approverRole: s.approverRole as RoleKey,
      departmentScope: (['ANY', 'DOCUMENT', 'FIXED'] as const).includes(
        s.departmentScope as 'ANY' | 'DOCUMENT' | 'FIXED',
      )
        ? (s.departmentScope as StageSnapshot['departmentScope'])
        : 'ANY',
      departmentId: s.departmentId,
      isRequired: s.isRequired,
      slaHours: s.slaHours,
    }
    const step = bySequence.get(s.sequence) ?? { sequence: s.sequence, stages: [] }
    step.stages.push(stage)
    bySequence.set(s.sequence, step)
  }
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence)
}

export function parseStagePath(instance: WorkflowInstance): StagePath {
  try {
    const parsed = JSON.parse(instance.stagePath) as StagePath
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

export function currentStepOf(instance: WorkflowInstance): StepSnapshot | null {
  const path = parseStagePath(instance)
  return path[instance.currentStep] ?? null
}

/** Users whose role/scope make them direct approvers for a snapshot stage. */
function userMatchesStage(
  user: { role: string; departmentId: string | null; isActive: boolean },
  stage: StageSnapshot,
  document: { departmentId: string },
): boolean {
  if (!user.isActive) return false
  if (user.role !== stage.approverRole) return false
  switch (stage.departmentScope) {
    case 'ANY':
      return true
    case 'DOCUMENT':
      return user.departmentId === document.departmentId
    case 'FIXED':
      return stage.departmentId !== null && user.departmentId === stage.departmentId
    default:
      return false
  }
}

export type EligibleStage = { stage: StageSnapshot; delegatedFromId: string | null; delegatorName: string | null }

/**
 * Determine which stages of the CURRENT step the user may act upon, either
 * directly or through an active delegation. Already-decided stages (this
 * cycle + step) are excluded.
 */
export async function eligibleStagesForUser(
  tx: Prisma.TransactionClient | typeof db,
  user: SessionUser,
  instance: WorkflowInstance,
  document: Document,
): Promise<EligibleStage[]> {
  const step = currentStepOf(instance)
  if (!step) return []
  const decided = await tx.approval.findMany({
    where: {
      instanceId: instance.id,
      cycle: instance.cycle,
      stepIndex: instance.currentStep,
      action: { in: [...DECISIVE_ACTIONS] },
    },
    select: { stageId: true },
  })
  const decidedIds = new Set(decided.map((d) => d.stageId))

  const result: EligibleStage[] = []
  const self = { role: user.role, departmentId: user.departmentId, isActive: true }

  // Active delegations TO the current user (delegation traceability).
  const now = new Date()
  const delegations = await tx.approvalDelegation.findMany({
    where: {
      toUserId: user.id,
      isActive: true,
      revokedAt: null,
      startAt: { lte: now },
      endAt: { gte: now },
    },
    include: { fromUser: { select: { id: true, name: true, role: true, departmentId: true, isActive: true } } },
  })

  for (const stage of step.stages) {
    if (decidedIds.has(stage.stageId)) continue
    if (userMatchesStage(self, stage, document)) {
      result.push({ stage, delegatedFromId: null, delegatorName: null })
      continue
    }
    for (const d of delegations) {
      if (userMatchesStage(d.fromUser, stage, document)) {
        result.push({ stage, delegatedFromId: d.fromUser.id, delegatorName: d.fromUser.name })
        break
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Control-violation helper: records a ControlException + audit event inside
// the current transaction so the evidence persists even though the action
// itself is refused.
// ---------------------------------------------------------------------------

async function recordViolation(
  tx: Prisma.TransactionClient,
  params: {
    type: string
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    message: string
    documentId?: string | null
    instanceId?: string | null
    userId?: string | null
    details?: Record<string, unknown>
    actor?: SessionUser | null
    ip?: string | null
    auditAction?: 'SOD_VIOLATION_BLOCKED' | 'THRESHOLD_BREACH_BLOCKED' | 'UNAUTHORIZED_ACCESS_BLOCKED'
  },
): Promise<void> {
  await tx.controlException.create({
    data: {
      type: params.type,
      severity: params.severity,
      message: params.message,
      documentId: params.documentId ?? null,
      instanceId: params.instanceId ?? null,
      userId: params.userId ?? null,
      details: params.details ? JSON.stringify(params.details) : null,
    },
  })
  await recordAudit(tx, {
    actor: params.actor ? { id: params.actor.id, role: params.actor.role } : null,
    action: params.auditAction ?? 'UNAUTHORIZED_ACCESS_BLOCKED',
    entityType: 'document',
    entityId: params.documentId ?? undefined,
    details: { type: params.type, message: params.message, ...params.details },
    ip: params.ip ?? null,
  })
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export type SubmitResult =
  | { ok: true; instanceId: string; startedSteps: number }
  | { ok: false; status: number; code: string; message: string }

export async function submitDocument(params: {
  user: SessionUser
  documentId: string
  ip?: string | null
  /** Optional explicit timestamp (demo-data seeding; hash-bound in audit). */
  at?: Date
}): Promise<SubmitResult> {
  const fail = (status: number, code: string, message: string): SubmitResult => ({ ok: false, status, code, message })

  return db.$transaction(async (tx) => {
    const now = params.at ?? new Date()
    const document = await tx.document.findUnique({
      where: { id: params.documentId },
      include: { category: true, createdBy: { select: { id: true, name: true } } },
    })
    if (!document) return fail(404, 'NOT_FOUND', 'Document not found.')
    if (document.createdById !== params.user.id && params.user.role !== 'SUPER_ADMIN') {
      return fail(403, 'FORBIDDEN', 'Only the creator (or an administrator) may submit this document.')
    }
    if (document.status !== 'DRAFT' && document.status !== 'RETURNED') {
      return fail(409, 'INVALID_STATE', `Document cannot be submitted from status ${document.status}.`)
    }

    // --- Mandatory supporting evidence control -----------------------------
    const requiredEvidence: string[] = (() => {
      try {
        return JSON.parse(document.category.requiredEvidence ?? '[]')
      } catch {
        return []
      }
    })()
    const providedEvidence: string[] = (() => {
      try {
        return JSON.parse(document.evidenceProvided ?? '[]')
      } catch {
        return []
      }
    })()
    const missing = requiredEvidence.filter((r) => !providedEvidence.includes(r))
    if (missing.length > 0 && !document.evidenceJustification) {
      return fail(422, 'EVIDENCE_MISSING', `Mandatory evidence missing: ${missing.join(', ')}. Attach the evidence or provide a written justification.`)
    }
    if (missing.length > 0 && document.evidenceJustification) {
      // Justified exception — recorded, not silently ignored.
      await tx.controlException.create({
        data: {
          type: 'MISSING_EVIDENCE',
          severity: 'MEDIUM',
          message: `Submission without mandatory evidence (${missing.join(', ')}) — justification recorded.`,
          documentId: document.id,
          details: JSON.stringify({ missing, justification: document.evidenceJustification }),
        },
      })
      await recordAudit(tx, {
        at: now,
        actor: { id: params.user.id, role: params.user.role },
        action: 'EVIDENCE_EXCEPTION_RECORDED',
        entityType: 'document',
        entityId: document.id,
        details: { missing, justification: document.evidenceJustification },
        ip: params.ip ?? null,
      })
    }

    // --- Workflow resolution -----------------------------------------------
    const workflows = await tx.workflow.findMany({
      where: { categoryId: document.categoryId, isActive: true },
      include: { stages: true },
    })
    const matching = workflows.filter((w) => inAmountRange(document.amount, w.minAmount, w.maxAmount))
    if (matching.length === 0) {
      return fail(422, 'NO_WORKFLOW', 'No active workflow is configured for this document category and amount. Contact an administrator.')
    }
    // Deterministic choice when several workflows overlap: the most recently
    // updated one wins (documented assumption — administrators should avoid
    // overlapping configurations).
    const workflow = matching.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
    const path = resolveStagePath(workflow.stages, document.amount)
    if (path.length === 0) {
      return fail(422, 'NO_STAGES', 'The matched workflow defines no approval stages for this amount. Contact an administrator.')
    }

    let instance: WorkflowInstance
    if (document.status === 'RETURNED') {
      // Resubmission after "return for correction": the same instance moves to
      // a new review cycle, restarting from step 1. Full history is preserved.
      const previous = await tx.workflowInstance.findFirst({
        where: { documentId: document.id, status: 'RETURNED_FOR_CORRECTION' },
        orderBy: { createdAt: 'desc' },
      })
      if (!previous) return fail(409, 'INVALID_STATE', 'Document is marked returned but no return instance exists.')
      instance = await tx.workflowInstance.update({
        where: { id: previous.id },
        data: {
          status: 'IN_PROGRESS',
          cycle: { increment: 1 },
          stagePath: JSON.stringify(path),
          currentStep: 0,
          currentStepStartedAt: now,
          submittedAt: now,
          escalatedAt: null,
          lastOverdueCheckAt: null,
          amount: document.amount,
        },
      })
    } else {
      instance = await tx.workflowInstance.create({
        data: {
          documentId: document.id,
          workflowId: workflow.id,
          status: 'IN_PROGRESS',
          stagePath: JSON.stringify(path),
          cycle: 1,
          currentStep: 0,
          amount: document.amount,
          submittedAt: now,
          currentStepStartedAt: now,
        },
      })
    }

    await tx.document.update({ where: { id: document.id }, data: { status: 'IN_REVIEW' } })

    const isResubmission = document.status === 'RETURNED'
    await recordAudit(tx, {
      at: now,
      actor: { id: params.user.id, role: params.user.role },
      action: isResubmission ? 'REQUEST_RESUBMITTED' : 'REQUEST_SUBMITTED',
      entityType: 'document',
      entityId: document.id,
      details: {
        reference: document.reference,
        title: document.title,
        amount: document.amount.toString(),
        currency: document.currency,
        workflow: workflow.name,
        cycle: instance.cycle,
        steps: path.map((s) => s.stages.map((st) => st.name).join(' + ')),
      },
      ip: params.ip ?? null,
    })

    await notifyStepApprovers(tx, instance, document, path[0])
    await notify(tx, {
      userId: document.createdById,
      type: 'INFO',
      title: isResubmission
        ? `${document.reference} resubmitted for approval (cycle ${instance.cycle})`
        : `${document.reference} submitted for approval`,
      body: `Workflow "${workflow.name}" — ${path.length} step(s).`,
      link: `document:${document.id}`,
    })

    return { ok: true, instanceId: instance.id, startedSteps: path.length }
  })
}

/** Notify all users eligible to act on the given step. */
async function notifyStepApprovers(
  tx: Prisma.TransactionClient,
  instance: WorkflowInstance,
  document: Document,
  step: StepSnapshot,
): Promise<void> {
  const notified = new Set<string>()
  for (const stage of step.stages) {
    const where: Prisma.UserWhereInput = { role: stage.approverRole, isActive: true }
    if (stage.departmentScope === 'DOCUMENT') where.departmentId = document.departmentId
    if (stage.departmentScope === 'FIXED' && stage.departmentId) where.departmentId = stage.departmentId
    const users = await tx.user.findMany({ where, select: { id: true } })
    for (const u of users) {
      if (notified.has(u.id)) continue
      notified.add(u.id)
      await notify(tx, {
        userId: u.id,
        type: 'ACTION_REQUIRED',
        title: `Approval required: ${document.reference} — ${stage.name}`,
        body: `"${document.title}" (${document.currency} ${document.amount.toString()}) is waiting for your decision.`,
        link: `document:${document.id}`,
        email: true,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Acting on an instance (approve / reject / return / comment)
// ---------------------------------------------------------------------------

export type ActOutcome =
  | { ok: true; message: string; instanceStatus: string; documentStatus: string }
  | { ok: false; status: number; code: string; message: string }

export async function actOnInstance(params: {
  user: SessionUser
  instanceId: string
  action: ApprovalAction
  comment?: string | null
  confirm: boolean
  stageId?: string | null
  ip?: string | null
  /** Optional explicit timestamp (demo-data seeding; hash-bound in audit). */
  at?: Date
  /**
   * Optional optimistic-concurrency hint: the step the client believed was
   * current. When the instance has since moved, the caller receives a clean
   * 409 instead of an eligibility 403 (and no false control exception).
   */
  expectedStep?: number | null
}): Promise<ActOutcome> {
  if (!params.confirm) {
    return { ok: false, status: 400, code: 'CONFIRMATION_REQUIRED', message: 'Explicit confirmation is required for approval actions.' }
  }

  return db.$transaction(async (tx): Promise<ActOutcome> => {
    const instance = await tx.workflowInstance.findUnique({
      where: { id: params.instanceId },
      include: { document: { include: { category: true } } },
    })
    if (!instance) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Approval task not found.' }
    const document = instance.document
    const actor = { id: params.user.id, role: params.user.role }
    const now = params.at ?? new Date()

    if (instance.status === 'SUSPENDED') {
      return { ok: false, status: 409, code: 'SUSPENDED', message: 'This workflow is suspended by an administrator; no actions are possible.' }
    }
    if (instance.status !== 'IN_PROGRESS') {
      return { ok: false, status: 409, code: 'INVALID_STATE', message: `This request is no longer awaiting action (status: ${instance.status}).` }
    }

    // ---- Optimistic concurrency hint ---------------------------------------
    if (params.expectedStep !== undefined && params.expectedStep !== null && params.expectedStep !== instance.currentStep) {
      return {
        ok: false,
        status: 409,
        code: 'CONCURRENT_MODIFICATION',
        message: 'This request has just moved to another stage (another approver acted first). Please refresh and review the new state.',
      }
    }

    // ---- COMMENT: no state change, full audit trail ------------------------
    if (params.action === 'COMMENT') {
      const eligible = await eligibleStagesForUser(tx, params.user, instance, document)
      const mayComment =
        eligible.length > 0 ||
        document.createdById === params.user.id ||
        params.user.role === 'SUPER_ADMIN'
      if (!mayComment) {
        await recordViolation(tx, {
          type: 'UNAUTHORIZED_ACCESS',
          severity: 'MEDIUM',
          message: `User ${params.user.email} attempted to comment on ${document.reference} without being a participant.`,
          documentId: document.id,
          instanceId: instance.id,
          userId: params.user.id,
          actor: params.user,
          ip: params.ip,
          auditAction: 'UNAUTHORIZED_ACCESS_BLOCKED',
        })
        return { ok: false, status: 403, code: 'FORBIDDEN', message: 'You are not a participant of this request.' }
      }
      if (!params.comment || params.comment.trim().length === 0) {
        return { ok: false, status: 422, code: 'COMMENT_REQUIRED', message: 'A comment text is required.' }
      }
      const version = await tx.documentVersion.findFirst({
        where: { documentId: document.id, version: document.currentVersion },
      })
      if (!version) return { ok: false, status: 500, code: 'NO_VERSION', message: 'Document version not found.' }
      await tx.approval.create({
        data: {
          instanceId: instance.id,
          stageId: 'COMMENT',
          stageName: 'Comment',
          cycle: instance.cycle,
          stepIndex: instance.currentStep,
          action: 'COMMENT',
          userId: params.user.id,
          userRole: params.user.role,
          userDepartmentId: params.user.departmentId,
          documentVersionId: version.id,
          documentHash: version.sha256,
          comment: params.comment.trim(),
          ip: params.ip ?? null,
          createdAt: now,
        },
      })
      await recordAudit(tx, {
        at: now,
        actor,
        action: 'COMMENT_ADDED',
        entityType: 'document',
        entityId: document.id,
        details: { reference: document.reference, comment: params.comment.trim().slice(0, 500) },
        ip: params.ip ?? null,
      })
      return { ok: true, message: 'Comment added.', instanceStatus: instance.status, documentStatus: document.status }
    }

    // ---- Eligibility --------------------------------------------------------
    const eligible = await eligibleStagesForUser(tx, params.user, instance, document)
    const target = params.stageId ? eligible.find((e) => e.stage.stageId === params.stageId) : eligible[0]
    if (!target) {
      await recordViolation(tx, {
        type: 'UNAUTHORIZED_ACCESS',
        severity: 'MEDIUM',
        message: `User ${params.user.email} attempted to act on ${document.reference} without authorization for the current stage.`,
        documentId: document.id,
        instanceId: instance.id,
        userId: params.user.id,
        actor: params.user,
        ip: params.ip,
        auditAction: 'UNAUTHORIZED_ACCESS_BLOCKED',
      })
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'You are not authorized to act on the current stage of this request.' }
    }
    const stage = target.stage
    const delegatedFromId = target.delegatedFromId

    // ---- Segregation of duties: self-approval -------------------------------
    const selfApprovalRule = await tx.soDRule.findFirst({ where: { ruleType: 'SELF_APPROVAL', isActive: true } })
    if (selfApprovalRule && params.user.id === document.createdById) {
      await recordViolation(tx, {
        type: 'SOD_SELF_APPROVAL',
        severity: 'CRITICAL',
        message: `Self-approval attempt blocked: ${params.user.email} created ${document.reference} and attempted to approve it.`,
        documentId: document.id,
        instanceId: instance.id,
        userId: params.user.id,
        details: { stage: stage.name, action: params.action },
        actor: params.user,
        ip: params.ip,
        auditAction: 'SOD_VIOLATION_BLOCKED',
      })
      return {
        ok: false,
        status: 403,
        code: 'SOD_SELF_APPROVAL',
        message: 'Segregation of duties: you cannot approve a request you created. The attempt has been recorded.',
      }
    }

    // ---- Segregation of duties: same user across multiple stages ------------
    const multiStageRule = await tx.soDRule.findFirst({ where: { ruleType: 'MULTI_STAGE_SAME_USER', isActive: true } })
    if (multiStageRule) {
      const priorApprovals = await tx.approval.findMany({
        where: { instanceId: instance.id, userId: params.user.id, action: 'APPROVE' },
      })
      const conflicting = priorApprovals.some(
        (a) => a.cycle < instance.cycle || a.stepIndex < instance.currentStep,
      )
      if (conflicting) {
        await recordViolation(tx, {
          type: 'SOD_MULTI_STAGE',
          severity: 'HIGH',
          message: `Multi-stage approval conflict blocked: ${params.user.email} already approved an earlier stage of ${document.reference}.`,
          documentId: document.id,
          instanceId: instance.id,
          userId: params.user.id,
          details: { attemptedStage: stage.name },
          actor: params.user,
          ip: params.ip,
          auditAction: 'SOD_VIOLATION_BLOCKED',
        })
        return {
          ok: false,
          status: 403,
          code: 'SOD_MULTI_STAGE',
          message: 'Segregation of duties: you already approved an earlier stage of this request. The attempt has been recorded.',
        }
      }
    }

    // ---- Approval threshold per role ----------------------------------------
    // Semantics (documented in docs/ARCHITECTURE.md): a per-role approval
    // limit binds when the user's stage is the FINAL financial authorization
    // point of the resolved chain — i.e. their approval completes the
    // authorization for this amount. Upstream stages (e.g. the department
    // manager's operational review) are not amount-bound, because higher
    // authority downstream (controller / director) carries the financial
    // responsibility. Rejecting or returning is never limit-bound.
    const rule = await tx.approvalRule.findUnique({ where: { role: params.user.role } })
    // No configured rule row => least privilege (cannot approve).
    // A configured rule with maxAmount = null => unlimited authority.
    const maxAmount: bigint | null = rule ? rule.maxAmount : 0n
    const fullPath = parseStagePath(instance)
    const lastStep = fullPath[fullPath.length - 1]
    const isFinalAuthorizer = lastStep ? lastStep.stages.some((s) => s.stageId === stage.stageId) : false
    if (params.action === 'APPROVE' && isFinalAuthorizer && maxAmount !== null && instance.amount > maxAmount) {
      await recordViolation(tx, {
        type: 'THRESHOLD_BREACH',
        severity: 'HIGH',
        message: `Approval threshold exceeded: ${params.user.email} (role ${params.user.role}, limit ${maxAmount.toString()}) attempted to grant the final authorization of ${document.reference} worth ${instance.amount.toString()}.`,
        documentId: document.id,
        instanceId: instance.id,
        userId: params.user.id,
        details: { role: params.user.role, limit: maxAmount.toString(), amount: instance.amount.toString() },
        actor: params.user,
        ip: params.ip,
        auditAction: 'THRESHOLD_BREACH_BLOCKED',
      })
      return {
        ok: false,
        status: 403,
        code: 'THRESHOLD_EXCEEDED',
        message: `Your approval limit (${maxAmount.toString()}) is below the amount of this request (${instance.amount.toString()}) — your stage is the final authorization point. The attempt has been recorded.`,
      }
    }

    // ---- Persist the decision (bound to the exact document version) ---------
    const version = await tx.documentVersion.findFirst({
      where: { documentId: document.id, version: document.currentVersion },
    })
    if (!version) return { ok: false, status: 500, code: 'NO_VERSION', message: 'Document version not found.' }

    await tx.approval.create({
      data: {
        instanceId: instance.id,
        stageId: stage.stageId,
        stageName: stage.name,
        cycle: instance.cycle,
        stepIndex: instance.currentStep,
        action: params.action,
        userId: params.user.id,
        userRole: params.user.role,
        userDepartmentId: params.user.departmentId,
        delegatedFromId,
        documentVersionId: version.id,
        documentHash: version.sha256,
        comment: params.comment?.trim() ? params.comment.trim() : null,
        ip: params.ip ?? null,
        createdAt: now,
      },
    })

    const auditBase = {
      at: now,
      actor,
      entityType: 'document',
      entityId: document.id,
      ip: params.ip ?? null,
    }

    // ---- REJECT: terminal ----------------------------------------------------
    if (params.action === 'REJECT') {
      const updated = await tx.workflowInstance.update({
        where: { id: instance.id },
        data: { status: 'REJECTED', completedAt: now },
      })
      await tx.document.update({ where: { id: document.id }, data: { status: 'REJECTED' } })
      await recordAudit(tx, {
        ...auditBase,
        action: 'APPROVAL_REJECTED',
        details: {
          reference: document.reference,
          stage: stage.name,
          rejectedBy: params.user.email,
          onBehalfOf: delegatedFromId ?? undefined,
          comment: params.comment ?? null,
          documentHash: version.sha256,
          documentVersion: version.version,
        },
      })
      await notify(tx, {
        userId: document.createdById,
        type: 'ALERT',
        title: `${document.reference} rejected at stage "${stage.name}"`,
        body: params.comment?.trim() ? `Reason: ${params.comment.trim()}` : 'No comment provided.',
        link: `document:${document.id}`,
        email: true,
      })
      return { ok: true, message: 'Request rejected.', instanceStatus: updated.status, documentStatus: 'REJECTED' }
    }

    // ---- RETURN FOR CORRECTION: back to the submitter -----------------------
    if (params.action === 'RETURN_FOR_CORRECTION') {
      const returnCount = instance.returnCount + 1
      const updated = await tx.workflowInstance.update({
        where: { id: instance.id },
        data: { status: 'RETURNED_FOR_CORRECTION', returnCount },
      })
      await tx.document.update({ where: { id: document.id }, data: { status: 'RETURNED' } })
      await recordAudit(tx, {
        ...auditBase,
        action: 'RETURN_FOR_CORRECTION',
        details: {
          reference: document.reference,
          stage: stage.name,
          returnedBy: params.user.email,
          comment: params.comment ?? null,
          returnCount,
          documentHash: version.sha256,
          documentVersion: version.version,
        },
      })
      await notify(tx, {
        userId: document.createdById,
        type: 'ACTION_REQUIRED',
        title: `${document.reference} returned for correction (attempt ${returnCount})`,
        body: params.comment?.trim()
          ? `Stage "${stage.name}" requests corrections: ${params.comment.trim()}`
          : `Stage "${stage.name}" requests corrections.`,
        link: `document:${document.id}`,
        email: true,
      })
      if (returnCount >= 3) {
        await tx.controlException.create({
          data: {
            type: 'REPEATED_RETURN',
            severity: 'MEDIUM',
            message: `${document.reference} has been returned for correction ${returnCount} times.`,
            documentId: document.id,
            instanceId: instance.id,
            details: JSON.stringify({ returnCount }),
          },
        })
      }
      return { ok: true, message: 'Request returned for correction.', instanceStatus: updated.status, documentStatus: 'RETURNED' }
    }

    // ---- APPROVE: evaluate step completion -----------------------------------
    const path = parseStagePath(instance)
    const step = path[instance.currentStep]
    if (!step) return { ok: false, status: 500, code: 'NO_STEP', message: 'Workflow step not found.' }

    const stepApprovals = await tx.approval.findMany({
      where: { instanceId: instance.id, cycle: instance.cycle, stepIndex: instance.currentStep, action: 'APPROVE' },
    })
    const approvedStageIds = new Set(stepApprovals.map((a) => a.stageId))
    const requiredStages = step.stages.filter((s) => s.isRequired)
    const stepComplete = requiredStages.every((s) => approvedStageIds.has(s.stageId))

    await recordAudit(tx, {
      ...auditBase,
      action: 'APPROVAL_GRANTED',
      details: {
        reference: document.reference,
        stage: stage.name,
        approvedBy: params.user.email,
        onBehalfOf: delegatedFromId ?? undefined,
        comment: params.comment ?? null,
        documentHash: version.sha256,
        documentVersion: version.version,
      },
    })

    if (!stepComplete) {
      // Parallel step: waiting for the other approvers.
      return {
        ok: true,
        message: `Approved at stage "${stage.name}". Waiting for other approvers of this step.`,
        instanceStatus: instance.status,
        documentStatus: document.status,
      }
    }

    // Step complete — is this the final step?
    const isLastStep = instance.currentStep >= path.length - 1
    if (isLastStep) {
      await tx.workflowInstance.update({
        where: { id: instance.id },
        data: { status: 'APPROVED', completedAt: now },
      })
      await tx.document.update({ where: { id: document.id }, data: { status: 'APPROVED' } })
      await recordAudit(tx, {
        ...auditBase,
        action: 'REQUEST_APPROVED',
        details: {
          reference: document.reference,
          workflowCompleted: true,
          cycles: instance.cycle,
          documentHash: version.sha256,
          documentVersion: version.version,
        },
      })
      await notify(tx, {
        userId: document.createdById,
        type: 'INFO',
        title: `${document.reference} fully approved`,
        body: 'The request completed all approval stages.',
        link: `document:${document.id}`,
        email: true,
      })
      return { ok: true, message: 'Request fully approved.', instanceStatus: 'APPROVED', documentStatus: 'APPROVED' }
    }

    // Advance to the next step via compare-and-swap: the update only applies
    // when the instance is still exactly where we saw it. A concurrent actor
    // who advanced it first causes count=0 and this transaction aborts with 409.
    const advanced = await tx.workflowInstance.updateMany({
      where: { id: instance.id, status: 'IN_PROGRESS', currentStep: instance.currentStep },
      data: { currentStep: instance.currentStep + 1, currentStepStartedAt: now, escalatedAt: null, lastOverdueCheckAt: null },
    })
    if (advanced.count !== 1) {
      throw new Prisma.PrismaClientKnownRequestError('Concurrent modification of workflow instance', {
        code: 'P2004',
        clientVersion: '6',
      })
    }

    // Fast-track (rubber-stamping) detection: flag when the current approval
    // follows the immediately preceding decision on this instance by less
    // than a minute. (The current approval is excluded from the comparison.)
    const currentApproval = await tx.approval.findFirst({
      where: { instanceId: instance.id, userId: params.user.id, action: 'APPROVE', stageId: stage.stageId, cycle: instance.cycle, stepIndex: instance.currentStep },
      orderBy: { createdAt: 'desc' },
    })
    const previousApproval = currentApproval
      ? await tx.approval.findFirst({
          where: { instanceId: instance.id, id: { not: currentApproval.id } },
          orderBy: { createdAt: 'desc' },
        })
      : null
    if (currentApproval && previousApproval) {
      const gapMs = currentApproval.createdAt.getTime() - previousApproval.createdAt.getTime()
      if (gapMs < 60_000) {
        await tx.controlException.create({
          data: {
            type: 'FAST_TRACK_SEQUENCE',
            severity: 'LOW',
            message: `Unusually fast approval sequence on ${document.reference} (stage "${stage.name}" approved ${Math.max(1, Math.round(gapMs / 1000))}s after the previous decision).`,
            documentId: document.id,
            instanceId: instance.id,
            details: JSON.stringify({ gapMs, stage: stage.name }),
          },
        })
      }
    }

    const nextStep = path[instance.currentStep + 1]
    const refreshed = await tx.workflowInstance.findUnique({ where: { id: instance.id } })
    await notifyStepApprovers(tx, refreshed ?? instance, document, nextStep)

    return {
      ok: true,
      message: `Approved at stage "${stage.name}". Advanced to "${nextStep.stages.map((s) => s.name).join(' + ')}".`,
      instanceStatus: 'IN_PROGRESS',
      documentStatus: 'IN_REVIEW',
    }
  }).catch((err): ActOutcome => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2004') {
      return {
        ok: false,
        status: 409,
        code: 'CONCURRENT_MODIFICATION',
        message: 'This request was just modified by another user. Please refresh and try again.',
      }
    }
    throw err
  })
}

// ---------------------------------------------------------------------------
// Cancellation & suspension
// ---------------------------------------------------------------------------

export async function cancelDocument(params: {
  user: SessionUser
  documentId: string
  reason: string
  ip?: string | null
}): Promise<ActOutcome> {
  return db.$transaction(async (tx): Promise<ActOutcome> => {
    const document = await tx.document.findUnique({
      where: { id: params.documentId },
      include: { instances: true },
    })
    if (!document) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Document not found.' }
    const isAdmin = params.user.role === 'SUPER_ADMIN'
    if (document.createdById !== params.user.id && !isAdmin) {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Only the creator or an administrator may cancel this request.' }
    }
    if (['APPROVED', 'REJECTED', 'CANCELLED'].includes(document.status)) {
      return { ok: false, status: 409, code: 'INVALID_STATE', message: `Cannot cancel a request in status ${document.status}.` }
    }
    const decisive = await tx.approval.count({
      where: { instanceId: { in: document.instances.map((i) => i.id) }, action: { in: [...DECISIVE_ACTIONS] } },
    })
    if (decisive > 0 && !isAdmin) {
      return {
        ok: false,
        status: 409,
        code: 'APPROVALS_EXIST',
        message: 'The request has already received approvals and can now only be cancelled by an administrator.',
      }
    }
    const now = new Date()
    await tx.workflowInstance.updateMany({
      where: { documentId: document.id, status: { in: ['IN_PROGRESS', 'SUSPENDED', 'RETURNED_FOR_CORRECTION'] } },
      data: { status: 'CANCELLED', completedAt: now },
    })
    await tx.document.update({ where: { id: document.id }, data: { status: 'CANCELLED' } })
    await recordAudit(tx, {
      actor: { id: params.user.id, role: params.user.role },
      action: 'REQUEST_CANCELLED',
      entityType: 'document',
      entityId: document.id,
      details: { reference: document.reference, reason: params.reason, byAdmin: isAdmin },
      ip: params.ip ?? null,
    })
    await notify(tx, {
      userId: document.createdById,
      type: 'INFO',
      title: `${document.reference} cancelled`,
      body: `Reason: ${params.reason}`,
      link: `document:${document.id}`,
    })
    return { ok: true, message: 'Request cancelled.', instanceStatus: 'CANCELLED', documentStatus: 'CANCELLED' }
  })
}

export async function setInstanceSuspension(params: {
  admin: SessionUser
  instanceId: string
  suspend: boolean
  reason: string
  ip?: string | null
}): Promise<ActOutcome> {
  if (params.admin.role !== 'SUPER_ADMIN') {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Only administrators may suspend or resume workflows.' }
  }
  return db.$transaction(async (tx): Promise<ActOutcome> => {
    const instance = await tx.workflowInstance.findUnique({ where: { id: params.instanceId }, include: { document: true } })
    if (!instance) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Instance not found.' }
    if (params.suspend && instance.status !== 'IN_PROGRESS') {
      return { ok: false, status: 409, code: 'INVALID_STATE', message: 'Only in-progress workflows can be suspended.' }
    }
    if (!params.suspend && instance.status !== 'SUSPENDED') {
      return { ok: false, status: 409, code: 'INVALID_STATE', message: 'This workflow is not suspended.' }
    }
    const now = new Date()
    await tx.workflowInstance.update({
      where: { id: instance.id },
      data: params.suspend
        ? { status: 'SUSPENDED', suspendedById: params.admin.id, suspensionReason: params.reason }
        : { status: 'IN_PROGRESS', suspendedById: null, suspensionReason: null, currentStepStartedAt: now },
    })
    await recordAudit(tx, {
      actor: { id: params.admin.id, role: params.admin.role },
      action: params.suspend ? 'WORKFLOW_SUSPENDED' : 'WORKFLOW_RESUMED',
      entityType: 'document',
      entityId: instance.documentId,
      details: { reference: instance.document.reference, reason: params.reason },
      ip: params.ip ?? null,
    })
    return {
      ok: true,
      message: params.suspend ? 'Workflow suspended.' : 'Workflow resumed (stage deadline restarted).',
      instanceStatus: params.suspend ? 'SUSPENDED' : 'IN_PROGRESS',
      documentStatus: instance.document.status,
    }
  })
}

// ---------------------------------------------------------------------------
// Inbox & visibility
// ---------------------------------------------------------------------------

export type InboxItem = {
  instance: WorkflowInstance
  document: Document & { category: DocumentCategory; department: Department }
  eligibleStages: EligibleStage[]
  dueAt: Date | null
}

/** Instances currently awaiting THIS user's action (directly or via delegation). */
export async function getInbox(user: SessionUser): Promise<InboxItem[]> {
  const instances = await db.workflowInstance.findMany({
    where: { status: 'IN_PROGRESS' },
    include: {
      document: { include: { category: true, department: true } },
    },
    orderBy: { currentStepStartedAt: 'asc' },
    take: 500,
  })
  const items: InboxItem[] = []
  for (const instance of instances) {
    const eligible = await eligibleStagesForUser(db, user, instance, instance.document)
    if (eligible.length === 0) continue
    const step = currentStepOf(instance)
    const slas = (step?.stages ?? []).filter((s) => s.slaHours !== null).map((s) => s.slaHours as number)
    const slaHours = slas.length > 0 ? Math.min(...slas) : null
    items.push({
      instance,
      document: instance.document,
      eligibleStages: eligible,
      dueAt: slaHours !== null ? new Date(instance.currentStepStartedAt.getTime() + slaHours * 3600_000) : null,
    })
  }
  return items
}

/**
 * Object-level authorization (anti-IDOR): can this user see the document?
 * Visibility: creators always; admin/auditor (view.all); department members
 * when the role grants view.department; and any user who is or was a
 * participant (approver, delegated approver) of one of its workflow instances.
 */
export async function canViewDocument(user: SessionUser, documentId: string): Promise<boolean> {
  const document = await db.document.findUnique({ where: { id: documentId }, select: { createdById: true, departmentId: true } })
  if (!document) return false
  if (hasPermission(user, 'documents.view.all')) return true
  if (document.createdById === user.id) return true
  if (hasPermission(user, 'documents.view.department') && document.departmentId === user.departmentId) return true
  if (hasPermission(user, 'documents.view.routed')) {
    const participated = await db.approval.findFirst({
      where: { instance: { documentId }, userId: user.id },
      select: { id: true },
    })
    if (participated) return true
    const instances = await db.workflowInstance.findMany({ where: { documentId }, include: { document: true } })
    for (const instance of instances) {
      const eligible = await eligibleStagesForUser(db, user, instance, instance.document)
      if (eligible.length > 0) return true
    }
  }
  return false
}
