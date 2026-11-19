// ============================================================================
// FlowControl — Frontend/Backend Contract Types
//
// These types mirror the API responses produced by src/server/serializers.ts.
// They are the single source of truth shared by every view component.
// ============================================================================

export type RoleKey =
  | 'SUPER_ADMIN'
  | 'PURCHASING'
  | 'DEPT_MANAGER'
  | 'FIN_CONTROLLER'
  | 'ACCOUNTANT'
  | 'TREASURY'
  | 'GENERAL_DIRECTOR'
  | 'INTERNAL_AUDITOR'

export type DocumentStatus =
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'RETURNED'
  | 'CANCELLED'

export type InstanceStatus =
  | 'IN_PROGRESS'
  | 'APPROVED'
  | 'REJECTED'
  | 'RETURNED_FOR_CORRECTION'
  | 'CANCELLED'
  | 'SUSPENDED'

export type ApprovalAction = 'APPROVE' | 'REJECT' | 'RETURN_FOR_CORRECTION' | 'COMMENT'

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

// ---------------------------------------------------------------- users/meta

export type SessionUserDTO = {
  id: string
  email: string
  name: string
  role: RoleKey
  jobTitle: string | null
  departmentId: string | null
  departmentName: string | null
  departmentCode: string | null
}

export type UserDTO = SessionUserDTO & {
  isActive: boolean
  lastLoginAt: string | null
  lockedUntil: string | null
  failedLogins: number
  createdAt: string
}

export type DepartmentDTO = {
  id: string
  code: string
  name: string
  createdAt: string
  userCount?: number
}

export type CategoryDTO = {
  id: string
  code: string
  name: string
  description: string | null
  requiredEvidence: string[]
}

export type RoleInfo = { key: RoleKey; label: string; approver: boolean }

export type MetaDTO = {
  categories: CategoryDTO[]
  departments: DepartmentDTO[]
  roles: RoleInfo[]
  workflows: {
    id: string
    code: string
    name: string
    categoryId: string
    categoryName: string
    minAmount: number | null
    maxAmount: number | null
    stageCount: number
  }[]
}

// ---------------------------------------------------------------- documents

export type DocumentSummaryDTO = {
  id: string
  reference: string
  title: string
  description: string | null
  categoryId: string
  categoryName: string
  departmentId: string
  departmentName: string
  createdById: string
  createdByName: string
  supplierName: string | null
  currency: string
  amount: number
  status: DocumentStatus
  currentVersion: number
  evidenceProvided: string[]
  evidenceJustification: string | null
  createdAt: string
  updatedAt: string
}

export type DocumentVersionDTO = {
  id: string
  version: number
  fileName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  note: string | null
  uploadedById: string
  uploadedByName: string
  createdAt: string
}

export type StageSnapshotDTO = {
  stageId: string
  name: string
  approverRole: RoleKey
  departmentScope: 'ANY' | 'DOCUMENT' | 'FIXED'
  departmentId: string | null
  isRequired: boolean
  slaHours: number | null
}

export type StepSnapshotDTO = {
  sequence: number
  stages: StageSnapshotDTO[]
}

export type InstanceDTO = {
  id: string
  workflowId: string
  workflowName: string
  status: InstanceStatus
  cycle: number
  currentStep: number
  amount: number
  submittedAt: string
  currentStepStartedAt: string
  completedAt: string | null
  escalatedAt: string | null
  returnCount: number
  suspensionReason: string | null
  stagePath: StepSnapshotDTO[]
  totalSteps: number
}

export type ApprovalDTO = {
  id: string
  stageId: string
  stageName: string
  cycle: number
  stepIndex: number
  action: ApprovalAction
  userId: string
  userName: string
  userEmail: string
  userRole: string
  delegatedFromId: string | null
  delegatedFromName: string | null
  documentVersion: number | null
  documentHash: string
  comment: string | null
  ip: string | null
  createdAt: string
  documentReference?: string | null
  documentTitle?: string | null
  documentId?: string | null
}

export type ExceptionDTO = {
  id: string
  type: string
  severity: Severity
  message: string
  documentId: string | null
  documentReference: string | null
  documentTitle: string | null
  instanceId: string | null
  userId: string | null
  subjectName: string | null
  subjectEmail: string | null
  details: unknown
  detectedAt: string
  resolvedAt: string | null
  resolution: string | null
}

export type DocumentDetailDTO = {
  document: DocumentSummaryDTO
  versions: DocumentVersionDTO[]
  instances: InstanceDTO[]
  approvals: ApprovalDTO[]
  exceptions: ExceptionDTO[]
  activeInstanceId: string | null
  permissions: {
    canView: boolean
    canManage: boolean
    canSubmit: boolean
    canUploadVersion: boolean
    canCancel: boolean
    canSuspend: boolean
    isAuditor: boolean
    currentStage: string | null
  }
  eligibleStages: { stageId: string; name: string; isRequired: boolean; delegatedFromName: string | null }[]
}

export type Paginated<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  pages: number
}

// ---------------------------------------------------------------- approvals

export type InboxItemDTO = {
  instanceId: string
  documentId: string
  reference: string
  title: string
  categoryName: string
  departmentName: string
  supplierName: string | null
  amount: number
  currency: string
  submittedAt: string
  stepStartedAt: string
  currentStep: number
  totalSteps: number
  cycle: number
  dueAt: string | null
  stages: { stageId: string; name: string; delegatedFromName: string | null }[]
}

// ---------------------------------------------------------------- workflow config

export type StageDTO = {
  id: string | null
  workflowId?: string
  sequence: number
  name: string
  description: string | null
  approverRole: RoleKey
  departmentScope: 'ANY' | 'DOCUMENT' | 'FIXED'
  departmentId: string | null
  departmentName?: string | null
  minAmount: number | null
  maxAmount: number | null
  isRequired: boolean
  slaHours: number | null
}

export type WorkflowDTO = {
  id: string
  code: string
  name: string
  description: string | null
  categoryId: string
  categoryName: string
  isActive: boolean
  minAmount: number | null
  maxAmount: number | null
  stages: StageDTO[]
  updatedAt: string
}

export type ApprovalRuleDTO = {
  id: string
  role: RoleKey
  maxAmount: number | null
  currency: string
}

export type SoDRuleDTO = {
  id: string
  code: string
  name: string
  ruleType: 'SELF_APPROVAL' | 'ROLE_PAIR' | 'MULTI_STAGE_SAME_USER'
  roleA: string | null
  roleB: string | null
  severity: Severity
  description: string | null
  isActive: boolean
}

// ---------------------------------------------------------------- notifications

export type NotificationDTO = {
  id: string
  type: 'INFO' | 'ACTION_REQUIRED' | 'ALERT' | 'SYSTEM'
  title: string
  body: string | null
  link: string | null
  isRead: boolean
  createdAt: string
}

// ---------------------------------------------------------------- delegations

export type DelegationDTO = {
  id: string
  fromUserId: string
  fromUserName: string
  fromUserEmail: string
  toUserId: string
  toUserName: string
  toUserEmail: string
  reason: string
  startAt: string
  endAt: string
  isActive: boolean
  revokedAt: string | null
  createdAt: string
}

// ---------------------------------------------------------------- audit

export type AuditEventDTO = {
  seq: number
  occurredAt: string
  actorId: string | null
  actorName: string | null
  actorEmail: string | null
  actorRole: string | null
  action: string
  entityType: string | null
  entityId: string | null
  details: unknown
  ip: string | null
  prevHash: string
  hash: string
}

export type ChainVerificationDTO = {
  valid: boolean
  eventCount: number
  firstBrokenSeq: number | null
  issues: { seq: number; problem: string }[]
  latestHash: string | null
  verifiedAt: string
}

export type AuditOverviewDTO = {
  unresolvedExceptions: number
  exceptionsByType: Record<string, number>
  exceptionsBySeverity: Record<string, number>
  failedLogins24h: number
  unauthorizedAttempts: number
  auditEventCount: number
  exceptions: ExceptionDTO[]
  failedLoginDetails: { email: string; reason: string | null; ip: string | null; createdAt: string }[]
  chain: ChainVerificationDTO
}

export type AdminOverviewDTO = {
  usersByRole: Record<string, number>
  totalUsers: number
  activeSessions: number
  documentsByStatus: Record<string, number>
  totalDocuments: number
  storageBytes: number
  activeWorkflows: number
  auditChain: { valid: boolean; eventCount: number; latestHash: string | null }
  emailsSkipped: number
  unresolvedExceptions: number
}

// ---------------------------------------------------------------- dashboard/reports

export type DashboardDTO = {
  scope: 'GLOBAL' | 'SCOPED'
  kpis: {
    totalRequests: number
    inReview: number
    approved: number
    rejected: number
    returned: number
    suspended: number
    drafts: number
    overdue: number
    avgApprovalHours: number | null
    approvalRate: number | null
    rejectionRate: number | null
    myPendingActions: number
    totalAmount: number
  }
  byDepartment: { name: string; total: number; approved: number; pending: number; rejected: number; amount: number }[]
  byCategory: { name: string; total: number; approved: number; pending: number; rejected: number; amount: number }[]
  monthly: { month: string; total: number; approved: number }[]
  avgTimeByStage: { stage: string; avgHours: number }[]
  recentEvents: AuditEventDTO[]
  myPendingDocuments: {
    documentId: string
    reference: string
    title: string
    amount: number
    currency: string
    currentStage: string
    stepStartedAt: string
  }[]
}

export type MonitorSummaryDTO = {
  overdueDetected: number
  repeatedReturns: number
  repeatedRejections: number
  exceptionsCreated: number
}
