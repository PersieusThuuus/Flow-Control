// ============================================================================
// FlowControl — Request Detail (approval interface)
//
// Full request dossier: approval workflow timeline (parallel steps), decision
// history bound to document hashes, immutable versions, control exceptions,
// and the contextual action panel (decisions, corrections, admin controls).
// ============================================================================
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import {
  formatAmount,
  formatBytes,
  formatDate,
  formatDateOnly,
  timeAgo,
  shortHash,
  ROLE_LABELS,
  DOCUMENT_STATUS_META,
  INSTANCE_STATUS_META,
  ACTION_META,
  SEVERITY_META,
  exceptionLabel,
} from '@/lib/client/format'
import type {
  ApprovalAction,
  ApprovalDTO,
  DocumentDetailDTO,
  DocumentSummaryDTO,
  ExceptionDTO,
  InstanceDTO,
  MetaDTO,
  RoleKey,
  StageSnapshotDTO,
  StepSnapshotDTO,
} from '@/types/flowcontrol'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  Copy,
  CornerUpLeft,
  FileUp,
  MessageSquare,
  ShieldAlert,
  Send,
  XCircle,
} from 'lucide-react'
import { ConfirmDialog, EmptyState, PageHeader, SectionCard } from './shared'
import { StatusBadge } from './status-badge'

type StepState = 'done' | 'current' | 'pending' | 'rejected' | 'returned'

const STEP_STATE_LABEL: Record<StepState, string> = {
  done: 'Completed',
  current: 'In progress',
  pending: 'Pending',
  rejected: 'Rejected',
  returned: 'Returned',
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

function matchWorkflow(meta: MetaDTO | null, categoryId: string, amount: number) {
  if (!meta) return null
  const matches = meta.workflows.filter(
    (w) =>
      w.categoryId === categoryId &&
      (w.minAmount === null || amount >= w.minAmount) &&
      (w.maxAmount === null || amount <= w.maxAmount),
  )
  return matches.length > 0 ? matches[0] : null
}

function slaLabel(hours: number | null): string {
  if (hours === null || hours === undefined) return 'No SLA'
  return hours >= 48 ? `SLA ${(hours / 24).toFixed(1)} d` : `SLA ${hours} h`
}

/** Decisive (non-comment) decision for a stage in the current cycle, if any. */
function decisiveFor(approvals: ApprovalDTO[], cycle: number, stepIndex: number, stageId: string): ApprovalDTO | null {
  return (
    approvals.find(
      (a) => a.cycle === cycle && a.stepIndex === stepIndex && a.stageId === stageId && a.action !== 'COMMENT',
    ) ?? null
  )
}

function computeStepState(
  step: StepSnapshotDTO,
  stepIndex: number,
  currentStep: number,
  cycleApprovals: ApprovalDTO[],
): StepState {
  const decisives = cycleApprovals.filter((a) => a.stepIndex === stepIndex && a.action !== 'COMMENT')
  if (decisives.some((a) => a.action === 'REJECT')) return 'rejected'
  if (decisives.some((a) => a.action === 'RETURN_FOR_CORRECTION')) return 'returned'
  const approvedIds = new Set(decisives.filter((a) => a.action === 'APPROVE').map((a) => a.stageId))
  const required = step.stages.filter((s) => s.isRequired)
  const complete =
    required.length > 0 ? required.every((s) => approvedIds.has(s.stageId)) : decisives.some((a) => a.action === 'APPROVE')
  if (complete) return 'done'
  return stepIndex === currentStep ? 'current' : 'pending'
}

function stepIcon(state: StepState) {
  switch (state) {
    case 'done':
      return <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
    case 'current':
      return <Clock className="h-4 w-4 text-amber-500" aria-hidden />
    case 'rejected':
      return <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden />
    case 'returned':
      return <CornerUpLeft className="h-4 w-4 text-orange-500" aria-hidden />
    default:
      return <Circle className="h-4 w-4 text-muted-foreground/60" aria-hidden />
  }
}

// ---------------------------------------------------------------------------
// Workflow step timeline
// ---------------------------------------------------------------------------
function StageDecisionLine({ approval }: { approval: ApprovalDTO | null }) {
  if (!approval) return null
  const behalf = approval.delegatedFromName ? ` on behalf of ${approval.delegatedFromName}` : ''
  if (approval.action === 'APPROVE') {
    return (
      <p className="mt-2 flex items-start gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Approved by {approval.userName}
        {behalf}
      </p>
    )
  }
  if (approval.action === 'REJECT') {
    return (
      <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Rejected by {approval.userName}
        {behalf}
      </p>
    )
  }
  if (approval.action === 'RETURN_FOR_CORRECTION') {
    return (
      <p className="mt-2 flex items-start gap-1.5 text-xs text-orange-600 dark:text-orange-400">
        <CornerUpLeft className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Returned by {approval.userName}
        {behalf}
      </p>
    )
  }
  return null
}

function StageCard({
  stage,
  approval,
  awaiting,
}: {
  stage: StageSnapshotDTO
  approval: ApprovalDTO | null
  awaiting: boolean
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-tight">{stage.name}</p>
        <Badge variant={stage.isRequired ? 'default' : 'secondary'} className="shrink-0 text-[10px]">
          {stage.isRequired ? 'Required' : 'Optional'}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{ROLE_LABELS[stage.approverRole]}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{slaLabel(stage.slaHours)}</p>
      <StageDecisionLine approval={approval} />
      {awaiting && !approval ? <p className="mt-2 text-xs text-muted-foreground">Awaiting decision</p> : null}
    </div>
  )
}

function StepTimeline({
  instance,
  cycleApprovals,
}: {
  instance: InstanceDTO
  cycleApprovals: ApprovalDTO[]
}) {
  return (
    <ol className="space-y-0">
      {instance.stagePath.map((step, idx) => {
        const state = computeStepState(step, idx, instance.currentStep, cycleApprovals)
        const isLast = idx === instance.stagePath.length - 1
        return (
          <li key={idx} className="relative flex gap-3 pb-5 last:pb-0">
            {!isLast ? <span className="absolute bottom-0 left-[13px] top-8 w-px bg-border" aria-hidden /> : null}
            <div className="relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-background">
              {stepIcon(state)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">
                  Step {idx + 1}
                  {step.stages.length > 1 ? ' (parallel)' : ''}
                </p>
                <StatusBadge
                  variant={
                    state === 'done'
                      ? 'success'
                      : state === 'current'
                        ? 'warning'
                        : state === 'rejected'
                          ? 'destructive'
                          : state === 'returned'
                            ? 'warning'
                            : 'secondary'
                  }
                >
                  {STEP_STATE_LABEL[state]}
                </StatusBadge>
                {state === 'current' ? (
                  <span className="text-xs text-muted-foreground">since {timeAgo(instance.currentStepStartedAt)}</span>
                ) : null}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {step.stages.map((stage) => (
                  <StageCard
                    key={stage.stageId}
                    stage={stage}
                    approval={decisiveFor(cycleApprovals, instance.cycle, idx, stage.stageId)}
                    awaiting={state === 'current'}
                  />
                ))}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ---------------------------------------------------------------------------
// Approval history timeline (all cycles, asc)
// ---------------------------------------------------------------------------
function ApprovalHistoryTimeline({ approvals }: { approvals: ApprovalDTO[] }) {
  const rows = approvals.map((a, i) => ({
    approval: a,
    startsCycle: i === 0 || approvals[i - 1].cycle !== a.cycle,
  }))
  return (
    <ol className="space-y-4">
      {rows.map(({ approval: a, startsCycle }) => {
        return (
          <li key={a.id} className="space-y-2">
            {startsCycle ? (
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Review cycle {a.cycle}
              </p>
            ) : null}
            <div className="flex gap-3">
              <div className="mt-0.5 shrink-0">
                {a.action === 'APPROVE' ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                ) : a.action === 'REJECT' ? (
                  <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden />
                ) : a.action === 'RETURN_FOR_CORRECTION' ? (
                  <CornerUpLeft className="h-4 w-4 text-orange-500" aria-hidden />
                ) : (
                  <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-medium">{a.userName}</span>
                  <span className="text-muted-foreground"> · </span>
                  <span className="text-muted-foreground">
                    {ROLE_LABELS[a.userRole as RoleKey] ?? a.userRole}
                  </span>
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StatusBadge variant={ACTION_META[a.action].variant}>{ACTION_META[a.action].label}</StatusBadge>
                  <span className="text-xs text-muted-foreground">at {a.stageName}</span>
                  {a.delegatedFromName ? (
                    <span className="text-xs text-muted-foreground">on behalf of {a.delegatedFromName}</span>
                  ) : null}
                </div>
                {a.comment ? (
                  <blockquote className="mt-1.5 border-l-2 pl-2.5 text-xs italic text-muted-foreground">
                    {a.comment}
                  </blockquote>
                ) : null}
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Version <span className="fc-num">{a.documentVersion ?? '—'}</span>
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="fc-num font-mono underline decoration-dotted underline-offset-2"
                        aria-label="Show full document hash"
                      >
                        {shortHash(a.documentHash)}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-72 break-all">{a.documentHash}</TooltipContent>
                  </Tooltip>
                  <span>IP {a.ip ?? '—'}</span>
                  <span>{formatDate(a.createdAt)}</span>
                </p>
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ---------------------------------------------------------------------------
// Collapsed earlier cycles
// ---------------------------------------------------------------------------
function PreviousCycles({
  previousInstances,
  earlierApprovals,
}: {
  previousInstances: InstanceDTO[]
  earlierApprovals: ApprovalDTO[]
}) {
  const [open, setOpen] = useState(false)
  if (previousInstances.length === 0 && earlierApprovals.length === 0) return null
  const cycles = [...new Set(earlierApprovals.map((a) => a.cycle))].sort((a, b) => b - a)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4 rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium hover:bg-accent">
        <span>
          Previous review cycles
          {earlierApprovals.length > 0 ? (
            <span className="ml-1.5 font-normal text-muted-foreground">
              ({earlierApprovals.length} decision{earlierApprovals.length === 1 ? '' : 's'})
            </span>
          ) : null}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        {previousInstances.map((inst) => (
          <div key={inst.id} className="mb-3 rounded-md border bg-muted/30 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge variant={INSTANCE_STATUS_META[inst.status]?.variant ?? 'secondary'}>
                {INSTANCE_STATUS_META[inst.status]?.label ?? inst.status}
              </StatusBadge>
              <span className="text-xs text-muted-foreground">
                {inst.workflowName} · cycle {inst.cycle} · submitted {formatDateOnly(inst.submittedAt)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
             {returnCountLine(inst)} Completed {formatDateOnly(inst.completedAt) ?? '—'}
            </p>
          </div>
        ))}
        {cycles.map((cycle) => (
          <div key={cycle} className="mb-3 last:mb-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Cycle {cycle}</p>
            <ul className="mt-1.5 space-y-2">
              {earlierApprovals
                .filter((a) => a.cycle === cycle)
                .map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <StatusBadge variant={ACTION_META[a.action].variant}>{ACTION_META[a.action].label}</StatusBadge>
                    <span className="font-medium">{a.userName}</span>
                    <span className="text-muted-foreground">at {a.stageName}</span>
                    {a.comment ? <span className="text-muted-foreground">“{a.comment}”</span> : null}
                    <span className="text-muted-foreground">{formatDateOnly(a.createdAt)}</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function returnCountLine(inst: InstanceDTO): string {
  return inst.returnCount > 0 ? `${inst.returnCount} return${inst.returnCount === 1 ? '' : 's'} · ` : ''
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------
function ExceptionsList({ exceptions }: { exceptions: ExceptionDTO[] }) {
  return (
    <ul className="space-y-3">
      {exceptions.map((x) => {
        const severity = SEVERITY_META[x.severity] ?? SEVERITY_META.LOW
        const tone =
          x.severity === 'HIGH' || x.severity === 'CRITICAL'
            ? 'border-l-red-500 bg-red-500/5'
            : x.severity === 'MEDIUM'
              ? 'border-l-amber-500 bg-amber-500/5'
              : 'border-l-zinc-400'
        return (
          <li key={x.id} className={`rounded-r-lg border-l-4 p-3 ${tone}`}>
            <div className="flex flex-wrap items-center gap-2">
              <ShieldAlert
                className={`h-4 w-4 ${
                  x.severity === 'HIGH' || x.severity === 'CRITICAL'
                    ? 'text-red-600'
                    : x.severity === 'MEDIUM'
                      ? 'text-amber-600'
                      : 'text-muted-foreground'
                }`}
                aria-hidden
              />
              <p className="text-sm font-medium">{exceptionLabel(x.type)}</p>
              <StatusBadge variant={severity.variant}>{severity.label}</StatusBadge>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{x.message}</p>
            <p className="mt-1 text-xs text-muted-foreground">Detected {formatDate(x.detectedAt)}</p>
            {x.resolvedAt ? (
              <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
                Resolved {formatDateOnly(x.resolvedAt)} — {x.resolution ?? ''}
              </p>
            ) : (
              <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">Unresolved</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Versions table
// ---------------------------------------------------------------------------
function VersionsTable({ docId, versions, currentVersion }: { docId: string; versions: DocumentDetailDTO['versions']; currentVersion: number }) {
  const copyHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash)
      toast.success('SHA-256 hash copied to clipboard.')
    } catch {
      toast.error('Could not copy the hash — clipboard unavailable.')
    }
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Version</TableHead>
            <TableHead className="min-w-44">File</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead className="min-w-40">SHA-256</TableHead>
            <TableHead className="min-w-32">Uploaded by</TableHead>
            <TableHead className="min-w-36">Date</TableHead>
            <TableHead className="min-w-40">Note</TableHead>
            <TableHead className="w-24 text-right">Download</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((v) => {
            const isPdf = v.mimeType === 'application/pdf'
            return (
              <TableRow key={v.id}>
                <TableCell className="fc-num font-medium">
                  v{v.version}
                  {v.version === currentVersion ? (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      latest
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="max-w-52">
                  <p className="truncate font-medium">{v.fileName}</p>
                  <p className="text-xs text-muted-foreground">{v.mimeType}</p>
                </TableCell>
                <TableCell className="fc-num text-right text-muted-foreground">{formatBytes(v.sizeBytes)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="fc-num font-mono text-xs">{shortHash(v.sha256)}</span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-72 break-all">{v.sha256}</TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      aria-label={`Copy SHA-256 of version ${v.version}`}
                      onClick={() => void copyHash(v.sha256)}
                    >
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{v.uploadedByName}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(v.createdAt)}</TableCell>
                <TableCell className="max-w-52">
                  <p className="truncate text-xs text-muted-foreground">{v.note ?? '—'}</p>
                </TableCell>
                <TableCell className="text-right">
                  <a
                    href={`/api/documents/${docId}/download?version=${v.version}`}
                    target={isPdf ? '_blank' : undefined}
                    rel="noreferrer"
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Download
                  </a>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Submit dialog (draft) — mirrors the My Requests flow
// ---------------------------------------------------------------------------
function SubmitDialog({
  open,
  onOpenChange,
  doc,
  meta,
  onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  doc: DocumentSummaryDTO | null
  meta: MetaDTO | null
  onDone: () => void
}) {
  const [justification, setJustification] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const category = meta?.categories.find((c) => c.id === doc?.categoryId) ?? null
  const required = category?.requiredEvidence ?? []
  const provided = doc?.evidenceProvided ?? []
  const missing = required.filter((r) => !provided.includes(r))
  const workflow = doc ? matchWorkflow(meta, doc.categoryId, doc.amount) : null

  useEffect(() => {
    if (open) {
      setJustification(doc?.evidenceJustification ?? '')
      setError(null)
      setBusy(false)
    }
  }, [open, doc])

  const confirm = async () => {
    if (!doc) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ ok: true; steps: number }>(`/api/documents/${doc.id}/submit`, {
        evidenceJustification: justification.trim() || null,
      })
      toast.success(`${doc.reference} submitted for approval — workflow started with ${res.steps} step${res.steps === 1 ? '' : 's'}.`)
      onDone()
    } catch (err) {
      const message = errMessage(err, 'Submission failed.')
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  if (!doc) return null

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Submit for Approval"
      description={`${doc.reference} — ${doc.title}`}
      confirmLabel="Submit for Approval"
      loading={busy}
      onConfirm={() => void confirm()}
    >
      {error ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {required.length > 0 ? (
        <ul className="space-y-1.5">
          {required.map((item) => {
            const ok = provided.includes(item)
            return (
              <li key={item} className="flex items-center gap-2 text-sm">
                {ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden />
                )}
                <span>{item}</span>
                <span className={ok ? 'text-xs text-muted-foreground' : 'text-xs font-medium text-red-600'}>
                  {ok ? 'attached' : 'missing'}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {missing.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="detail-submit-justification">Justification on record</Label>
          <Textarea
            id="detail-submit-justification"
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            rows={3}
            placeholder="No justification is on record — submission will be blocked unless evidence is attached."
          />
          <p className="text-xs text-muted-foreground">
            Recorded when the request was created. Without it, the evidence control rejects the submission.
          </p>
        </div>
      ) : null}
      <div className="mt-3 rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
        {workflow ? (
          <>
            Workflow: <span className="font-medium text-foreground">{workflow.name}</span> ({workflow.stageCount}{' '}
            stage{workflow.stageCount === 1 ? '' : 's'})
          </>
        ) : (
          <span className="text-amber-600 dark:text-amber-400">
            No active workflow matches this category and amount — the server will reject the submission.
          </span>
        )}
      </div>
    </ConfirmDialog>
  )
}

// ---------------------------------------------------------------------------
// Upload version dialog (returned-for-correction flow)
// ---------------------------------------------------------------------------
function UploadVersionDialog({
  open,
  onOpenChange,
  doc,
  onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  doc: DocumentSummaryDTO | null
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setNote('')
      setFile(null)
      setFileKey((k) => k + 1)
      setError(null)
      setBusy(false)
    }
  }, [open])

  const submit = async () => {
    if (!doc) return
    if (!file) {
      setError('Select the corrected file to upload.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.set('file', file)
      if (note.trim()) form.set('note', note.trim())
      const res = await api.upload<{ version: { version: number } }>(`/api/documents/${doc.id}/versions`, form)
      toast.success(`Version ${res.version.version} of ${doc.reference} uploaded.`)
      onDone()
    } catch (err) {
      const message = errMessage(err, 'Upload failed.')
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  if (!doc) return null

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Upload Corrected Version"
      description={`${doc.reference} — replaces version v${doc.currentVersion} after review feedback.`}
      confirmLabel="Upload Version"
      loading={busy}
      onConfirm={() => void submit()}
    >
      {error ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="detail-ver-file">Corrected file</Label>
          <Input
            key={fileKey}
            id="detail-ver-file"
            type="file"
            accept=".pdf,.docx,.xlsx,.png,.jpg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-muted-foreground">PDF, DOCX, XLSX, PNG or JPG — max 10 MB.</p>
          {file ? (
            <p className="text-xs text-muted-foreground">
              Selected: <span className="font-medium text-foreground">{file.name}</span> ({formatBytes(file.size)})
            </p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="detail-ver-note">Note (optional)</Label>
          <Textarea
            id="detail-ver-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="e.g. Corrected totals per reviewer comment"
          />
        </div>
      </div>
    </ConfirmDialog>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------
export function RequestDetailView() {
  const { user, documentId, dataVersion, navigate, bumpData } = useFlowControlStore()
  const [meta, setMeta] = useState<MetaDTO | null>(null)
  const [data, setData] = useState<DocumentDetailDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Decision dialog state
  const [decision, setDecision] = useState<{ action: ApprovalAction; stageId: string; stageName: string } | null>(null)
  const [decisionComment, setDecisionComment] = useState('')
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Other dialogs
  const [submitOpen, setSubmitOpen] = useState(false)
  const [resubmitOpen, setResubmitOpen] = useState(false)
  const [resubmitError, setResubmitError] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [suspendMode, setSuspendMode] = useState<null | 'suspend' | 'resume'>(null)
  const [suspendReason, setSuspendReason] = useState('')
  const [suspendError, setSuspendError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<MetaDTO>('/api/meta')
      .then((m) => {
        if (!cancelled) setMeta(m)
      })
      .catch(() => {
        /* dialogs degrade gracefully without meta */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!documentId) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await api.get<DocumentDetailDTO>(`/api/documents/${documentId}`)
        if (!cancelled) {
          setData(res)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setData(null)
          setError(errMessage(err, 'Failed to load the request.'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [documentId, dataVersion])

  // ---------------------------------------------------------------- guards
  if (!documentId) {
    return (
      <EmptyState
        title="No document selected"
        description="Open a request from a list to view its detail and approval status."
        action={
          <Button variant="outline" size="sm" onClick={() => navigate('my-requests')}>
            Go to My Requests
          </Button>
        }
      />
    )
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Skeleton className="h-72" />
            <Skeleton className="h-52" />
            <Skeleton className="h-40" />
          </div>
          <Skeleton className="h-64" />
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('my-requests')}>
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
          Back to list
        </Button>
        <EmptyState
          title="Request unavailable"
          description={error ?? 'The request could not be loaded.'}
          action={
            <Button variant="outline" size="sm" onClick={bumpData}>
              Retry
            </Button>
          }
        />
      </div>
    )
  }

  // ---------------------------------------------------------------- derived
  const doc = data.document
  const latestInstance: InstanceDTO | null = data.instances.length > 0 ? data.instances[data.instances.length - 1] : null
  const previousInstances = data.instances.slice(0, -1)
  const cycle = latestInstance?.cycle ?? 1
  const cycleApprovals = data.approvals.filter((a) => a.cycle === cycle)
  const earlierApprovals = data.approvals.filter((a) => a.cycle < cycle)
  const lastReturn = [...data.approvals].reverse().find((a) => a.action === 'RETURN_FOR_CORRECTION') ?? null
  const canDecide =
    data.eligibleStages.length > 0 && latestInstance?.status === 'IN_PROGRESS' && data.activeInstanceId !== null
  const currentStageLabel =
    data.permissions.currentStage ??
    (latestInstance ? latestInstance.stagePath[latestInstance.currentStep]?.stages.map((s) => s.name).join(' + ') ?? null : null)
  const showSuspendCard =
    user?.role === 'SUPER_ADMIN' && latestInstance !== null && (latestInstance.status === 'IN_PROGRESS' || latestInstance.status === 'SUSPENDED')
  const creatorNoInstance = doc.createdById === user?.id && data.instances.length === 0

  // ---------------------------------------------------------------- actions
  const closeDecision = () => {
    setDecision(null)
    setDecisionComment('')
    setDecisionError(null)
  }

  const act = async () => {
    if (!decision || !data.activeInstanceId) return
    const comment = decisionComment.trim()
    if (decision.action === 'RETURN_FOR_CORRECTION' && comment.length < 3) {
      setDecisionError('A comment is required when requesting changes.')
      return
    }
    if (decision.action === 'COMMENT' && comment.length < 3) {
      setDecisionError('Write the comment to be recorded.')
      return
    }
    setBusy(true)
    setDecisionError(null)
    try {
      const res = await api.post<{ ok: true; message: string }>(`/api/approvals/${data.activeInstanceId}/act`, {
        action: decision.action,
        comment: comment || undefined,
        confirm: true,
        stageId: decision.stageId,
        expectedStep: latestInstance ? latestInstance.currentStep : undefined,
      })
      toast.success(res.message)
      closeDecision()
      bumpData()
    } catch (err) {
      const message = errMessage(err, 'The decision could not be recorded.')
      setDecisionError(message)
      toast.error(message)
      bumpData()
    } finally {
      setBusy(false)
    }
  }

  const resubmit = async () => {
    setResubmitError(null)
    setBusy(true)
    try {
      const res = await api.post<{ ok: true; steps: number }>(`/api/documents/${doc.id}/submit`)
      toast.success(`${doc.reference} resubmitted — cycle ${cycle + 1} starts at step 1 of ${res.steps}.`)
      setResubmitOpen(false)
      bumpData()
    } catch (err) {
      const message = errMessage(err, 'Resubmission failed.')
      setResubmitError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  const cancelRequest = async () => {
    if (cancelReason.trim().length < 3) {
      setCancelError('Provide a reason (at least 3 characters) — it is recorded in the audit trail.')
      return
    }
    setBusy(true)
    setCancelError(null)
    try {
      const res = await api.post<{ ok: true; message: string }>(`/api/documents/${doc.id}/cancel`, {
        reason: cancelReason.trim(),
      })
      toast.success(res.message)
      setCancelOpen(false)
      setCancelReason('')
      bumpData()
    } catch (err) {
      const message = errMessage(err, 'Cancellation failed.')
      setCancelError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  const suspendOrResume = async () => {
    if (!suspendMode) return
    if (suspendReason.trim().length < 3) {
      setSuspendError('Provide a reason (at least 3 characters).')
      return
    }
    setBusy(true)
    setSuspendError(null)
    try {
      const res = await api.post<{ ok: true; message: string }>(`/api/documents/${doc.id}/suspend`, {
        suspend: suspendMode === 'suspend',
        reason: suspendReason.trim(),
      })
      toast.success(res.message)
      setSuspendMode(null)
      setSuspendReason('')
      bumpData()
    } catch (err) {
      const message = errMessage(err, 'The operation failed.')
      setSuspendError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  const decisionCopy: Record<ApprovalAction, { title: string; verb: string; confirm: string }> = {
    APPROVE: { title: 'Confirm Approval', verb: 'approval', confirm: 'Confirm Approval' },
    REJECT: { title: 'Confirm Rejection', verb: 'rejection', confirm: 'Confirm Rejection' },
    RETURN_FOR_CORRECTION: { title: 'Request Changes', verb: 'return for correction', confirm: 'Request Changes' },
    COMMENT: { title: 'Record Comment', verb: 'comment', confirm: 'Record Comment' },
  }

  // ---------------------------------------------------------------- render
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => navigate('my-requests')}>
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
          Back to list
        </Button>
        <PageHeader
          title={doc.reference}
          description={doc.title}
          actions={
            <div className="text-right">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Amount</p>
              <p className="fc-num text-2xl font-semibold">{formatAmount(doc.amount, doc.currency)}</p>
              <p className="text-xs text-muted-foreground">Version v{doc.currentVersion}</p>
            </div>
          }
        />
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            {doc.categoryName} · {doc.departmentName}
            {doc.supplierName ? ` · Supplier: ${doc.supplierName}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            Created by {doc.createdByName} on {formatDateOnly(doc.createdAt)} · last change {formatDate(doc.updatedAt)}
          </p>
          {doc.description ? <p className="max-w-3xl text-sm text-muted-foreground">{doc.description}</p> : null}
          {doc.evidenceProvided.length > 0 ? (
            <p className="text-xs text-muted-foreground">Evidence on file: {doc.evidenceProvided.join(', ')}</p>
          ) : null}
          {doc.evidenceJustification ? (
            <p className="max-w-3xl text-xs text-muted-foreground">
              Evidence justification: “{doc.evidenceJustification}”
            </p>
          ) : null}
        </div>
      </div>

      {/* Status row */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
          <StatusBadge variant={DOCUMENT_STATUS_META[doc.status].variant}>
            {DOCUMENT_STATUS_META[doc.status].label}
          </StatusBadge>
          {latestInstance ? (
            <StatusBadge variant={INSTANCE_STATUS_META[latestInstance.status].variant}>
              Workflow: {INSTANCE_STATUS_META[latestInstance.status].label}
            </StatusBadge>
          ) : (
            <StatusBadge variant="secondary">No workflow started</StatusBadge>
          )}
          {currentStageLabel ? (
            <Badge variant="outline" className="font-normal">
              Stage: {currentStageLabel}
            </Badge>
          ) : null}
          {latestInstance && cycle > 1 ? (
            <StatusBadge variant="warning">
              Review cycle {cycle} of {cycle}
            </StatusBadge>
          ) : null}
          {latestInstance?.escalatedAt ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              SLA escalated {timeAgo(latestInstance.escalatedAt)}
            </span>
          ) : null}
          {latestInstance?.suspensionReason ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Suspended — {latestInstance.suspensionReason}
            </span>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* LEFT column */}
        <div className="space-y-4 lg:col-span-2">
          {latestInstance ? (
            <SectionCard
              title="Approval Workflow"
              description={`${latestInstance.workflowName} · submitted ${formatDate(latestInstance.submittedAt)}`}
              actions={
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  {latestInstance.stagePath.length} step{latestInstance.stagePath.length === 1 ? '' : 's'}
                </Badge>
              }
            >
              {latestInstance.status === 'SUSPENDED' ? (
                <Alert variant="destructive" className="mb-4">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  <AlertDescription>
                    Workflow suspended by administration. {latestInstance.suspensionReason ?? ''}
                  </AlertDescription>
                </Alert>
              ) : null}
              <StepTimeline instance={latestInstance} cycleApprovals={cycleApprovals} />
              <PreviousCycles previousInstances={previousInstances} earlierApprovals={earlierApprovals} />
            </SectionCard>
          ) : (
            <SectionCard title="Approval Workflow" description="No workflow has been started for this request yet.">
              <EmptyState
                title="Not yet submitted"
                description="The approval workflow appears once the request is submitted for approval."
              />
            </SectionCard>
          )}

          <SectionCard
            title="Approval History"
            description={
              data.approvals.length > 0
                ? `${data.approvals.length} recorded decision${data.approvals.length === 1 ? '' : 's'} — every entry is hash-bound and tamper-evident.`
                : 'Decisions recorded by approvers appear here.'
            }
            contentClassName="max-h-[460px] overflow-y-auto fc-scroll"
          >
            {data.approvals.length === 0 ? (
              <EmptyState title="No decisions yet" description="No approver has acted on this request so far." />
            ) : (
              <ApprovalHistoryTimeline approvals={data.approvals} />
            )}
          </SectionCard>

          <SectionCard
            title="Document Versions"
            description={`${data.versions.length} immutable version${data.versions.length === 1 ? '' : 's'} stored in the vault.`}
          >
            {data.versions.length === 0 ? (
              <EmptyState title="No versions" />
            ) : (
              <VersionsTable docId={doc.id} versions={data.versions} currentVersion={doc.currentVersion} />
            )}
          </SectionCard>

          {data.exceptions.length > 0 ? (
            <SectionCard
              title="Control Exceptions"
              description="Internal-control flags raised on this request (SoD, thresholds, monitoring)."
            >
              <ExceptionsList exceptions={data.exceptions} />
            </SectionCard>
          ) : null}
        </div>

        {/* RIGHT column — action panel */}
        <div className="space-y-4">
          {canDecide && data.activeInstanceId ? (
            <SectionCard
              title="Your Decision"
              description={`Stage${data.eligibleStages.length === 1 ? '' : 's'} awaiting your action at step ${latestInstance ? latestInstance.currentStep + 1 : '—'}.`}
            >
              <div className="space-y-3">
                {data.eligibleStages.map((es) => (
                  <div key={es.stageId} className="rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-tight">{es.name}</p>
                      <Badge variant={es.isRequired ? 'default' : 'secondary'} className="shrink-0 text-[10px]">
                        {es.isRequired ? 'Required' : 'Optional'}
                      </Badge>
                    </div>
                    {es.delegatedFromName ? (
                      <p className="mt-1 text-xs text-muted-foreground">via delegation from {es.delegatedFromName}</p>
                    ) : null}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        size="sm"
                        className="bg-emerald-600 text-white hover:bg-emerald-700"
                        onClick={() => {
                          setDecision({ action: 'APPROVE', stageId: es.stageId, stageName: es.name })
                          setDecisionComment('')
                          setDecisionError(null)
                        }}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setDecision({ action: 'REJECT', stageId: es.stageId, stageName: es.name })
                          setDecisionComment('')
                          setDecisionError(null)
                        }}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setDecision({ action: 'RETURN_FOR_CORRECTION', stageId: es.stageId, stageName: es.name })
                          setDecisionComment('')
                          setDecisionError(null)
                        }}
                      >
                        <CornerUpLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        Request Changes
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setDecision({ action: 'COMMENT', stageId: es.stageId, stageName: es.name })
                          setDecisionComment('')
                          setDecisionError(null)
                        }}
                      >
                        <MessageSquare className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        Comment
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                Decisions are bound to the exact document version and hash, then written to the tamper-evident audit
                trail.
              </p>
            </SectionCard>
          ) : null}

          {latestInstance?.status === 'RETURNED_FOR_CORRECTION' && data.permissions.canManage ? (
            <SectionCard
              title="Returned for Correction"
              description={`The requester must correct and resubmit. Attempt ${latestInstance.returnCount}.`}
            >
              {lastReturn ? (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-sm font-medium">
                    Returned by {lastReturn.userName} at {lastReturn.stageName}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(lastReturn.createdAt)}</p>
                  {lastReturn.comment ? (
                    <blockquote className="mt-2 border-l-2 pl-2.5 text-sm italic text-muted-foreground">
                      {lastReturn.comment}
                    </blockquote>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">No correction instructions were provided.</p>
                  )}
                </div>
              ) : null}
              <div className="mt-3 grid gap-2">
                <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
                  <FileUp className="mr-2 h-4 w-4" aria-hidden />
                  Upload corrected version
                </Button>
                <Button size="sm" onClick={() => {
                  setResubmitOpen(true)
                  setResubmitError(null)
                }}>
                  <Send className="mr-2 h-4 w-4" aria-hidden />
                  Resubmit
                </Button>
              </div>
            </SectionCard>
          ) : null}

          {data.permissions.canSubmit && doc.status === 'DRAFT' ? (
            <SectionCard title="Submit for Approval" description="The draft is complete — start the review workflow.">
              <Button size="sm" className="w-full" onClick={() => setSubmitOpen(true)}>
                <Send className="mr-2 h-4 w-4" aria-hidden />
                Submit for Approval
              </Button>
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                Submission is checked against the mandatory evidence list of the category and the matching workflow.
              </p>
            </SectionCard>
          ) : null}

          {data.permissions.canCancel ? (
            <SectionCard title="Danger Zone" description="Irreversible actions recorded in the audit trail.">
              <Button size="sm" variant="destructive" className="w-full" onClick={() => {
                setCancelOpen(true)
                setCancelError(null)
              }}>
                <Ban className="mr-2 h-4 w-4" aria-hidden />
                Cancel request
              </Button>
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                Cancellation is possible before any decisive approval has been recorded.
              </p>
            </SectionCard>
          ) : null}

          {showSuspendCard && latestInstance ? (
            <SectionCard
              title="Workflow Administration"
              description="Suspend or resume the active workflow instance (admin only)."
            >
              {latestInstance.status === 'SUSPENDED' ? (
                <>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Currently suspended: “{latestInstance.suspensionReason ?? '—'}”
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setSuspendMode('resume')
                      setSuspendReason('')
                      setSuspendError(null)
                    }}
                  >
                    Resume workflow
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full"
                  onClick={() => {
                    setSuspendMode('suspend')
                    setSuspendReason('')
                    setSuspendError(null)
                  }}
                >
                  Suspend workflow
                </Button>
              )}
            </SectionCard>
          ) : null}

          {creatorNoInstance && !(data.permissions.canSubmit && doc.status === 'DRAFT') ? (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              You created this request. No review workflow has been started for it yet.
            </p>
          ) : null}

          {!canDecide &&
          !data.permissions.canSubmit &&
          !data.permissions.canCancel &&
          !showSuspendCard &&
          !(latestInstance?.status === 'RETURNED_FOR_CORRECTION' && data.permissions.canManage) &&
          !creatorNoInstance ? (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              No actions are available for your role on this request. The detail below remains fully auditable.
            </p>
          ) : null}
        </div>
      </div>

      {/* ------------------------------------------------------------- dialogs */}
      <ConfirmDialog
        open={decision !== null}
        onOpenChange={(o) => (o ? null : closeDecision())}
        title={decision ? decisionCopy[decision.action].title : ''}
        description={decision ? `${doc.reference} — ${doc.title}` : undefined}
        confirmLabel={decision ? decisionCopy[decision.action].confirm : ''}
        destructive={decision?.action === 'REJECT'}
        loading={busy}
        onConfirm={() => void act()}
      >
        {decisionError ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{decisionError}</AlertDescription>
          </Alert>
        ) : null}
        {decision ? (
          <>
            <p className="text-sm leading-relaxed">
              Do you confirm {decisionCopy[decision.action].verb} of <span className="font-medium">{doc.reference}</span>{' '}
              at stage “{decision.stageName}”? This decision is legally traceable and recorded in the audit trail.
            </p>
            <div className="mt-3 grid gap-1.5">
              <Label htmlFor="decision-comment">
                Comment{' '}
                {decision.action === 'RETURN_FOR_CORRECTION'
                  ? '(required)'
                  : decision.action === 'REJECT'
                    ? '(recommended)'
                    : '(optional)'}
              </Label>
              <Textarea
                id="decision-comment"
                value={decisionComment}
                onChange={(e) => setDecisionComment(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={
                  decision.action === 'APPROVE'
                    ? 'e.g. Verified against the approved budget line.'
                    : 'Explain the reason or the corrections requested…'
                }
              />
            </div>
          </>
        ) : null}
      </ConfirmDialog>

      <SubmitDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        doc={doc}
        meta={meta}
        onDone={() => {
          setSubmitOpen(false)
          bumpData()
        }}
      />

      <ConfirmDialog
        open={resubmitOpen}
        onOpenChange={(o) => {
          if (!o) {
            setResubmitOpen(false)
            setResubmitError(null)
          }
        }}
        title="Resubmit for Approval"
        description={`${doc.reference} — ${doc.title}`}
        confirmLabel="Resubmit"
        loading={busy}
        onConfirm={() => void resubmit()}
      >
        {resubmitError ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{resubmitError}</AlertDescription>
          </Alert>
        ) : null}
        <p className="text-sm leading-relaxed">
          The corrected version v{doc.currentVersion} starts a new review cycle (cycle {cycle + 1}) from step 1. The
          full decision history is preserved.
        </p>
        {lastReturn?.comment ? (
          <blockquote className="mt-2 border-l-2 pl-2.5 text-xs italic text-muted-foreground">
            Original request: {lastReturn.comment}
          </blockquote>
        ) : null}
      </ConfirmDialog>

      <UploadVersionDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        doc={doc}
        onDone={() => {
          setUploadOpen(false)
          bumpData()
        }}
      />

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(o) => {
          if (!o) {
            setCancelOpen(false)
            setCancelError(null)
          }
        }}
        title="Cancel Request"
        description={`${doc.reference} — ${doc.title}`}
        confirmLabel="Cancel Request"
        destructive
        loading={busy}
        onConfirm={() => void cancelRequest()}
      >
        {cancelError ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{cancelError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="detail-cancel-reason">Reason</Label>
          <Textarea
            id="detail-cancel-reason"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="e.g. Duplicate request; supplier withdrew the offer"
          />
          <p className="text-xs text-muted-foreground">The reason is recorded in the audit trail. This cannot be undone.</p>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={suspendMode !== null}
        onOpenChange={(o) => {
          if (!o) {
            setSuspendMode(null)
            setSuspendError(null)
          }
        }}
        title={suspendMode === 'suspend' ? 'Suspend Workflow' : 'Resume Workflow'}
        description={`${doc.reference} — ${doc.title}`}
        confirmLabel={suspendMode === 'suspend' ? 'Suspend' : 'Resume'}
        destructive={suspendMode === 'suspend'}
        loading={busy}
        onConfirm={() => void suspendOrResume()}
      >
        {suspendError ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{suspendError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="detail-suspend-reason">Reason</Label>
          <Textarea
            id="detail-suspend-reason"
            value={suspendReason}
            onChange={(e) => setSuspendReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="e.g. Pending internal investigation"
          />
        </div>
      </ConfirmDialog>
    </div>
  )
}
