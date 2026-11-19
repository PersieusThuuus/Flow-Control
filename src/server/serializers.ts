// ============================================================================
// FlowControl — Serializers (database rows -> API DTOs)
//
// Converts Prisma rows into plain JSON-safe objects:
//   - BigInt money values -> JS numbers (safe: capped at 999,999,999,999)
//   - Date -> ISO string
// The output shapes mirror the contract types in src/types/flowcontrol.ts,
// which the frontend consumes.
// ============================================================================

import { db } from '@/lib/db'
import type {
  Approval,
  ApprovalDelegation,
  AuditEvent,
  ControlException,
  Department,
  Document,
  DocumentCategory,
  DocumentVersion,
  Notification,
  User,
  Workflow,
  WorkflowInstance,
  WorkflowStage,
} from '@prisma/client'
import { parseStagePath, type StagePath } from './engine'

export type UserWithDept = User & { department: Department | null }

export function serializeUser(u: UserWithDept) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    jobTitle: u.jobTitle,
    departmentId: u.departmentId,
    departmentName: u.department?.name ?? null,
    departmentCode: u.department?.code ?? null,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    lockedUntil: u.lockedUntil?.toISOString() ?? null,
    failedLogins: u.failedLogins,
    createdAt: u.createdAt.toISOString(),
  }
}

export function serializeDepartment(d: Department) {
  return { id: d.id, code: d.code, name: d.name, createdAt: d.createdAt.toISOString() }
}

export function serializeCategory(c: DocumentCategory) {
  let requiredEvidence: string[] = []
  try {
    requiredEvidence = JSON.parse(c.requiredEvidence ?? '[]')
  } catch {
    requiredEvidence = []
  }
  return { id: c.id, code: c.code, name: c.name, description: c.description, requiredEvidence }
}

export type DocumentWithIncludes = Document & {
  department: Department
  category: DocumentCategory
  createdBy: { id: string; name: string; email: string }
}

export function serializeDocumentSummary(d: DocumentWithIncludes) {
  let evidenceProvided: string[] = []
  try {
    evidenceProvided = JSON.parse(d.evidenceProvided ?? '[]')
  } catch {
    evidenceProvided = []
  }
  return {
    id: d.id,
    reference: d.reference,
    title: d.title,
    description: d.description,
    categoryId: d.categoryId,
    categoryName: d.category.name,
    departmentId: d.departmentId,
    departmentName: d.department.name,
    createdById: d.createdById,
    createdByName: d.createdBy.name,
    supplierName: d.supplierName,
    currency: d.currency,
    amount: Number(d.amount),
    status: d.status,
    currentVersion: d.currentVersion,
    evidenceProvided,
    evidenceJustification: d.evidenceJustification,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }
}

export type VersionRow = DocumentVersion & { uploadedBy: { id: string; name: string } }

export function serializeVersion(v: VersionRow) {
  return {
    id: v.id,
    version: v.version,
    fileName: v.fileName,
    mimeType: v.mimeType,
    sizeBytes: v.sizeBytes,
    sha256: v.sha256,
    note: v.note,
    uploadedById: v.uploadedById,
    uploadedByName: v.uploadedBy.name,
    createdAt: v.createdAt.toISOString(),
  }
}

export type InstanceRow = WorkflowInstance & { workflow: { id: string; name: string; code: string } }

export function serializeInstance(i: InstanceRow): {
  id: string
  workflowId: string
  workflowName: string
  status: string
  cycle: number
  currentStep: number
  amount: number
  submittedAt: string
  currentStepStartedAt: string
  completedAt: string | null
  escalatedAt: string | null
  returnCount: number
  suspensionReason: string | null
  stagePath: StagePath
  totalSteps: number
} {
  const path = parseStagePath(i)
  return {
    id: i.id,
    workflowId: i.workflowId,
    workflowName: i.workflow.name,
    status: i.status,
    cycle: i.cycle,
    currentStep: i.currentStep,
    amount: Number(i.amount),
    submittedAt: i.submittedAt.toISOString(),
    currentStepStartedAt: i.currentStepStartedAt.toISOString(),
    completedAt: i.completedAt?.toISOString() ?? null,
    escalatedAt: i.escalatedAt?.toISOString() ?? null,
    returnCount: i.returnCount,
    suspensionReason: i.suspensionReason,
    stagePath: path,
    totalSteps: path.length,
  }
}

export type ApprovalRow = Approval & {
  user: { id: string; name: string; email: string }
  documentVersion?: { version: number } | null
  instance?: { document: { id: string; reference: string; title: string } } | null
}

/** Resolve display names for delegation references (delegatedFromId is a scalar snapshot). */
export async function resolveUserNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))]
  if (unique.length === 0) return new Map()
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } })
  return new Map(users.map((u) => [u.id, u.name]))
}

export function serializeApproval(a: ApprovalRow) {
  return {
    id: a.id,
    stageId: a.stageId,
    stageName: a.stageName,
    cycle: a.cycle,
    stepIndex: a.stepIndex,
    action: a.action,
    userId: a.userId,
    userName: a.user.name,
    userEmail: a.user.email,
    userRole: a.userRole,
    delegatedFromId: a.delegatedFromId,
    delegatedFromName: null,
    documentVersion: a.documentVersion?.version ?? null,
    documentHash: a.documentHash,
    comment: a.comment,
    ip: a.ip,
    createdAt: a.createdAt.toISOString(),
    documentReference: a.instance?.document.reference ?? null,
    documentTitle: a.instance?.document.title ?? null,
    documentId: a.instance?.document.id ?? null,
  }
}

export type StageRow = WorkflowStage & { department: Department | null }

export function serializeStage(s: StageRow) {
  return {
    id: s.id,
    workflowId: s.workflowId,
    sequence: s.sequence,
    name: s.name,
    description: s.description,
    approverRole: s.approverRole,
    departmentScope: s.departmentScope,
    departmentId: s.departmentId,
    departmentName: s.department?.name ?? null,
    minAmount: s.minAmount === null ? null : Number(s.minAmount),
    maxAmount: s.maxAmount === null ? null : Number(s.maxAmount),
    isRequired: s.isRequired,
    slaHours: s.slaHours,
  }
}

export type WorkflowRow = Workflow & { category: DocumentCategory; stages: StageRow[] }

export function serializeWorkflow(w: WorkflowRow) {
  return {
    id: w.id,
    code: w.code,
    name: w.name,
    description: w.description,
    categoryId: w.categoryId,
    categoryName: w.category.name,
    isActive: w.isActive,
    minAmount: w.minAmount === null ? null : Number(w.minAmount),
    maxAmount: w.maxAmount === null ? null : Number(w.maxAmount),
    stages: [...w.stages].sort((a, b) => a.sequence - b.sequence).map(serializeStage),
    updatedAt: w.updatedAt.toISOString(),
  }
}

export function serializeNotification(n: Notification) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    isRead: n.isRead,
    createdAt: n.createdAt.toISOString(),
  }
}

export type AuditRow = AuditEvent & { actor: { name: string; email: string } | null }

export function serializeAuditEvent(e: AuditRow) {
  let details: unknown = null
  try {
    details = e.details ? JSON.parse(e.details) : null
  } catch {
    details = e.details
  }
  return {
    seq: e.seq,
    occurredAt: e.occurredAt.toISOString(),
    actorId: e.actorId,
    actorName: e.actor?.name ?? null,
    actorEmail: e.actor?.email ?? null,
    actorRole: e.actorRole,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    details,
    ip: e.ip,
    prevHash: e.prevHash,
    hash: e.hash,
  }
}

export type ExceptionRow = ControlException & {
  document: { reference: string; title?: string | null } | null
  subject: { id: string; name: string; email: string } | null
}

export function serializeException(x: ExceptionRow) {
  let details: unknown = null
  try {
    details = x.details ? JSON.parse(x.details) : null
  } catch {
    details = x.details
  }
  return {
    id: x.id,
    type: x.type,
    severity: x.severity,
    message: x.message,
    documentId: x.documentId,
    documentReference: x.document?.reference ?? null,
    documentTitle: x.document?.title ?? null,
    instanceId: x.instanceId,
    userId: x.userId,
    subjectName: x.subject?.name ?? null,
    subjectEmail: x.subject?.email ?? null,
    details,
    detectedAt: x.detectedAt.toISOString(),
    resolvedAt: x.resolvedAt?.toISOString() ?? null,
    resolution: x.resolution,
  }
}

export type DelegationRow = ApprovalDelegation & {
  fromUser: { id: string; name: string; email: string; role: string }
  toUser: { id: string; name: string; email: string; role: string }
}

export function serializeDelegation(d: DelegationRow) {
  return {
    id: d.id,
    fromUserId: d.fromUserId,
    fromUserName: d.fromUser.name,
    fromUserEmail: d.fromUser.email,
    toUserId: d.toUserId,
    toUserName: d.toUser.name,
    toUserEmail: d.toUser.email,
    reason: d.reason,
    startAt: d.startAt.toISOString(),
    endAt: d.endAt.toISOString(),
    isActive: d.isActive,
    revokedAt: d.revokedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  }
}

export function serializeApprovalRule(r: { id: string; role: string; maxAmount: bigint | null; currency: string }) {
  return { id: r.id, role: r.role, maxAmount: r.maxAmount === null ? null : Number(r.maxAmount), currency: r.currency }
}

export function serializeSoDRule(r: {
  id: string
  code: string
  name: string
  ruleType: string
  roleA: string | null
  roleB: string | null
  severity: string
  description: string | null
  isActive: boolean
}) {
  return { ...r }
}
