// ============================================================================
// FlowControl — Delegations
//
// Delegate approval authority for a limited period (max 30 days). Delegates
// act on the delegator's behalf; the engine records the delegation chain on
// every decision and SoD / threshold controls still apply.
// ============================================================================

'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import { formatDate, timeAgo } from '@/lib/client/format'
import type { DelegationDTO } from '@/types/flowcontrol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader, SectionCard, EmptyState, LoadingState, ConfirmDialog } from './shared'
import { StatusBadge, type badgeVariant } from './status-badge'
import { toast } from 'sonner'
import { ArrowRight, Info, Plus, ShieldOff } from 'lucide-react'

const MAX_DELEGATION_DAYS = 30

/** Format a Date as the value expected by <input type="datetime-local">. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function delegationStatus(d: DelegationDTO, now: number): { label: string; variant: badgeVariant } {
  if (d.revokedAt) return { label: 'Revoked', variant: 'outline' }
  if (new Date(d.endAt).getTime() < now) return { label: 'Expired', variant: 'secondary' }
  if (new Date(d.startAt).getTime() > now) return { label: 'Scheduled', variant: 'info' }
  return { label: 'Active', variant: 'success' }
}

function NewDelegationDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const defaultStart = () => toLocalInputValue(new Date())
  const defaultEnd = () => toLocalInputValue(new Date(Date.now() + 7 * 24 * 3600_000))

  const [toUserEmail, setToUserEmail] = useState('')
  const [reason, setReason] = useState('')
  const [startAt, setStartAt] = useState(defaultStart)
  const [endAt, setEndAt] = useState(defaultEnd)
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setToUserEmail('')
      setReason('')
      setStartAt(defaultStart())
      setEndAt(defaultEnd())
      setLocalError(null)
    }
  }, [open])

  const submit = async () => {
    setLocalError(null)
    const start = new Date(startAt)
    const end = new Date(endAt)
    if (!toUserEmail.includes('@')) {
      setLocalError('Enter a valid corporate email address.')
      return
    }
    if (reason.trim().length < 5 || reason.trim().length > 500) {
      setLocalError('The reason must be between 5 and 500 characters.')
      return
    }
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      setLocalError('The delegation end must be after its start.')
      return
    }
    if (end.getTime() - start.getTime() > MAX_DELEGATION_DAYS * 24 * 3600_000) {
      setLocalError(`Delegations cannot exceed ${MAX_DELEGATION_DAYS} days.`)
      return
    }
    setSubmitting(true)
    try {
      await api.post('/api/delegations', {
        toUserEmail: toUserEmail.trim(),
        reason: reason.trim(),
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      })
      toast.success('Delegation created. The delegate can now act on your behalf during the period.')
      onOpenChange(false)
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create the delegation.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New Delegation"
      description="Temporarily transfer your approval authority to another approver (max 30 days)."
      confirmLabel="Create Delegation"
      loading={submitting}
      onConfirm={() => void submit()}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="delegation-email">Delegate email</Label>
          <Input
            id="delegation-email"
            type="email"
            placeholder="approver@company.ma"
            value={toUserEmail}
            onChange={(e) => setToUserEmail(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">The user must hold an approver role and be active.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="delegation-reason">Reason</Label>
          <Textarea
            id="delegation-reason"
            rows={3}
            placeholder="Absence, workload sharing, mission…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">Recorded in the audit trail (5–500 characters).</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="delegation-start">Starts at</Label>
            <Input id="delegation-start" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delegation-end">Ends at</Label>
            <Input id="delegation-end" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
          </div>
        </div>
        {localError ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {localError}
          </p>
        ) : null}
      </div>
    </ConfirmDialog>
  )
}

export function DelegationsView() {
  const { user, dataVersion, bumpData } = useFlowControlStore()
  const [given, setGiven] = useState<DelegationDTO[]>([])
  const [received, setReceived] = useState<DelegationDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<DelegationDTO | null>(null)
  const [revoking, setRevoking] = useState(false)
  const now = Date.now()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<{ given: DelegationDTO[]; received: DelegationDTO[] }>('/api/delegations')
      setGiven(data.given)
      setReceived(data.received)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load delegations.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, dataVersion])

  const revoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await api.post(`/api/delegations/${revokeTarget.id}/revoke`)
      toast.success('Delegation revoked.')
      setRevokeTarget(null)
      await load()
      bumpData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke the delegation.')
    } finally {
      setRevoking(false)
    }
  }

  const canRevoke = (d: DelegationDTO) => !d.revokedAt && (d.fromUserId === user?.id || user?.role === 'SUPER_ADMIN')

  const renderCard = (d: DelegationDTO, direction: 'given' | 'received') => {
    const status = delegationStatus(d, now)
    return (
      <div key={d.id} className="rounded-lg border p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
              <span className="truncate">{d.fromUserName}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{d.toUserName}</span>
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {d.fromUserEmail} → {d.toUserEmail}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
            {canRevoke(d) ? (
              <Button variant="destructive" size="sm" onClick={() => setRevokeTarget(d)}>
                <ShieldOff className="mr-1.5 h-3.5 w-3.5" />
                Revoke
              </Button>
            ) : null}
          </div>
        </div>
        <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{d.reason}</p>
        <p className="fc-num mt-2 text-[11px] text-muted-foreground">
          {formatDate(d.startAt)} → {formatDate(d.endAt)}
          {direction === 'received' ? <span> · created {timeAgo(d.createdAt)}</span> : null}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Delegations"
        description="Temporary, time-boxed transfers of approval authority — fully audited."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Delegation
          </Button>
        }
      />

      <SectionCard
        title="How delegation works"
        description="Engine behavior and controls that remain enforced."
        className="border-l-4 border-l-primary/40"
      >
        <div className="flex items-start gap-2.5 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p>
            Delegates act on your behalf; every decision records the delegation chain. Self-approval and threshold
            rules still apply. Delegations are limited to {MAX_DELEGATION_DAYS} days, can be revoked at any time by
            the delegator or an administrator, and are archived in the tamper-evident audit trail.
          </p>
        </div>
      </SectionCard>

      {loading ? (
        <LoadingState rows={4} />
      ) : (
        <Tabs defaultValue="given">
          <TabsList>
            <TabsTrigger value="given">Delegated by me ({given.length})</TabsTrigger>
            <TabsTrigger value="received">Delegated to me ({received.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="given" className="mt-4">
            {given.length === 0 ? (
              <EmptyState
                title="You have not delegated anything"
                description="Create a delegation before an absence so pending approvals continue to flow."
              />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">{given.map((d) => renderCard(d, 'given'))}</div>
            )}
          </TabsContent>
          <TabsContent value="received" className="mt-4">
            {received.length === 0 ? (
              <EmptyState
                title="No delegations received"
                description="When a colleague delegates their approval authority to you, it appears here."
              />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">{received.map((d) => renderCard(d, 'received'))}</div>
            )}
          </TabsContent>
        </Tabs>
      )}

      <NewDelegationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          void load()
          bumpData()
        }}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null)
        }}
        title="Revoke delegation"
        description={
          revokeTarget
            ? `Revoke the delegation from ${revokeTarget.fromUserName} to ${revokeTarget.toUserName}? The delegate immediately loses the authority to act for the delegator.`
            : undefined
        }
        confirmLabel="Revoke Delegation"
        destructive
        loading={revoking}
        onConfirm={() => void revoke()}
      />
    </div>
  )
}
