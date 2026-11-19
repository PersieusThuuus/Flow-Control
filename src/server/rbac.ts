// ============================================================================
// FlowControl — Role-Based Access Control (RBAC)
//
// Single source of truth for roles and permissions. Permissions are enforced
// SERVER-SIDE on every API route (see src/server/api.ts helpers). The UI hides
// what a user cannot do, but hiding is never the control — the server is.
//
// Design decision: roles are a fixed, code-defined taxonomy (not mutable DB
// rows) because the 8 business roles are part of the business model itself.
// What administrators MUST configure without code — SoD rules, approval
// thresholds, workflow stages — lives in the database (SoDRule, ApprovalRule,
// Workflow/WorkflowStage tables).
// ============================================================================

export const ROLE_KEYS = [
  'SUPER_ADMIN',
  'PURCHASING',
  'DEPT_MANAGER',
  'FIN_CONTROLLER',
  'ACCOUNTANT',
  'TREASURY',
  'GENERAL_DIRECTOR',
  'INTERNAL_AUDITOR',
] as const

export type RoleKey = (typeof ROLE_KEYS)[number]

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Super Administrator',
  PURCHASING: 'Purchasing Department',
  DEPT_MANAGER: 'Department Manager',
  FIN_CONTROLLER: 'Financial Controller',
  ACCOUNTANT: 'Accountant',
  TREASURY: 'Finance / Treasury',
  GENERAL_DIRECTOR: 'General Director',
  INTERNAL_AUDITOR: 'Internal Auditor',
}

export const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Manages users, departments, workflows, thresholds and system configuration. Does not approve business documents.',
  PURCHASING: 'Creates purchase requests and orders, submits them for approval, tracks their progress.',
  DEPT_MANAGER: 'Reviews and approves requests raised by their own department.',
  FIN_CONTROLLER: 'Verifies budget availability and financial consistency of requests.',
  ACCOUNTANT: 'Reviews accounting information and supporting documentation.',
  TREASURY: 'Reviews payment authorizations and records payment execution.',
  GENERAL_DIRECTOR: 'Provides final authorization for high-value transactions.',
  INTERNAL_AUDITOR: 'Read-only access to audit trails, exceptions and reports. Never approves transactions.',
}

// Roles that may appear as workflow stage approvers. SUPER_ADMIN and
// INTERNAL_AUDITOR are deliberately excluded: administrators configure the
// system, auditors observe it — neither belongs in an approval chain
// (segregation of duties by design).
export const APPROVER_ROLES: RoleKey[] = [
  'PURCHASING',
  'DEPT_MANAGER',
  'FIN_CONTROLLER',
  'ACCOUNTANT',
  'TREASURY',
  'GENERAL_DIRECTOR',
]

export type Permission =
  // Administration
  | 'admin.users'
  | 'admin.departments'
  | 'admin.workflows'
  | 'admin.thresholds'
  | 'admin.sod'
  | 'admin.monitors'
  | 'admin.overview'
  // Documents & requests
  | 'documents.create'
  | 'documents.view.own'
  | 'documents.view.department'
  | 'documents.view.routed'
  | 'documents.view.all'
  | 'requests.view'
  // Approvals
  | 'approvals.act'
  // Delegations
  | 'delegations.manage'
  // Reporting & audit
  | 'reports.view'
  | 'audit.view'
  | 'audit.export'

/**
 * The permission matrix. Principle of least privilege: a role receives only
 * the permissions listed here — everything else is denied by default.
 */
export const PERMISSIONS: Record<RoleKey, Permission[]> = {
  SUPER_ADMIN: [
    'admin.users',
    'admin.departments',
    'admin.workflows',
    'admin.thresholds',
    'admin.sod',
    'admin.monitors',
    'admin.overview',
    'documents.view.all',
    'requests.view',
    'delegations.manage',
    'reports.view',
    'audit.view',
    'audit.export',
  ],
  PURCHASING: [
    'documents.create',
    'documents.view.own',
    'documents.view.department',
    'requests.view',
  ],
  DEPT_MANAGER: [
    'approvals.act',
    'documents.create',
    'documents.view.department',
    'documents.view.routed',
    'requests.view',
    'delegations.manage',
    'reports.view',
  ],
  FIN_CONTROLLER: [
    'approvals.act',
    'documents.view.routed',
    'requests.view',
    'delegations.manage',
    'reports.view',
  ],
  ACCOUNTANT: [
    'approvals.act',
    'documents.view.routed',
    'requests.view',
    'delegations.manage',
    'reports.view',
  ],
  TREASURY: [
    'approvals.act',
    'documents.view.routed',
    'requests.view',
    'delegations.manage',
    'reports.view',
  ],
  GENERAL_DIRECTOR: [
    'approvals.act',
    'documents.view.routed',
    'requests.view',
    'delegations.manage',
    'reports.view',
  ],
  // The auditor can read and export everything relevant to audit work but
  // holds no approval power and cannot resolve exceptions (admin responsibility).
  INTERNAL_AUDITOR: [
    'documents.view.all',
    'requests.view',
    'reports.view',
    'audit.view',
    'audit.export',
  ],
}

export type SessionUser = {
  id: string
  email: string
  name: string
  role: RoleKey
  jobTitle: string | null
  departmentId: string | null
  departmentName: string | null
  departmentCode: string | null
}

export function hasPermission(
  user: { role: string } | null | undefined,
  permission: Permission,
): boolean {
  if (!user) return false
  const role = user.role as RoleKey
  return (PERMISSIONS[role] ?? []).includes(permission)
}

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value)
}
