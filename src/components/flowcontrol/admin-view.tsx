// ============================================================================
// FlowControl — Administration Console (SUPER_ADMIN)
//
// Users, departments, workflow configuration, approval thresholds and
// segregation-of-duties rules. The server enforces role checks; this console
// is the operator surface for those administrative APIs.
// ============================================================================

'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { api, qs } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import {
  formatBytes,
  timeAgo,
  shortHash,
  ROLE_LABELS,
  DOCUMENT_STATUS_META,
} from '@/lib/client/format'
import type {
  AdminOverviewDTO,
  ApprovalRuleDTO,
  DepartmentDTO,
  DocumentStatus,
  MetaDTO,
  MonitorSummaryDTO,
  Paginated,
  RoleKey,
  Severity,
  SoDRuleDTO,
  StageDTO,
  UserDTO,
  WorkflowDTO,
} from '@/types/flowcontrol'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { PageHeader, KpiCard, SectionCard, EmptyState, TableSkeleton, ConfirmDialog } from './shared'
import { StatusBadge, type badgeVariant } from './status-badge'
import { toast } from 'sonner'
import {
  Activity,
  ArrowRight,
  ChevronDown,
  Database,
  FileStack,
  Gauge,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Trash2,
  UserPlus,
  Users as UsersIcon,
  Workflow as WorkflowIcon,
} from 'lucide-react'

// ---------------------------------------------------------------- shared bits

const PASSWORD_POLICY_HINT =
  'At least 10 characters, including an uppercase letter, a lowercase letter, a digit and a special character.'

const ALL_ROLES = Object.keys(ROLE_LABELS) as RoleKey[]

const FALLBACK_APPROVER_ROLES: { key: RoleKey; label: string }[] = (
  ['PURCHASING', 'DEPT_MANAGER', 'FIN_CONTROLLER', 'ACCOUNTANT', 'TREASURY', 'GENERAL_DIRECTOR'] as RoleKey[]
).map((key) => ({ key, label: ROLE_LABELS[key] }))

const SOD_TYPE_LABELS: Record<SoDRuleDTO['ruleType'], string> = {
  SELF_APPROVAL: 'Self-Approval',
  ROLE_PAIR: 'Role Pair',
  MULTI_STAGE_SAME_USER: 'Multi-Stage Same User',
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null
  return (
    <div className="flex flex-col gap-2 pt-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        {total} user{total === 1 ? '' : 's'} · page {page} of {pages}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  )
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {children}
    </p>
  )
}

// ---------------------------------------------------------------- overview tab

function OverviewTab() {
  const { bumpData } = useFlowControlStore()
  const [data, setData] = useState<AdminOverviewDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [monitorsOpen, setMonitorsOpen] = useState(false)
  const [monitorsLoading, setMonitorsLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.get<AdminOverviewDTO>('/api/admin/overview')
      setData(result)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load the admin overview.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runMonitors = async () => {
    setMonitorsLoading(true)
    try {
      const res = await api.post<{ ok: boolean; summary: MonitorSummaryDTO }>('/api/admin/monitors')
      const s = res.summary
      toast.success(
        `Monitors complete — ${s.overdueDetected} overdue, ${s.repeatedReturns} repeated returns, ${s.repeatedRejections} repeated rejections, ${s.exceptionsCreated} new exception(s).`,
      )
      setMonitorsOpen(false)
      await load()
      bumpData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run the control monitors.')
    } finally {
      setMonitorsLoading(false)
    }
  }

  if (loading && !data) return <TableSkeleton />
  if (!data) return <EmptyState title="Overview unavailable" />

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Total Users" value={data.totalUsers} hint="Across all roles" icon={<UsersIcon className="h-5 w-5" />} />
        <KpiCard label="Active Sessions" value={data.activeSessions} tone="info" hint={`${data.emailsSkipped} emails skipped (SMTP off)`} icon={<Activity className="h-5 w-5" />} />
        <KpiCard label="Documents" value={data.totalDocuments} hint="All statuses" icon={<FileStack className="h-5 w-5" />} />
        <KpiCard label="Storage Used" value={formatBytes(data.storageBytes)} hint="Document versions" icon={<Database className="h-5 w-5" />} />
        <KpiCard label="Active Workflows" value={data.activeWorkflows} icon={<WorkflowIcon className="h-5 w-5" />} />
        <KpiCard
          label="Unresolved Exceptions"
          value={data.unresolvedExceptions}
          tone={data.unresolvedExceptions > 0 ? 'danger' : 'success'}
          icon={<ShieldAlert className="h-5 w-5" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Audit Chain"
          description="Live verification of the hash-chained audit trail."
          className="lg:col-span-1"
        >
          <div className="flex items-start gap-2.5">
            {data.auditChain.valid ? (
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#0096c7] dark:text-[#90e0ef]" aria-hidden />
            ) : (
              <ShieldX className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
            )}
            <div className="min-w-0">
              <p className={cn('text-sm font-medium', data.auditChain.valid ? 'text-[#0077b6] dark:text-[#90e0ef]' : 'text-red-700 dark:text-red-400')}>
                {data.auditChain.valid ? 'Chain verified' : 'Chain BROKEN'}
              </p>
              <p className="fc-num mt-0.5 text-xs text-muted-foreground">
                {data.auditChain.eventCount.toLocaleString('en-US')} hash-chained events
              </p>
              <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">
                anchor {data.auditChain.latestHash ? shortHash(data.auditChain.latestHash) : '—'}
              </p>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Users by Role" description="Distribution of the 8 business roles." className="lg:col-span-1">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {ALL_ROLES.map((r) => (
              <div key={r} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-muted-foreground" title={ROLE_LABELS[r]}>
                  {ROLE_LABELS[r]}
                </span>
                <span className="fc-num shrink-0 font-medium">{data.usersByRole[r] ?? 0}</span>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Documents by Status" description="Portfolio state across the platform." className="lg:col-span-1">
          <div className="space-y-1.5">
            {(Object.keys(DOCUMENT_STATUS_META) as DocumentStatus[]).map((s) => (
              <div key={s} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOCUMENT_STATUS_META[s].dot)} aria-hidden />
                  <span className="truncate">{DOCUMENT_STATUS_META[s].label}</span>
                </span>
                <span className="fc-num shrink-0 font-medium">{data.documentsByStatus[s] ?? 0}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Control Monitors"
        description="Scheduled control checks (overdue stages, repeated returns/rejections, SoD) — run on demand."
        actions={
          <Button size="sm" onClick={() => setMonitorsOpen(true)}>
            <Gauge className="mr-2 h-4 w-4" />
            Run Control Monitors
          </Button>
        }
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          The monitors scan all in-flight approvals and create control exceptions for violations. They also run
          automatically whenever an auditor opens the Internal Audit dashboard. Detected exceptions are routed to the
          audit console for resolution.
        </p>
      </SectionCard>

      <ConfirmDialog
        open={monitorsOpen}
        onOpenChange={setMonitorsOpen}
        title="Run control monitors"
        description="Scans all in-flight approvals for overdue stages, repeated returns and rejections, and other control violations. New findings open control exceptions."
        confirmLabel="Run Monitors"
        loading={monitorsLoading}
        onConfirm={() => void runMonitors()}
      />
    </div>
  )
}

// ---------------------------------------------------------------- users tab

function userStatus(u: UserDTO): { label: string; variant: badgeVariant } {
  if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) return { label: 'Locked', variant: 'destructive' }
  if (!u.isActive) return { label: 'Inactive', variant: 'secondary' }
  return { label: 'Active', variant: 'success' }
}

function UserCreateDialog({ open, onOpenChange, meta, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; meta: MetaDTO | null; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<RoleKey>('PURCHASING')
  const [departmentId, setDepartmentId] = useState('NONE')
  const [jobTitle, setJobTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName('')
      setEmail('')
      setPassword('')
      setRole('PURCHASING')
      setDepartmentId('NONE')
      setJobTitle('')
      setLocalError(null)
    }
  }, [open])

  const submit = async () => {
    setLocalError(null)
    if (name.trim().length < 2) return setLocalError('Enter the full name (2+ characters).')
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setLocalError('Enter a valid email address.')
    if (password.length < 10) return setLocalError('The password does not meet the policy requirements.')
    try {
      await api.post('/api/admin/users', {
        name: name.trim(),
        email: email.trim(),
        password,
        role,
        departmentId: departmentId === 'NONE' ? null : departmentId,
        jobTitle: jobTitle.trim() || null,
      })
      toast.success(`User ${email.trim()} created.`)
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create the user.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New User"
      description="Provision an account. The user signs in with this password immediately."
      confirmLabel="Create User"
      loading={submitting}
      onConfirm={() => void submit()}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="nu-name">Full name</Label>
          <Input id="nu-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Fatima Zahra El Amrani" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nu-email">Email</Label>
          <Input id="nu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.ma" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nu-password">Initial password</Label>
          <Input id="nu-password" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Temporary password" />
          <p className="text-[11px] text-muted-foreground">{PASSWORD_POLICY_HINT}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as RoleKey)}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">None</SelectItem>
                {meta?.departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nu-title">Job title (optional)</Label>
          <Input id="nu-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Purchasing Officer" />
        </div>
        {localError ? <FieldError>{localError}</FieldError> : null}
      </div>
    </ConfirmDialog>
  )
}

function UserEditDialog({ target, open, onOpenChange, meta, onSaved }: { target: UserDTO | null; open: boolean; onOpenChange: (o: boolean) => void; meta: MetaDTO | null; onSaved: () => void }) {
  const { user } = useFlowControlStore()
  const [name, setName] = useState('')
  const [role, setRole] = useState<RoleKey>('PURCHASING')
  const [departmentId, setDepartmentId] = useState('NONE')
  const [jobTitle, setJobTitle] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const isSelf = target?.id === user?.id

  useEffect(() => {
    if (open && target) {
      setName(target.name)
      setRole(target.role)
      setDepartmentId(target.departmentId ?? 'NONE')
      setJobTitle(target.jobTitle ?? '')
      setIsActive(target.isActive)
    }
  }, [open, target])

  const submit = async () => {
    if (!target) return
    if (name.trim().length < 2) {
      toast.error('The name must be at least 2 characters.')
      return
    }
    setSubmitting(true)
    try {
      await api.patch(`/api/admin/users/${target.id}`, {
        name: name.trim(),
        role,
        departmentId: departmentId === 'NONE' ? null : departmentId,
        jobTitle: jobTitle.trim() || null,
        isActive,
      })
      toast.success('User updated.')
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update the user.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit User"
      description={target ? `${target.name} — ${target.email}` : undefined}
      confirmLabel="Save Changes"
      loading={submitting}
      onConfirm={() => void submit()}
    >
      <div className="space-y-3">
        {isSelf ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            You cannot deactivate your own account or change your own role (server-enforced).
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="eu-name">Full name</Label>
          <Input id="eu-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as RoleKey)} disabled={isSelf}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">None</SelectItem>
                {meta?.departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="eu-title">Job title</Label>
          <Input id="eu-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <div>
            <Label htmlFor="eu-active" className="text-sm">Active</Label>
            <p className="text-[11px] text-muted-foreground">Deactivation revokes all sessions and blocks sign-in.</p>
          </div>
          <Switch id="eu-active" checked={isActive} onCheckedChange={setIsActive} disabled={isSelf} />
        </div>
      </div>
    </ConfirmDialog>
  )
}

function ResetPasswordDialog({ target, open, onOpenChange, onSaved }: { target: UserDTO | null; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) setPassword('')
  }, [open])

  const submit = async () => {
    if (!target) return
    if (password.length < 10) {
      toast.error('The password does not meet the policy requirements.')
      return
    }
    setSubmitting(true)
    try {
      await api.post(`/api/admin/users/${target.id}/reset-password`, { password })
      toast.success(`Password reset for ${target.email}. All their sessions were revoked.`)
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset the password.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reset Password"
      description={target ? `Set a new password for ${target.email}. Their active sessions are revoked immediately.` : undefined}
      confirmLabel="Reset Password"
      loading={submitting}
      onConfirm={() => void submit()}
    >
      <div className="space-y-1.5">
        <Label htmlFor="rp-password">New password</Label>
        <Input id="rp-password" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" />
        <p className="text-[11px] text-muted-foreground">{PASSWORD_POLICY_HINT}</p>
      </div>
    </ConfirmDialog>
  )
}

function UsersTab({ meta }: { meta: MetaDTO | null }) {
  const { dataVersion, bumpData } = useFlowControlStore()
  const [q, setQ] = useState('')
  const [role, setRole] = useState('ALL')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Paginated<UserDTO> | null>(null)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<UserDTO | null>(null)
  const [resetTarget, setResetTarget] = useState<UserDTO | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const query = qs({ q, role: role === 'ALL' ? '' : role, page, pageSize: 50 })
        const data = await api.get<Paginated<UserDTO>>(`/api/admin/users${query}`)
        if (!cancelled) setResult(data)
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load users.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, role, page, dataVersion])

  const refresh = () => {
    bumpData()
  }

  return (
    <SectionCard
      title="Users"
      description="Accounts, roles and lockout state across the platform."
      actions={
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" />
          New User
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="user-search" className="text-xs">Search</Label>
          <Input
            id="user-search"
            placeholder="Name or email…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(1)
            }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="user-role-filter">Role</Label>
          <Select
            value={role}
            onValueChange={(v) => {
              setRole(v)
              setPage(1)
            }}
          >
            <SelectTrigger id="user-role-filter" size="sm" className="w-full">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All roles</SelectItem>
              {ALL_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4">
        {loading && !result ? (
          <TableSkeleton />
        ) : !result || result.items.length === 0 ? (
          <EmptyState title="No users match the search" description="Try a different name, email or role filter." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Login</TableHead>
                    <TableHead className="text-right">Failed Logins</TableHead>
                    <TableHead className="w-12" aria-label="Actions" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.items.map((u) => {
                    const status = userStatus(u)
                    return (
                      <TableRow key={u.id}>
                        <TableCell>
                          <p className="text-xs font-medium">{u.name}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{u.email}</p>
                        </TableCell>
                        <TableCell>
                          <StatusBadge variant="outline">{ROLE_LABELS[u.role]}</StatusBadge>
                        </TableCell>
                        <TableCell className="max-w-32 truncate text-xs text-muted-foreground">
                          {u.departmentName ?? '—'}
                        </TableCell>
                        <TableCell>
                          <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'}
                        </TableCell>
                        <TableCell className="fc-num text-right text-xs">{u.failedLogins}</TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Actions for ${u.name}`}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setEditTarget(u)}>
                                <Pencil className="mr-2 h-3.5 w-3.5" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setResetTarget(u)}>
                                <KeyRound className="mr-2 h-3.5 w-3.5" />
                                Reset password
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <Pager page={result.page} pages={result.pages} total={result.total} onPage={setPage} />
          </>
        )}
      </div>

      <UserCreateDialog open={createOpen} onOpenChange={setCreateOpen} meta={meta} onSaved={refresh} />
      <UserEditDialog target={editTarget} open={editTarget !== null} onOpenChange={(o) => {
        if (!o) setEditTarget(null)
      }} meta={meta} onSaved={refresh} />
      <ResetPasswordDialog target={resetTarget} open={resetTarget !== null} onOpenChange={(o) => {
        if (!o) setResetTarget(null)
      }} onSaved={refresh} />
    </SectionCard>
  )
}

// ---------------------------------------------------------------- departments tab

type DepartmentRow = DepartmentDTO & { userCount: number }

function DepartmentDialog({
  open,
  onOpenChange,
  target,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  target: DepartmentRow | null // null = create
  onSaved: () => void
}) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const isNew = target === null

  useEffect(() => {
    if (open) {
      setCode(target?.code ?? '')
      setName(target?.name ?? '')
      setLocalError(null)
    }
  }, [open, target])

  const submit = async () => {
    setLocalError(null)
    if (!/^[A-Z0-9_-]{2,20}$/.test(code)) {
      setLocalError('Code must be 2–20 uppercase letters, digits, - or _.')
      return
    }
    if (name.trim().length < 2) {
      setLocalError('The department name must be at least 2 characters.')
      return
    }
    setSubmitting(true)
    try {
      if (isNew) {
        await api.post('/api/admin/departments', { code, name: name.trim() })
        toast.success(`Department ${code} created.`)
      } else {
        await api.patch(`/api/admin/departments/${target.id}`, { code, name: name.trim() })
        toast.success('Department updated.')
      }
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the department.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? 'New Department' : 'Edit Department'}
      description={isNew ? 'Departments drive scoping for documents, approvers and reports.' : target ? `${target.code} — ${target.name}` : undefined}
      confirmLabel={isNew ? 'Create Department' : 'Save Changes'}
      loading={submitting}
      onConfirm={() => void submit()}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="dept-code">Code</Label>
          <Input
            id="dept-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="OPS"
            className="font-mono uppercase"
            maxLength={20}
          />
          <p className="text-[11px] text-muted-foreground">2–20 uppercase letters, digits, - or _ (unique).</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dept-name">Name</Label>
          <Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Operations" />
        </div>
        {localError ? <FieldError>{localError}</FieldError> : null}
      </div>
    </ConfirmDialog>
  )
}

function DepartmentsTab() {
  const { dataVersion, bumpData } = useFlowControlStore()
  const [items, setItems] = useState<DepartmentRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<DepartmentRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<{ items: DepartmentRow[] }>('/api/admin/departments')
      setItems(data.items)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load departments.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, dataVersion])

  return (
    <SectionCard
      title="Departments"
      description="Organizational units used for document scoping and stage routing."
      actions={
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Department
        </Button>
      }
    >
      {loading && !items ? (
        <TableSkeleton />
      ) : !items || items.length === 0 ? (
        <EmptyState title="No departments" description="Create the first department to start scoping requests." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="w-12" aria-label="Actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-mono text-xs font-medium">{d.code}</TableCell>
                  <TableCell className="text-sm">{d.name}</TableCell>
                  <TableCell className="fc-num text-right text-xs">{d.userCount}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit ${d.name}`} onClick={() => setEditTarget(d)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <DepartmentDialog
        open={dialogOpen || editTarget !== null}
        onOpenChange={(o) => {
          setDialogOpen(o)
          if (!o) setEditTarget(null)
        }}
        target={editTarget}
        onSaved={() => {
          setEditTarget(null)
          void load()
          bumpData()
        }}
      />
    </SectionCard>
  )
}

// ---------------------------------------------------------------- workflows tab

type StageDraft = {
  id: string | null
  sequence: number
  name: string
  description: string
  approverRole: RoleKey
  departmentScope: 'ANY' | 'DOCUMENT' | 'FIXED'
  departmentId: string
  minAmount: string
  maxAmount: string
  isRequired: boolean
  slaHours: string
}

function toStageDraft(s: StageDTO): StageDraft {
  return {
    id: s.id,
    sequence: s.sequence,
    name: s.name,
    description: s.description ?? '',
    approverRole: s.approverRole,
    departmentScope: s.departmentScope,
    departmentId: s.departmentId ?? '',
    minAmount: s.minAmount === null ? '' : String(s.minAmount),
    maxAmount: s.maxAmount === null ? '' : String(s.maxAmount),
    isRequired: s.isRequired,
    slaHours: s.slaHours === null ? '' : String(s.slaHours),
  }
}

function newStageDraft(sequence: number): StageDraft {
  return {
    id: null,
    sequence,
    name: '',
    description: '',
    approverRole: 'DEPT_MANAGER',
    departmentScope: 'ANY',
    departmentId: '',
    minAmount: '',
    maxAmount: '',
    isRequired: true,
    slaHours: '',
  }
}

function amountRangeLabel(min: number | null, max: number | null): string {
  if (min === null && max === null) return 'All amounts'
  const fmt = (v: number) => new Intl.NumberFormat('en-US').format(v)
  return `Applies to ${min === null ? '0' : fmt(min)} – ${max === null ? 'no ceiling' : fmt(max)} MAD`
}

function WorkflowEditorDialog({
  open,
  onOpenChange,
  target, // null = create
  meta,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  target: WorkflowDTO | null
  meta: MetaDTO | null
  onSaved: () => void
}) {
  const isNew = target === null
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [stages, setStages] = useState<StageDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmSave, setConfirmSave] = useState(false)
  const [expandedStage, setExpandedStage] = useState<number | null>(0)
  const approverRoles = meta?.roles.filter((r) => r.approver).map((r) => ({ key: r.key, label: r.label })) ?? FALLBACK_APPROVER_ROLES

  useEffect(() => {
    if (open) {
      setCode(target?.code ?? '')
      setName(target?.name ?? '')
      setDescription(target?.description ?? '')
      setCategoryId(target?.categoryId ?? '')
      setIsActive(target?.isActive ?? true)
      setMinAmount(target?.minAmount === null || target?.minAmount === undefined ? '' : String(target.minAmount))
      setMaxAmount(target?.maxAmount === null || target?.maxAmount === undefined ? '' : String(target.maxAmount))
      setStages(target ? target.stages.map(toStageDraft) : [newStageDraft(1)])
      setExpandedStage(0)
      setConfirmSave(false)
    }
  }, [open, target])

  const updateStage = (index: number, patch: Partial<StageDraft>) => {
    setStages((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const addStage = () => {
    const nextSeq = stages.reduce((max, s) => Math.max(max, s.sequence), 0) + 1
    setStages((prev) => [...prev, newStageDraft(nextSeq)])
    setExpandedStage(stages.length)
  }

  const removeStage = (index: number) => {
    setStages((prev) => prev.filter((_, i) => i !== index))
    setExpandedStage(null)
  }

  const validate = (): string | null => {
    if (isNew && !/^[A-Z0-9_-]{2,30}$/.test(code)) return 'Code must be 2–30 uppercase letters, digits, - or _.'
    if (name.trim().length < 3) return 'The workflow name must be at least 3 characters.'
    if (!categoryId) return 'Select a document category.'
    if (stages.length === 0) return 'A workflow needs at least one stage.'
    for (const s of stages) {
      if (s.name.trim().length < 2) return 'Every stage needs a name (2+ characters).'
      if (s.departmentScope === 'FIXED' && !s.departmentId) return `Stage "${s.name}": FIXED scope requires a department.`
      if (
        s.minAmount !== '' &&
        s.maxAmount !== '' &&
        Number(s.minAmount) > Number(s.maxAmount)
      ) {
        return `Stage "${s.name}": the minimum amount exceeds the maximum amount.`
      }
    }
    if (!stages.some((s) => s.isRequired)) return 'A workflow needs at least one required stage.'
    if (minAmount !== '' && maxAmount !== '' && Number(minAmount) > Number(maxAmount)) {
      return 'The workflow minimum amount exceeds its maximum amount.'
    }
    return null
  }

  const doSave = async () => {
    const payload = {
      ...(isNew ? { code } : {}),
      name: name.trim(),
      description: description.trim() || null,
      categoryId,
      isActive,
      minAmount: minAmount === '' ? null : Number(minAmount),
      maxAmount: maxAmount === '' ? null : Number(maxAmount),
      stages: stages.map((s) => ({
        id: s.id,
        sequence: s.sequence,
        name: s.name.trim(),
        description: s.description.trim() || null,
        approverRole: s.approverRole,
        departmentScope: s.departmentScope,
        departmentId: s.departmentScope === 'FIXED' ? s.departmentId : null,
        minAmount: s.minAmount === '' ? null : Number(s.minAmount),
        maxAmount: s.maxAmount === '' ? null : Number(s.maxAmount),
        isRequired: s.isRequired,
        slaHours: s.slaHours === '' ? null : Number(s.slaHours),
      })),
    }
    setSaving(true)
    try {
      if (target) {
        await api.patch(`/api/admin/workflows/${target.id}`, payload)
        toast.success('Workflow updated. Running instances keep their stage snapshots.')
      } else {
        await api.post('/api/admin/workflows', payload)
        toast.success('Workflow created.')
      }
      setConfirmSave(false)
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the workflow.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[88vh] overflow-y-auto fc-scroll sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{isNew ? 'New Workflow' : `Edit Workflow — ${target.code}`}</DialogTitle>
            <DialogDescription>
              {isNew ? 'Define the approval circuit for a document category.' : 'Stage changes replace the configuration; history is snapshot-based and never rewritten.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wf-code">Code</Label>
                <Input
                  id="wf-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="PUR_STD"
                  className="font-mono uppercase"
                  disabled={!isNew}
                  maxLength={30}
                />
                {!isNew ? <p className="text-[11px] text-muted-foreground">The code is immutable once created.</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wf-name">Name</Label>
                <Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard Purchase Approval" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wf-description">Description (optional)</Label>
              <Textarea id="wf-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={categoryId} onValueChange={setCategoryId}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {meta?.categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wf-min">Min amount (MAD)</Label>
                <Input id="wf-min" type="number" min={0} value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder="Optional" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wf-max">Max amount (MAD)</Label>
                <Input id="wf-max" type="number" min={0} value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div>
                <Label htmlFor="wf-active" className="text-sm">Active</Label>
                <p className="text-[11px] text-muted-foreground">Only active workflows are selectable for new submissions.</p>
              </div>
              <Switch id="wf-active" checked={isActive} onCheckedChange={setIsActive} />
            </div>

            {/* Stage editor */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Stages ({stages.length})</p>
                  <p className="text-[11px] text-muted-foreground">
                    Stages sharing the same sequence number run in PARALLEL; different sequences run sequentially.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={addStage}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Stage
                </Button>
              </div>

              {stages.length === 0 ? (
                <EmptyState title="No stages" description="Add at least one required stage." />
              ) : (
                <div className="space-y-2">
                  {stages.map((s, i) => (
                    <Collapsible key={i} open={expandedStage === i} onOpenChange={(o) => setExpandedStage(o ? i : null)} className="rounded-lg border">
                      <div className="flex items-center gap-2 p-2.5">
                        <CollapsibleTrigger asChild>
                          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-label={`Toggle stage ${i + 1}`}>
                            <span className="fc-num flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                              {s.sequence}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-medium">
                                {s.name || <span className="italic text-muted-foreground">Untitled stage</span>}
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {ROLE_LABELS[s.approverRole]} · {s.isRequired ? 'Required' : 'Optional'}
                                {s.departmentScope === 'FIXED' ? ' · FIXED scope' : s.departmentScope === 'DOCUMENT' ? ' · Document dept.' : ''}
                              </span>
                            </span>
                            <ChevronDown
                              className={cn('ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform', expandedStage === i && 'rotate-180')}
                              aria-hidden
                            />
                          </button>
                        </CollapsibleTrigger>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeStage(i)}
                          aria-label={`Remove stage ${s.name || i + 1}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <CollapsibleContent>
                        <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor={`stage-seq-${i}`}>Sequence</Label>
                            <Input
                              id={`stage-seq-${i}`}
                              type="number"
                              min={1}
                              max={999}
                              value={s.sequence}
                              onChange={(e) => updateStage(i, { sequence: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`stage-name-${i}`}>Stage name</Label>
                            <Input id={`stage-name-${i}`} value={s.name} onChange={(e) => updateStage(i, { name: e.target.value })} placeholder="Financial Control" />
                          </div>
                          <div className="space-y-1.5">
                            <Label>Approver role</Label>
                            <Select value={s.approverRole} onValueChange={(v) => updateStage(i, { approverRole: v as RoleKey })}>
                              <SelectTrigger size="sm" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {approverRoles.map((r) => (
                                  <SelectItem key={r.key} value={r.key}>
                                    {r.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <Label>Department scope</Label>
                            <Select
                              value={s.departmentScope}
                              onValueChange={(v) => updateStage(i, { departmentScope: v as StageDraft['departmentScope'] })}
                            >
                              <SelectTrigger size="sm" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ANY">Any department</SelectItem>
                                <SelectItem value="DOCUMENT">Same as document</SelectItem>
                                <SelectItem value="FIXED">Fixed department</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {s.departmentScope === 'FIXED' ? (
                            <div className="space-y-1.5 sm:col-span-2">
                              <Label>Fixed department</Label>
                              <Select value={s.departmentId} onValueChange={(v) => updateStage(i, { departmentId: v })}>
                                <SelectTrigger size="sm" className="w-full">
                                  <SelectValue placeholder="Select a department…" />
                                </SelectTrigger>
                                <SelectContent>
                                  {meta?.departments.map((d) => (
                                    <SelectItem key={d.id} value={d.id}>
                                      {d.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : null}
                          <div className="space-y-1.5">
                            <Label htmlFor={`stage-min-${i}`}>Min amount (MAD)</Label>
                            <Input
                              id={`stage-min-${i}`}
                              type="number"
                              min={0}
                              value={s.minAmount}
                              onChange={(e) => updateStage(i, { minAmount: e.target.value })}
                              placeholder="Optional"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`stage-max-${i}`}>Max amount (MAD)</Label>
                            <Input
                              id={`stage-max-${i}`}
                              type="number"
                              min={0}
                              value={s.maxAmount}
                              onChange={(e) => updateStage(i, { maxAmount: e.target.value })}
                              placeholder="Optional"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`stage-sla-${i}`}>SLA (hours)</Label>
                            <Input
                              id={`stage-sla-${i}`}
                              type="number"
                              min={1}
                              max={2160}
                              value={s.slaHours}
                              onChange={(e) => updateStage(i, { slaHours: e.target.value })}
                              placeholder="e.g. 48"
                            />
                          </div>
                          <div className="flex items-center justify-between rounded-md border px-3 py-2">
                            <Label htmlFor={`stage-required-${i}`} className="text-xs">Required stage</Label>
                            <Switch
                              id={`stage-required-${i}`}
                              checked={s.isRequired}
                              onCheckedChange={(v) => updateStage(i, { isRequired: v })}
                            />
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const problem = validate()
                if (problem) {
                  toast.error(problem)
                  return
                }
                setConfirmSave(true)
              }}
              disabled={saving}
            >
              Save Workflow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmSave}
        onOpenChange={setConfirmSave}
        title="Save workflow configuration"
        description={
          isNew
            ? `Create workflow ${code} with ${stages.length} stage(s)?`
            : `Update ${target?.code}? The stage set is REPLACED — running approvals keep their stage snapshots and are unaffected.`
        }
        confirmLabel="Confirm Save"
        loading={saving}
        onConfirm={() => void doSave()}
      />
    </>
  )
}

function WorkflowsTab({ meta }: { meta: MetaDTO | null }) {
  const { dataVersion, bumpData } = useFlowControlStore()
  const [items, setItems] = useState<WorkflowDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<WorkflowDTO | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<{ items: WorkflowDTO[] }>('/api/admin/workflows')
      setItems(data.items)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load workflows.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, dataVersion])

  const toggleActive = async (w: WorkflowDTO, next: boolean) => {
    setTogglingId(w.id)
    try {
      await api.patch(`/api/admin/workflows/${w.id}`, { isActive: next })
      toast.success(`${w.code} ${next ? 'activated' : 'deactivated'}.`)
      await load()
      bumpData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update the workflow.')
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <SectionCard
      title="Workflows"
      description="Approval circuits per document category, including amounts and stage ordering."
      actions={
        <Button
          size="sm"
          onClick={() => {
            setEditTarget(null)
            setEditorOpen(true)
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          New Workflow
        </Button>
      }
    >
      {loading && !items ? (
        <TableSkeleton />
      ) : !items || items.length === 0 ? (
        <EmptyState title="No workflows configured" description="Create a workflow to route documents through approval stages." />
      ) : (
        <div className="space-y-3">
          {items.map((w) => (
            <div key={w.id} className="rounded-lg border p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">{w.code}</code>
                    <span className="truncate text-sm font-medium">{w.name}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {w.categoryName} · {amountRangeLabel(w.minAmount, w.maxAmount)} · updated {timeAgo(w.updatedAt)}
                  </p>
                  {w.description ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{w.description}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`wf-switch-${w.id}`} className="text-xs text-muted-foreground">
                      Active
                    </Label>
                    <Switch
                      id={`wf-switch-${w.id}`}
                      checked={w.isActive}
                      disabled={togglingId === w.id}
                      onCheckedChange={(v) => void toggleActive(w, v)}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditTarget(w)
                      setEditorOpen(true)
                    }}
                  >
                    <Pencil className="mr-2 h-3.5 w-3.5" />
                    Edit
                  </Button>
                </div>
              </div>
              <div className="mt-3">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Stage path ({w.stages.length})
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {w.stages.map((s, i) => (
                    <Fragment key={s.id ?? i}>
                      <span
                        className={cn(
                          'inline-flex max-w-64 items-center gap-1 rounded-md border px-2 py-1 text-[11px]',
                          s.isRequired ? 'bg-muted/40' : 'border-dashed bg-transparent',
                        )}
                        title={`${ROLE_LABELS[s.approverRole]} · sequence ${s.sequence} · ${s.isRequired ? 'required' : 'optional'}`}
                      >
                        <span className="fc-num font-semibold">{s.sequence}.</span>
                        <span className="truncate">{s.name}</span>
                        {s.departmentScope === 'DOCUMENT' ? <span className="text-muted-foreground">(document dept.)</span> : null}
                        {s.departmentScope === 'FIXED' ? <span className="text-muted-foreground">({s.departmentName ?? 'fixed'})</span> : null}
                        {!s.isRequired ? <span className="text-muted-foreground">· optional</span> : null}
                      </span>
                      {i < w.stages.length - 1 ? <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
                    </Fragment>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <WorkflowEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        target={editTarget}
        meta={meta}
        onSaved={() => {
          setEditTarget(null)
          void load()
          bumpData()
        }}
      />
    </SectionCard>
  )
}

// ---------------------------------------------------------------- thresholds tab

type ThresholdDraft = { unlimited: boolean; value: string }

function ThresholdsTab() {
  const { bumpData } = useFlowControlStore()
  const [items, setItems] = useState<ApprovalRuleDTO[] | null>(null)
  const [approverRoles, setApproverRoles] = useState<string[]>(FALLBACK_APPROVER_ROLES.map((r) => r.key))
  const [drafts, setDrafts] = useState<Record<string, ThresholdDraft>>({})
  const [loading, setLoading] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<{ items: ApprovalRuleDTO[]; approverRoles: string[] }>('/api/admin/thresholds')
      setItems(data.items)
      if (data.approverRoles.length > 0) setApproverRoles(data.approverRoles)
      const next: Record<string, ThresholdDraft> = {}
      for (const role of data.approverRoles) {
        const rule = data.items.find((r) => r.role === role)
        next[role] =
          rule && rule.maxAmount !== null ? { unlimited: false, value: String(rule.maxAmount) } : { unlimited: true, value: '' }
      }
      setDrafts(next)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load approval thresholds.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const dirty =
    items !== null &&
    approverRoles.some((role) => {
      const rule = items.find((r) => r.role === role)
      const draft = drafts[role]
      if (!draft) return false
      if (draft.unlimited) return rule?.maxAmount !== null && rule?.maxAmount !== undefined ? true : !rule
      const value = draft.value === '' ? null : Number(draft.value)
      return rule ? rule.maxAmount !== value : value !== null
    })

  const save = async () => {
    setSaving(true)
    try {
      await api.put('/api/admin/thresholds', {
        rules: approverRoles.map((role) => ({
          role,
          maxAmount: drafts[role]?.unlimited || drafts[role]?.value === '' ? null : Number(drafts[role].value),
        })),
      })
      toast.success('Approval thresholds saved.')
      setConfirmOpen(false)
      await load()
      bumpData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the thresholds.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard
      title="Approval Thresholds"
      description="Per-role maximum approval amounts, enforced server-side on every decision."
      actions={
        <Button size="sm" disabled={!dirty} onClick={() => setConfirmOpen(true)}>
          Save Thresholds
        </Button>
      }
    >
      {loading ? (
        <TableSkeleton />
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Maximum Amount</TableHead>
                  <TableHead className="w-28">Unlimited</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {approverRoles.map((role) => {
                  const draft = drafts[role] ?? { unlimited: true, value: '' }
                  return (
                    <TableRow key={role}>
                      <TableCell className="text-xs font-medium">{ROLE_LABELS[role as RoleKey] ?? role}</TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          className="fc-num h-8 max-w-44"
                          value={draft.value}
                          disabled={draft.unlimited}
                          placeholder="No ceiling"
                          aria-label={`Maximum amount for ${ROLE_LABELS[role as RoleKey] ?? role}`}
                          onChange={(e) => setDrafts({ ...drafts, [role]: { unlimited: false, value: e.target.value } })}
                        />
                      </TableCell>
                      <TableCell>
                        <Checkbox
                          id={`unlimited-${role}`}
                          checked={draft.unlimited}
                          onCheckedChange={(checked) =>
                            setDrafts({ ...drafts, [role]: { unlimited: checked === true, value: checked === true ? '' : draft.value } })
                          }
                          aria-label={`Unlimited approval amount for ${ROLE_LABELS[role as RoleKey] ?? role}`}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Amounts are whole units (MAD). 0 means the role cannot approve anything; empty/unlimited means no ceiling.
            Thresholds apply in addition to workflow routing and segregation-of-duties checks.
          </p>
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Save approval thresholds"
        description="These limits take effect immediately for all future approval decisions. The change is audited."
        confirmLabel="Save Thresholds"
        loading={saving}
        onConfirm={() => void save()}
      />
    </SectionCard>
  )
}

// ---------------------------------------------------------------- SoD rules tab

function SodRuleDialog({ open, onOpenChange, meta, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; meta: MetaDTO | null; onSaved: () => void }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [ruleType, setRuleType] = useState<SoDRuleDTO['ruleType']>('SELF_APPROVAL')
  const [roleA, setRoleA] = useState<string>('PURCHASING')
  const [roleB, setRoleB] = useState<string>('FIN_CONTROLLER')
  const [severity, setSeverity] = useState<Severity>('HIGH')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setCode('')
      setName('')
      setRuleType('SELF_APPROVAL')
      setRoleA('PURCHASING')
      setRoleB('FIN_CONTROLLER')
      setSeverity('HIGH')
      setDescription('')
      setLocalError(null)
    }
  }, [open])

  const submit = async () => {
    setLocalError(null)
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
      setLocalError('Code must be 2–40 uppercase letters, digits, - or _.')
      return
    }
    if (name.trim().length < 3) {
      setLocalError('The rule name must be at least 3 characters.')
      return
    }
    if (ruleType === 'ROLE_PAIR' && (!roleA || !roleB)) {
      setLocalError('ROLE_PAIR rules require two roles.')
      return
    }
    setSubmitting(true)
    try {
      await api.post('/api/admin/sod-rules', {
        code,
        name: name.trim(),
        ruleType,
        ...(ruleType === 'ROLE_PAIR' ? { roleA, roleB } : {}),
        severity,
        description: description.trim() || null,
      })
      toast.success(`SoD rule ${code} created.`)
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create the SoD rule.')
    } finally {
      setSubmitting(false)
    }
  }

  const roleOptions = meta?.roles ?? ALL_ROLES.map((key) => ({ key, label: ROLE_LABELS[key], approver: false }))

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New SoD Rule"
      description="Segregation-of-duties rules are evaluated on every approval action and submission."
      confirmLabel="Create Rule"
      loading={submitting}
      onConfirm={() => void submit()}
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sod-code">Code</Label>
            <Input id="sod-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="SOD_PUR_FIN" className="font-mono uppercase" maxLength={40} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sod-name">Name</Label>
            <Input id="sod-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Purchasing vs Financial Control" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Rule type</Label>
          <Select value={ruleType} onValueChange={(v) => setRuleType(v as SoDRuleDTO['ruleType'])}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="SELF_APPROVAL">Self-Approval</SelectItem>
              <SelectItem value="ROLE_PAIR">Role Pair</SelectItem>
              <SelectItem value="MULTI_STAGE_SAME_USER">Multi-Stage Same User</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {ruleType === 'ROLE_PAIR' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Role A</Label>
              <Select value={roleA} onValueChange={setRoleA}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => (
                    <SelectItem key={r.key} value={r.key}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Role B</Label>
              <Select value={roleB} onValueChange={setRoleB}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => (
                    <SelectItem key={r.key} value={r.key}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label>Severity</Label>
          <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="LOW">Low</SelectItem>
              <SelectItem value="MEDIUM">Medium</SelectItem>
              <SelectItem value="HIGH">High</SelectItem>
              <SelectItem value="CRITICAL">Critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sod-description">Description (optional)</Label>
          <Textarea id="sod-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {localError ? <FieldError>{localError}</FieldError> : null}
      </div>
    </ConfirmDialog>
  )
}

function SodRulesTab({ meta }: { meta: MetaDTO | null }) {
  const { dataVersion, bumpData } = useFlowControlStore()
  const [items, setItems] = useState<SoDRuleDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<{ items: SoDRuleDTO[] }>('/api/admin/sod-rules')
      setItems(data.items)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load SoD rules.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, dataVersion])

  const toggleActive = async (rule: SoDRuleDTO, next: boolean) => {
    setTogglingId(rule.id)
    try {
      await api.patch(`/api/admin/sod-rules/${rule.id}`, { isActive: next })
      toast.success(`${rule.code} ${next ? 'enabled' : 'disabled'}.`)
      await load()
      bumpData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update the rule.')
    } finally {
      setTogglingId(null)
    }
  }

  const roleLabel = (key: string | null) => (key ? (ROLE_LABELS[key as RoleKey] ?? key) : null)

  return (
    <SectionCard
      title="Segregation of Duties Rules"
      description="Conflicting-duty constraints evaluated on every approval and submission."
      actions={
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Rule
        </Button>
      }
    >
      {loading && !items ? (
        <TableSkeleton />
      ) : !items || items.length === 0 ? (
        <EmptyState title="No SoD rules" description="Create rules to block self-approvals and conflicting duty combinations." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="max-w-52">Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs font-medium">{r.code}</TableCell>
                  <TableCell className="max-w-40 truncate text-xs">{r.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{SOD_TYPE_LABELS[r.ruleType]}</TableCell>
                  <TableCell className="max-w-52 text-xs text-muted-foreground">
                    {r.ruleType === 'ROLE_PAIR' && r.roleA && r.roleB ? (
                      <span className="truncate">
                        {roleLabel(r.roleA)} + {roleLabel(r.roleB)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      variant={
                        r.severity === 'CRITICAL' || r.severity === 'HIGH'
                          ? 'destructive'
                          : r.severity === 'MEDIUM'
                            ? 'warning'
                            : 'secondary'
                      }
                    >
                      {r.severity.charAt(0) + r.severity.slice(1).toLowerCase()}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      id={`sod-switch-${r.id}`}
                      checked={r.isActive}
                      disabled={togglingId === r.id}
                      onCheckedChange={(v) => void toggleActive(r, v)}
                      aria-label={`Toggle rule ${r.code}`}
                    />
                  </TableCell>
                  <TableCell className="max-w-52 truncate text-xs text-muted-foreground">{r.description ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <SodRuleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        meta={meta}
        onSaved={() => {
          void load()
          bumpData()
        }}
      />
    </SectionCard>
  )
}

// ---------------------------------------------------------------- main view

export function AdminView() {
  const [meta, setMeta] = useState<MetaDTO | null>(null)

  useEffect(() => {
    api
      .get<MetaDTO>('/api/meta')
      .then(setMeta)
      .catch(() => {
        // Selects fall back to built-in role lists if metadata is unavailable.
      })
  }, [])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Administration"
        description="Users, departments, workflows, approval thresholds and segregation-of-duties rules."
      />
      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="departments">Departments</TabsTrigger>
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="thresholds">Thresholds</TabsTrigger>
          <TabsTrigger value="sod">SoD Rules</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersTab meta={meta} />
        </TabsContent>
        <TabsContent value="departments" className="mt-4">
          <DepartmentsTab />
        </TabsContent>
        <TabsContent value="workflows" className="mt-4">
          <WorkflowsTab meta={meta} />
        </TabsContent>
        <TabsContent value="thresholds" className="mt-4">
          <ThresholdsTab />
        </TabsContent>
        <TabsContent value="sod" className="mt-4">
          <SodRulesTab meta={meta} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
