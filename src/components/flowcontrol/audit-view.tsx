// ============================================================================
// FlowControl — Internal Audit Dashboard
//
// Auditor / administrator view: control exception monitoring, failed login
// analysis, tamper-evident audit trail exploration and hash-chain integrity
// verification with an externally publishable chain anchor.
// ============================================================================

'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { api, qs } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import {
  formatDate,
  timeAgo,
  shortHash,
  exceptionLabel,
  SEVERITY_META,
  EXCEPTION_TYPE_LABELS,
} from '@/lib/client/format'
import type { AuditEventDTO, AuditOverviewDTO, ChainVerificationDTO, ExceptionDTO, Paginated } from '@/types/flowcontrol'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { PageHeader, KpiCard, SectionCard, EmptyState, LoadingState, TableSkeleton, ConfirmDialog } from './shared'
import { StatusBadge } from './status-badge'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  ListChecks,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from 'lucide-react'

// ---------------------------------------------------------------- helpers

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied to clipboard.`)
  } catch {
    toast.error('Clipboard unavailable — copy the value manually.')
  }
}

function JsonBlock({ value }: { value: unknown }) {
  let text: string
  if (value === null || value === undefined) {
    text = 'No detail payload.'
  } else if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  return (
    <pre className="max-h-64 overflow-auto fc-scroll rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
      {text}
    </pre>
  )
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null
  return (
    <div className="flex flex-col gap-2 pt-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        {total.toLocaleString('en-US')} record{total === 1 ? '' : 's'} · page {page} of {pages}
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

function DocumentLink({ reference, documentId }: { reference: string | null; documentId: string | null }) {
  if (!reference) return <span className="text-xs text-muted-foreground">—</span>
  if (documentId) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        onClick={(e) => {
          e.stopPropagation()
          useFlowControlStore.getState().openDocument(documentId)
        }}
      >
        {reference}
        <ExternalLink className="h-3 w-3" aria-hidden />
      </button>
    )
  }
  return <span className="text-xs">{reference}</span>
}

// ---------------------------------------------------------------- resolve dialog

function ResolveExceptionDialog({
  exception,
  open,
  onOpenChange,
  onResolved,
}: {
  exception: ExceptionDTO | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onResolved: () => void
}) {
  const [resolution, setResolution] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) setResolution('')
  }, [open])

  const submit = async () => {
    if (!exception) return
    const text = resolution.trim()
    if (text.length < 3 || text.length > 500) {
      toast.error('The resolution note must be between 3 and 500 characters.')
      return
    }
    setSubmitting(true)
    try {
      await api.post(`/api/audit/exceptions/${exception.id}/resolve`, { resolution: text })
      toast.success('Exception resolved and archived in the audit trail.')
      onOpenChange(false)
      onResolved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to resolve the exception.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Resolve control exception"
      description={exception ? `${exceptionLabel(exception.type)} — ${exception.message}` : undefined}
      confirmLabel="Resolve Exception"
      loading={submitting}
      onConfirm={() => void submit()}
    >
      <div className="space-y-1.5">
        <Label htmlFor="exception-resolution">Resolution note</Label>
        <Textarea
          id="exception-resolution"
          rows={3}
          placeholder="Corrective action taken, follow-up decision, risk acceptance…"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          The note and a timestamp are added to the exception record; the original detection is never rewritten.
        </p>
      </div>
    </ConfirmDialog>
  )
}

// ---------------------------------------------------------------- overview tab

function ChainIntegrityCard({ chain, onRerun, verifying }: { chain: ChainVerificationDTO | null; onRerun: () => void; verifying: boolean }) {
  if (!chain) return <LoadingState rows={2} />
  return (
    <SectionCard
      title="Audit Chain Integrity"
      description="Every audit event is hash-chained; verification recomputes the full chain."
      actions={
        <Button variant="outline" size="sm" onClick={onRerun} disabled={verifying}>
          <RefreshCw className={cn('mr-2 h-4 w-4', verifying && 'animate-spin')} />
          Re-run verification
        </Button>
      }
    >
      <div className="space-y-3">
        {chain.valid ? (
          <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/50">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <div>
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                Chain verified — {chain.eventCount.toLocaleString('en-US')} events, no tampering detected
              </p>
              <p className="mt-0.5 text-xs text-emerald-700/80 dark:text-emerald-400/80">
                Last verified {timeAgo(chain.verifiedAt)}.
              </p>
            </div>
          </div>
        ) : (
          <Alert variant="destructive">
            <ShieldX className="h-4 w-4" aria-hidden />
            <AlertTitle>
              Chain BROKEN{chain.firstBrokenSeq !== null ? ` at seq #${chain.firstBrokenSeq}` : ''}
            </AlertTitle>
            <AlertDescription>
              <p className="text-xs">
                Hash-chain verification failed — audit records may have been altered or deleted. Escalate immediately.
              </p>
              {chain.issues.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs">
                  {chain.issues.map((issue) => (
                    <li key={issue.seq} className="fc-num">
                      #{issue.seq}: {issue.problem}
                    </li>
                  ))}
                </ul>
              ) : null}
            </AlertDescription>
          </Alert>
        )}

        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Chain anchor (latest hash)</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 overflow-x-auto fc-scroll rounded-md bg-muted px-3 py-2 font-mono text-[11px] break-all">
              {chain.latestHash ?? '— no events yet —'}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={!chain.latestHash}
              onClick={() => chain.latestHash && void copyText(chain.latestHash, 'Anchor hash')}
              aria-label="Copy anchor hash"
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy anchor hash
            </Button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Publish this hash externally (WORM storage / log archive) to anchor the chain against database-level
            tampering.
          </p>
        </div>
      </div>
    </SectionCard>
  )
}

function OverviewTab() {
  const { user, dataVersion, bumpData } = useFlowControlStore()
  const [data, setData] = useState<AuditOverviewDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [resolveTarget, setResolveTarget] = useState<ExceptionDTO | null>(null)
  const isAdmin = user?.role === 'SUPER_ADMIN'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.get<AuditOverviewDTO>('/api/audit/overview')
      setData(result)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load the audit overview.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, dataVersion])

  const rerunVerification = async () => {
    setVerifying(true)
    try {
      const verification = await api.get<ChainVerificationDTO>('/api/audit/integrity')
      if (data) setData({ ...data, chain: verification })
      if (verification.valid) {
        toast.success(`Chain verified — ${verification.eventCount} events, no tampering detected.`)
      } else {
        toast.error(`Chain verification FAILED${verification.firstBrokenSeq ? ` at seq #${verification.firstBrokenSeq}` : ''}.`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Verification failed.')
    } finally {
      setVerifying(false)
    }
  }

  if (loading && !data) return <TableSkeleton />

  return (
    <div className="space-y-4">
      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Unresolved Exceptions"
              value={data.unresolvedExceptions}
              tone={data.unresolvedExceptions > 0 ? 'danger' : 'success'}
              hint="Open control findings"
              icon={<AlertTriangle className="h-5 w-5" />}
            />
            <KpiCard label="Failed Logins (24h)" value={data.failedLogins24h} tone="warning" hint="Recent authentication failures" icon={<KeyRound className="h-5 w-5" />} />
            <KpiCard label="Unauthorized Attempts" value={data.unauthorizedAttempts} tone="danger" hint="Access denied events" icon={<ShieldAlert className="h-5 w-5" />} />
            <KpiCard label="Audit Events" value={data.auditEventCount} hint="Total hash-chained events" icon={<ScrollText className="h-5 w-5" />} />
          </div>

          <ChainIntegrityCard chain={data.chain} verifying={verifying} onRerun={() => void rerunVerification()} />

          <SectionCard
            title="Unresolved Control Exceptions"
            description="Detected by the control monitors (SoD, thresholds, overdue stages, access violations)."
            contentClassName="max-h-96 overflow-y-auto fc-scroll"
            actions={<span className="text-xs text-muted-foreground">{data.exceptions.length} open</span>}
          >
            {data.exceptions.length === 0 ? (
              <EmptyState title="No unresolved exceptions" description="All monitored controls are currently clean." />
            ) : (
              <div className="space-y-2">
                {data.exceptions.map((x) => (
                  <Collapsible key={x.id} className="group rounded-lg border">
                    <div className="flex items-start justify-between gap-3 p-3">
                      <CollapsibleTrigger asChild>
                        <button type="button" className="min-w-0 flex-1 text-left" aria-label={`Toggle details for ${exceptionLabel(x.type)}`}>
                          <span className="flex flex-wrap items-center gap-2">
                            <StatusBadge variant={SEVERITY_META[x.severity].variant}>{SEVERITY_META[x.severity].label}</StatusBadge>
                            <span className="truncate text-sm font-medium">{exceptionLabel(x.type)}</span>
                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden />
                          </span>
                          <span className="mt-1 block truncate text-xs text-muted-foreground">{x.message}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            {x.documentReference ? (
                              <span className="font-medium">{x.documentReference}</span>
                            ) : (
                              <span>No linked document</span>
                            )}
                            {x.subjectEmail ? <span>Subject: {x.subjectEmail}</span> : null}
                            <span>Detected {timeAgo(x.detectedAt)}</span>
                          </span>
                        </button>
                      </CollapsibleTrigger>
                      {isAdmin && !x.resolvedAt ? (
                        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setResolveTarget(x)}>
                          Resolve
                        </Button>
                      ) : null}
                    </div>
                    <CollapsibleContent>
                      <div className="space-y-2 border-t px-3 pb-3 pt-3">
                        {x.documentReference ? (
                          <p className="text-xs">
                            <span className="text-muted-foreground">Linked document: </span>
                            <DocumentLink reference={x.documentReference} documentId={x.documentId} />
                          </p>
                        ) : null}
                        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Detection details</p>
                        <JsonBlock value={x.details} />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            )}
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard
              title="Failed Login Attempts (recent)"
              description="Last 30 authentication failures with lockout reasons."
              contentClassName="max-h-80 overflow-y-auto fc-scroll"
            >
              {data.failedLoginDetails.length === 0 ? (
                <EmptyState title="No failed logins" description="No authentication failures recorded recently." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>IP</TableHead>
                      <TableHead className="text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.failedLoginDetails.map((f, i) => (
                      <TableRow key={i}>
                        <TableCell className="max-w-40 truncate text-xs font-medium">{f.email}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{f.reason ?? '—'}</TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">{f.ip ?? '—'}</TableCell>
                        <TableCell className="text-right text-[11px] text-muted-foreground">{timeAgo(f.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </SectionCard>

            <SectionCard
              title="Audit Exports"
              description="Every export is itself recorded in the audit trail."
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <Button asChild variant="outline" size="sm">
                  <a href="/api/audit/export?format=csv&type=events" aria-label="Export audit events as CSV">
                    <Download className="mr-2 h-4 w-4" />
                    Events (CSV)
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href="/api/audit/export?format=json&type=events" aria-label="Export audit events as JSON">
                    <Download className="mr-2 h-4 w-4" />
                    Events (JSON)
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href="/api/audit/export?format=csv&type=exceptions" aria-label="Export control exceptions as CSV">
                    <Download className="mr-2 h-4 w-4" />
                    Exceptions (CSV)
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href="/api/audit/export?format=csv&type=logins" aria-label="Export login attempts as CSV">
                    <Download className="mr-2 h-4 w-4" />
                    Logins (CSV)
                  </a>
                </Button>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                Exports contain the full history (not filtered by the trail filters above). Chain the exported file
                against the anchor hash for long-term evidence.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border p-3 text-xs">
                <div>
                  <p className="font-medium">By type</p>
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    {Object.keys(data.exceptionsByType).length === 0 ? <li>No exceptions recorded</li> : null}
                    {Object.entries(data.exceptionsByType).map(([type, count]) => (
                      <li key={type} className="flex justify-between gap-2">
                        <span className="truncate">{exceptionLabel(type)}</span>
                        <span className="fc-num">{count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="font-medium">By severity</p>
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    {Object.keys(data.exceptionsBySeverity).length === 0 ? <li>No exceptions recorded</li> : null}
                    {Object.entries(data.exceptionsBySeverity).map(([severity, count]) => (
                      <li key={severity} className="flex justify-between gap-2">
                        <span>{SEVERITY_META[severity as keyof typeof SEVERITY_META]?.label ?? severity}</span>
                        <span className="fc-num">{count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </SectionCard>
          </div>
        </>
      ) : (
        <EmptyState title="Audit overview unavailable" />
      )}

      <ResolveExceptionDialog
        exception={resolveTarget}
        open={resolveTarget !== null}
        onOpenChange={(o) => {
          if (!o) setResolveTarget(null)
        }}
        onResolved={() => {
          setResolveTarget(null)
          void load()
          bumpData()
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------- audit trail tab

type TrailFilters = { action: string; actorEmail: string; entityType: string; from: string; to: string }

function TrailTab() {
  const [draft, setDraft] = useState<TrailFilters>({ action: '', actorEmail: '', entityType: '', from: '', to: '' })
  const [applied, setApplied] = useState<TrailFilters>(draft)
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Paginated<AuditEventDTO> | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const query = qs({ ...applied, page, pageSize: 25 })
        const data = await api.get<Paginated<AuditEventDTO>>(`/api/audit/events${query}`)
        if (!cancelled) setResult(data)
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load the audit trail.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [applied, page])

  const apply = () => {
    setPage(1)
    setApplied({ ...draft })
  }

  const reset = () => {
    const cleared = { action: '', actorEmail: '', entityType: '', from: '', to: '' }
    setDraft(cleared)
    setApplied(cleared)
    setPage(1)
  }

  return (
    <SectionCard
      title="Audit Trail"
      description="Every material system event, sequentially hash-chained. Click a row to inspect its payload."
    >
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        <div className="space-y-1">
          <Label htmlFor="trail-action" className="text-xs">Action</Label>
          <Input
            id="trail-action"
            placeholder="e.g. DOCUMENT_SUBMITTED"
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply()
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="trail-actor" className="text-xs">Actor email</Label>
          <Input
            id="trail-actor"
            placeholder="contains…"
            value={draft.actorEmail}
            onChange={(e) => setDraft({ ...draft, actorEmail: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply()
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="trail-entity" className="text-xs">Entity type</Label>
          <Input
            id="trail-entity"
            placeholder="document, user, workflow…"
            value={draft.entityType}
            onChange={(e) => setDraft({ ...draft, entityType: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply()
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="trail-from" className="text-xs">From</Label>
          <Input id="trail-from" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="trail-to" className="text-xs">To</Label>
          <Input id="trail-to" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </div>
        <div className="flex items-end gap-2">
          <Button size="sm" onClick={apply}>
            <ListChecks className="mr-2 h-4 w-4" />
            Apply
          </Button>
          <Button size="sm" variant="ghost" onClick={reset}>
            Reset
          </Button>
        </div>
      </div>

      <div className="mt-4">
        {loading && !result ? (
          <TableSkeleton />
        ) : !result || result.items.length === 0 ? (
          <EmptyState title="No audit events match the filters" description="Adjust or clear the filters to widen the search." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">Seq</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead className="w-32">Hash</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.items.map((e) => (
                    <Fragment key={e.seq}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpanded(expanded === e.seq ? null : e.seq)}
                        aria-expanded={expanded === e.seq}
                      >
                        <TableCell className="fc-num text-xs text-muted-foreground">#{e.seq}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{formatDate(e.occurredAt)}</TableCell>
                        <TableCell className="max-w-44">
                          <p className="truncate text-xs font-medium">{e.actorName ?? 'system'}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{e.actorEmail ?? '—'}</p>
                        </TableCell>
                        <TableCell className="text-xs font-medium">{e.action}</TableCell>
                        <TableCell className="max-w-40 text-xs text-muted-foreground">
                          <span className="truncate">{e.entityType ?? '—'}</span>
                          {e.entityId ? <span className="block truncate text-[11px] opacity-70">{e.entityId}</span> : null}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">{e.ip ?? '—'}</TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1">
                            <code className="font-mono text-[11px] text-muted-foreground">{shortHash(e.hash)}</code>
                            <button
                              type="button"
                              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                              aria-label={`Copy hash of event ${e.seq}`}
                              onClick={(ev) => {
                                ev.stopPropagation()
                                void copyText(e.hash, 'Event hash')
                              }}
                            >
                              <Copy className="h-3 w-3" aria-hidden />
                            </button>
                            <ChevronDown
                              className={cn('ml-auto h-4 w-4 text-muted-foreground transition-transform', expanded === e.seq && 'rotate-180')}
                              aria-hidden
                            />
                          </span>
                        </TableCell>
                      </TableRow>
                      {expanded === e.seq ? (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={7}>
                            <div className="grid gap-3 lg:grid-cols-2">
                              <div>
                                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Event details</p>
                                <JsonBlock value={e.details} />
                              </div>
                              <div className="space-y-2">
                                <div>
                                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Previous hash</p>
                                  <code className="mt-1 block overflow-x-auto fc-scroll rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] break-all">
                                    {e.prevHash || '—'}
                                  </code>
                                </div>
                                <div>
                                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">This event hash</p>
                                  <code className="mt-1 block overflow-x-auto fc-scroll rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] break-all">
                                    {e.hash}
                                  </code>
                                </div>
                                {e.actorRole ? (
                                  <p className="text-[11px] text-muted-foreground">
                                    Actor role at the time: <span className="font-medium text-foreground">{e.actorRole}</span>
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pager page={result.page} pages={result.pages} total={result.total} onPage={setPage} />
          </>
        )}
      </div>
    </SectionCard>
  )
}

// ---------------------------------------------------------------- exceptions tab

type ExceptionFilters = { type: string; severity: string; resolved: string }

function ExceptionsTab() {
  const { user, dataVersion } = useFlowControlStore()
  const isAdmin = user?.role === 'SUPER_ADMIN'
  const [draft, setDraft] = useState<ExceptionFilters>({ type: 'ALL', severity: 'ALL', resolved: 'UNRESOLVED' })
  const [applied, setApplied] = useState<ExceptionFilters>(draft)
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Paginated<ExceptionDTO> | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [resolveTarget, setResolveTarget] = useState<ExceptionDTO | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const query = qs({
          type: applied.type === 'ALL' ? '' : applied.type,
          severity: applied.severity === 'ALL' ? '' : applied.severity,
          resolved: applied.resolved === 'ALL' ? '' : applied.resolved === 'RESOLVED' ? 'true' : 'false',
          page,
          pageSize: 25,
        })
        const data = await api.get<Paginated<ExceptionDTO>>(`/api/audit/exceptions${query}`)
        if (!cancelled) setResult(data)
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load control exceptions.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [applied, page, dataVersion])

  const apply = () => {
    setPage(1)
    setApplied({ ...draft })
  }

  return (
    <SectionCard
      title="Control Exceptions"
      description="Segregation-of-duties, threshold, overdue and access-control findings."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="exc-type">Type</Label>
          <Select value={draft.type} onValueChange={(v) => setDraft({ ...draft, type: v })}>
            <SelectTrigger id="exc-type" size="sm" className="w-full">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All types</SelectItem>
              {Object.entries(EXCEPTION_TYPE_LABELS).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="exc-severity">Severity</Label>
          <Select value={draft.severity} onValueChange={(v) => setDraft({ ...draft, severity: v })}>
            <SelectTrigger id="exc-severity" size="sm" className="w-full">
              <SelectValue placeholder="All severities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All severities</SelectItem>
              <SelectItem value="LOW">Low</SelectItem>
              <SelectItem value="MEDIUM">Medium</SelectItem>
              <SelectItem value="HIGH">High</SelectItem>
              <SelectItem value="CRITICAL">Critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="exc-resolved">Status</Label>
          <Select value={draft.resolved} onValueChange={(v) => setDraft({ ...draft, resolved: v })}>
            <SelectTrigger id="exc-resolved" size="sm" className="w-full">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All</SelectItem>
              <SelectItem value="UNRESOLVED">Unresolved</SelectItem>
              <SelectItem value="RESOLVED">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button size="sm" onClick={apply}>
            <ListChecks className="mr-2 h-4 w-4" />
            Apply Filters
          </Button>
        </div>
      </div>

      <div className="mt-4">
        {loading && !result ? (
          <TableSkeleton />
        ) : !result || result.items.length === 0 ? (
          <EmptyState title="No exceptions match the filters" description="Control monitors run automatically when the audit dashboard opens." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Detected</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Document</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead className="max-w-52">Message</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.items.map((x) => (
                    <Fragment key={x.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpanded(expanded === x.id ? null : x.id)}
                        aria-expanded={expanded === x.id}
                      >
                        <TableCell className="whitespace-nowrap text-xs">{formatDate(x.detectedAt)}</TableCell>
                        <TableCell className="max-w-44 text-xs font-medium">
                          <span className="truncate">{exceptionLabel(x.type)}</span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge variant={SEVERITY_META[x.severity].variant}>{SEVERITY_META[x.severity].label}</StatusBadge>
                        </TableCell>
                        <TableCell>
                          <DocumentLink reference={x.documentReference} documentId={x.documentId} />
                        </TableCell>
                        <TableCell className="max-w-40 truncate text-xs text-muted-foreground">{x.subjectEmail ?? '—'}</TableCell>
                        <TableCell className="max-w-52 truncate text-xs text-muted-foreground">{x.message}</TableCell>
                        <TableCell>
                          {x.resolvedAt ? (
                            <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                              Resolved
                            </span>
                          ) : (
                            <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                              Unresolved
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                      {expanded === x.id ? (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={7}>
                            <div className="grid gap-3 lg:grid-cols-2">
                              <div>
                                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Detection details</p>
                                <JsonBlock value={x.details} />
                              </div>
                              <div className="space-y-2 text-xs">
                                <p className="text-muted-foreground">
                                  <span className="font-medium text-foreground">Document:</span>{' '}
                                  {x.documentReference ? `${x.documentReference}${x.documentTitle ? ` — ${x.documentTitle}` : ''}` : '—'}
                                </p>
                                <p className="text-muted-foreground">
                                  <span className="font-medium text-foreground">Subject:</span> {x.subjectName ?? '—'}
                                  {x.subjectEmail ? ` (${x.subjectEmail})` : ''}
                                </p>
                                <p className="text-muted-foreground">
                                  <span className="font-medium text-foreground">Detected:</span> {formatDate(x.detectedAt)} ({timeAgo(x.detectedAt)})
                                </p>
                                {x.resolvedAt ? (
                                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2.5 dark:border-emerald-900 dark:bg-emerald-950/50">
                                    <p className="font-medium text-emerald-700 dark:text-emerald-400">Resolution — {formatDate(x.resolvedAt)}</p>
                                    <p className="mt-1 text-emerald-700/90 dark:text-emerald-400/90">{x.resolution}</p>
                                  </div>
                                ) : isAdmin ? (
                                  <Button variant="outline" size="sm" onClick={() => setResolveTarget(x)}>
                                    Resolve Exception
                                  </Button>
                                ) : (
                                  <p className="text-[11px] text-muted-foreground">
                                    Resolution is restricted to administrators.
                                  </p>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pager page={result.page} pages={result.pages} total={result.total} onPage={setPage} />
          </>
        )}
      </div>

      <ResolveExceptionDialog
        exception={resolveTarget}
        open={resolveTarget !== null}
        onOpenChange={(o) => {
          if (!o) setResolveTarget(null)
        }}
        onResolved={() => {
          setResolveTarget(null)
          setPage(1)
          setApplied({ ...applied })
        }}
      />
    </SectionCard>
  )
}

// ---------------------------------------------------------------- main view

export function AuditView() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Internal Audit"
        description="Control exceptions, failed accesses and the tamper-evident audit trail with chain verification."
        actions={
          <span className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
            Monitors run automatically when this page opens
          </span>
        }
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="trail">Audit Trail</TabsTrigger>
          <TabsTrigger value="exceptions">Control Exceptions</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="trail" className="mt-4">
          <TrailTab />
        </TabsContent>
        <TabsContent value="exceptions" className="mt-4">
          <ExceptionsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
