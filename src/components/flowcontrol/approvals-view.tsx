// ============================================================================
// FlowControl — Pending Approvals (inbox)
//
// Approval tasks awaiting the signed-in user's decision, including tasks
// received through active delegations. Quick approve with explicit
// confirmation; full review opens the request dossier.
// ============================================================================
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import { formatAmount, timeAgo } from '@/lib/client/format'
import type { InboxItemDTO } from '@/types/flowcontrol'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AlertTriangle, CheckCircle2, Clock, Inbox, RefreshCw } from 'lucide-react'
import { ConfirmDialog, EmptyState, PageHeader, SectionCard } from './shared'
import { StatusBadge } from './status-badge'

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

/** Human label for a duration in milliseconds (SLA windows). */
function durationLabel(ms: number): string {
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} d`
}

function DueChip({ dueAt }: { dueAt: string | null }) {
  if (!dueAt) return <span className="text-xs text-muted-foreground">No SLA deadline</span>
  const diff = new Date(dueAt).getTime() - Date.now()
  if (diff < 0) {
    return (
      <span className="flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        Overdue by {durationLabel(-diff)}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <Clock className="h-3.5 w-3.5" aria-hidden />
      Due in {durationLabel(diff)}
    </span>
  )
}

export function ApprovalsView() {
  const { dataVersion, bumpData, openDocument } = useFlowControlStore()
  const [items, setItems] = useState<InboxItemDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [quick, setQuick] = useState<InboxItemDTO | null>(null)
  const [quickComment, setQuickComment] = useState('')
  const [quickError, setQuickError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await api.get<{ items: InboxItemDTO[] }>('/api/approvals/inbox')
        if (!cancelled) {
          setItems(res.items)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(errMessage(err, 'Failed to load the approval inbox.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [dataVersion])

  const closeQuick = () => {
    setQuick(null)
    setQuickComment('')
    setQuickError(null)
  }

  const quickApprove = async () => {
    if (!quick || quick.stages.length === 0) return
    setBusy(true)
    setQuickError(null)
    try {
      const res = await api.post<{ ok: true; message: string }>(`/api/approvals/${quick.instanceId}/act`, {
        action: 'APPROVE',
        comment: quickComment.trim() || undefined,
        confirm: true,
        stageId: quick.stages[0].stageId,
        expectedStep: quick.currentStep,
      })
      toast.success(res.message)
      closeQuick()
      bumpData()
    } catch (err) {
      const message = errMessage(err, 'The approval could not be recorded.')
      setQuickError(message)
      toast.error(message)
      bumpData()
    } finally {
      setBusy(false)
    }
  }

  const list = items ?? []

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pending Approvals"
        description={
          items
            ? `${list.length} request${list.length === 1 ? '' : 's'} awaiting your decision at their current stage.`
            : 'Approval tasks routed to you, including delegated authority.'
        }
        actions={
          <Button variant="outline" size="sm" onClick={bumpData}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Refresh
          </Button>
        }
      />

      <SectionCard
        title="Approval Inbox"
        description="Each card is one request at the step where you (or a delegation to you) must act."
      >
        {loading && !items ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
            ))}
          </div>
        ) : error ? (
          <EmptyState
            title="Inbox unavailable"
            description={error}
            action={
              <Button variant="outline" size="sm" onClick={bumpData}>
                Retry
              </Button>
            }
          />
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground/60" aria-hidden />
            <p className="mt-3 text-sm font-medium">No approvals awaiting your decision</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              When a request reaches a stage assigned to you — or delegated to you — it appears here.
            </p>
          </div>
        ) : (
          <div className="max-h-[640px] space-y-3 overflow-y-auto fc-scroll pr-1">
            {list.map((item) => (
              <Card key={item.instanceId}>
                <CardContent className="p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-tight">
                        {item.reference} — {item.title}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {item.categoryName} · {item.departmentName}
                        {item.supplierName ? ` · ${item.supplierName}` : ''}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                        <span>Submitted {timeAgo(item.submittedAt)}</span>
                        <span>
                          Step <span className="fc-num font-medium">{item.currentStep + 1}</span> of{' '}
                          <span className="fc-num font-medium">{item.totalSteps}</span>
                        </span>
                        {item.cycle > 1 ? <StatusBadge variant="warning">Cycle {item.cycle}</StatusBadge> : null}
                        <DueChip dueAt={item.dueAt} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.stages.map((s) => (
                          <Badge key={s.stageId} variant="outline" className="font-normal">
                            Your stage: {s.name}
                            {s.delegatedFromName ? ` (via delegation from ${s.delegatedFromName})` : ''}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
                      <span className="fc-num text-lg font-semibold">{formatAmount(item.amount, item.currency)}</span>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => openDocument(item.documentId)}>
                          Review Details
                        </Button>
                        {item.stages.length > 0 ? (
                          <Button
                            size="sm"
                            className="bg-[#0077b6] text-white hover:bg-[#023e8a]"
                            onClick={() => {
                              setQuick(item)
                              setQuickComment('')
                              setQuickError(null)
                            }}
                          >
                            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                            Approve
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Quick approve confirmation — the dialog IS the explicit confirmation */}
      <ConfirmDialog
        open={quick !== null}
        onOpenChange={(o) => (o ? null : closeQuick())}
        title="Confirm Approval"
        description={quick ? `${quick.reference} — ${quick.title}` : undefined}
        confirmLabel="Confirm Approval"
        loading={busy}
        onConfirm={() => void quickApprove()}
      >
        {quickError ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{quickError}</AlertDescription>
          </Alert>
        ) : null}
        {quick ? (
          <>
            <p className="text-sm leading-relaxed">
              Do you confirm approval of <span className="font-medium">{quick.reference}</span> at stage “
              {quick.stages[0]?.name}”? This decision is legally traceable and recorded in the audit trail.
            </p>
            {quick.stages[0]?.delegatedFromName ? (
              <p className="mt-2 text-xs text-muted-foreground">
                You are acting on behalf of {quick.stages[0].delegatedFromName} through an active delegation.
              </p>
            ) : null}
            <div className="mt-3 grid gap-1.5">
              <Label htmlFor="quick-comment">Comment (optional)</Label>
              <Textarea
                id="quick-comment"
                value={quickComment}
                onChange={(e) => setQuickComment(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="e.g. Verified against the approved budget line."
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              For rejections, returns or a full review of the evidence and history, use “Review Details”.
            </p>
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
