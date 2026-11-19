// ============================================================================
// FlowControl — Client-side formatting and status metadata
// Shared by every view for consistent badges, labels and number formatting.
// ============================================================================

import type { DocumentStatus, InstanceStatus, Severity, ApprovalAction, RoleKey } from '@/types/flowcontrol'
import type { badgeVariant } from '@/components/flowcontrol/status-badge'

export function formatAmount(amount: number, currency = 'MAD'): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(amount)} ${currency}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} d ago`
  return formatDateOnly(iso)
}

export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '—'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} d`
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

// ---------------------------------------------------------------- status meta

export const DOCUMENT_STATUS_META: Record<DocumentStatus, { label: string; variant: badgeVariant; dot: string }> = {
  DRAFT: { label: 'Draft', variant: 'secondary', dot: 'bg-zinc-400' },
  IN_REVIEW: { label: 'In Review', variant: 'warning', dot: 'bg-amber-500' },
  APPROVED: { label: 'Approved', variant: 'success', dot: 'bg-emerald-500' },
  REJECTED: { label: 'Rejected', variant: 'destructive', dot: 'bg-red-500' },
  RETURNED: { label: 'Returned', variant: 'warning', dot: 'bg-orange-500' },
  CANCELLED: { label: 'Cancelled', variant: 'outline', dot: 'bg-zinc-400' },
}

export const INSTANCE_STATUS_META: Record<InstanceStatus, { label: string; variant: badgeVariant }> = {
  IN_PROGRESS: { label: 'In Progress', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  RETURNED_FOR_CORRECTION: { label: 'Returned for Correction', variant: 'warning' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
  SUSPENDED: { label: 'Suspended', variant: 'secondary' },
}

export const SEVERITY_META: Record<Severity, { label: string; variant: badgeVariant }> = {
  LOW: { label: 'Low', variant: 'secondary' },
  MEDIUM: { label: 'Medium', variant: 'warning' },
  HIGH: { label: 'High', variant: 'destructive' },
  CRITICAL: { label: 'Critical', variant: 'destructive' },
}

export const ACTION_META: Record<ApprovalAction, { label: string; variant: badgeVariant }> = {
  APPROVE: { label: 'Approved', variant: 'success' },
  REJECT: { label: 'Rejected', variant: 'destructive' },
  RETURN_FOR_CORRECTION: { label: 'Returned', variant: 'warning' },
  COMMENT: { label: 'Comment', variant: 'secondary' },
}

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

export const EXCEPTION_TYPE_LABELS: Record<string, string> = {
  SOD_SELF_APPROVAL: 'SoD — Self-Approval Attempt',
  SOD_ROLE_PAIR: 'SoD — Conflicting Roles',
  SOD_MULTI_STAGE: 'SoD — Multi-Stage Approval',
  THRESHOLD_BREACH: 'Approval Threshold Exceeded',
  OVERDUE_STAGE: 'Overdue Approval Stage',
  REPEATED_RETURN: 'Repeated Returns',
  REPEATED_REJECTION: 'Repeated Rejections',
  FAST_TRACK_SEQUENCE: 'Fast-Track Sequence',
  MISSING_EVIDENCE: 'Missing Evidence',
  UNAUTHORIZED_ACCESS: 'Unauthorized Access Attempt',
}

export function exceptionLabel(type: string): string {
  return EXCEPTION_TYPE_LABELS[type] ?? type
}

/** Truncate a hash for display while keeping a verifiable prefix. */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 12)}…${hash.slice(-4)}` : hash
}
