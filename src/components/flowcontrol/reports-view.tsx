// ============================================================================
// FlowControl — Reporting Center
//
// Filterable aggregations over requests (department, category, stage
// durations) computed server-side for the selected scope, with CSV export of
// the underlying request list.
// ============================================================================

'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, qs } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import {
  formatAmount,
  formatHours,
  formatPercent,
  DOCUMENT_STATUS_META,
} from '@/lib/client/format'
import type { DashboardDTO, DocumentStatus, MetaDTO } from '@/types/flowcontrol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader, KpiCard, SectionCard, EmptyState, LoadingState } from './shared'
import { toast } from 'sonner'
import { Clock, Download, FileStack, FilterX, RotateCcw, Search } from 'lucide-react'

type ReportFilters = {
  from: string
  to: string
  departmentId: string
  categoryId: string
  status: string
  minAmount: string
  maxAmount: string
}

const EMPTY_FILTERS: ReportFilters = { from: '', to: '', departmentId: 'ALL', categoryId: 'ALL', status: 'ALL', minAmount: '', maxAmount: '' }

/** Translate filter state into the query parameters accepted by the API. */
function toQuery(f: ReportFilters): Record<string, string | undefined> {
  return {
    from: f.from || undefined,
    to: f.to || undefined,
    departmentId: f.departmentId === 'ALL' ? undefined : f.departmentId,
    categoryId: f.categoryId === 'ALL' ? undefined : f.categoryId,
    status: f.status === 'ALL' ? undefined : f.status,
    minAmount: f.minAmount === '' ? undefined : f.minAmount,
    maxAmount: f.maxAmount === '' ? undefined : f.maxAmount,
  }
}

function hasActiveFilters(f: ReportFilters): boolean {
  return Object.values(toQuery(f)).some((v) => v !== undefined)
}

export function ReportsView() {
  const { dataVersion } = useFlowControlStore()
  const [meta, setMeta] = useState<MetaDTO | null>(null)
  const [draft, setDraft] = useState<ReportFilters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<ReportFilters>(EMPTY_FILTERS)
  const [summary, setSummary] = useState<DashboardDTO | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .get<MetaDTO>('/api/meta')
      .then(setMeta)
      .catch(() => {
        // Filters stay limited to status/date/amount if metadata is unavailable.
      })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<DashboardDTO>(`/api/reports/summary${qs(toQuery(applied))}`)
      setSummary(data)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to compute the report.')
    } finally {
      setLoading(false)
    }
  }, [applied])

  useEffect(() => {
    void load()
  }, [load, dataVersion])

  const apply = () => {
    if (draft.minAmount !== '' && (isNaN(Number(draft.minAmount)) || Number(draft.minAmount) < 0)) {
      toast.error('The minimum amount must be a positive number.')
      return
    }
    if (draft.maxAmount !== '' && (isNaN(Number(draft.maxAmount)) || Number(draft.maxAmount) < 0)) {
      toast.error('The maximum amount must be a positive number.')
      return
    }
    if (draft.minAmount !== '' && draft.maxAmount !== '' && Number(draft.minAmount) > Number(draft.maxAmount)) {
      toast.error('The minimum amount cannot exceed the maximum amount.')
      return
    }
    setApplied({ ...draft })
  }

  const reset = () => {
    setDraft(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
  }

  const exportHref = `/api/reports/export${qs(toQuery(applied))}`
  const k = summary?.kpis
  const noData =
    summary !== null &&
    summary.kpis.totalRequests === 0 &&
    summary.byDepartment.length === 0 &&
    summary.byCategory.length === 0

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        description="Aggregated request analytics for your visibility scope, with CSV export."
      />

      {/* Filters */}
      <SectionCard title="Filters" description="All filters are optional — combine them to narrow the analysis.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <div className="space-y-1">
            <Label htmlFor="rep-from" className="text-xs">From</Label>
            <Input id="rep-from" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rep-to" className="text-xs">To</Label>
            <Input id="rep-to" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="rep-department">Department</Label>
            <Select value={draft.departmentId} onValueChange={(v) => setDraft({ ...draft, departmentId: v })}>
              <SelectTrigger id="rep-department" size="sm" className="w-full">
                <SelectValue placeholder="All departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All departments</SelectItem>
                {meta?.departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="rep-category">Category</Label>
            <Select value={draft.categoryId} onValueChange={(v) => setDraft({ ...draft, categoryId: v })}>
              <SelectTrigger id="rep-category" size="sm" className="w-full">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All categories</SelectItem>
                {meta?.categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="rep-status">Status</Label>
            <Select value={draft.status} onValueChange={(v) => setDraft({ ...draft, status: v })}>
              <SelectTrigger id="rep-status" size="sm" className="w-full">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {(Object.keys(DOCUMENT_STATUS_META) as DocumentStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {DOCUMENT_STATUS_META[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rep-min" className="text-xs">Min amount (MAD)</Label>
            <Input
              id="rep-min"
              type="number"
              min={0}
              placeholder="0"
              value={draft.minAmount}
              onChange={(e) => setDraft({ ...draft, minAmount: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rep-max" className="text-xs">Max amount (MAD)</Label>
            <Input
              id="rep-max"
              type="number"
              min={0}
              placeholder="No ceiling"
              value={draft.maxAmount}
              onChange={(e) => setDraft({ ...draft, maxAmount: e.target.value })}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button size="sm" onClick={apply}>
              <Search className="mr-2 h-4 w-4" />
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={reset} aria-label="Reset filters">
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset
            </Button>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Amounts are whole MAD units. The export reflects the applied filters and your data visibility scope.
        </p>
      </SectionCard>

      {/* Toolbar with export */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {summary
            ? `${summary.kpis.totalRequests.toLocaleString('en-US')} request(s) in scope${summary.scope === 'GLOBAL' ? ' — organization-wide' : ''}`
            : 'Computing…'}
        </p>
        <Button asChild variant="outline" size="sm" disabled={!summary}>
          <a href={exportHref} aria-label="Export the filtered request list as CSV">
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </a>
        </Button>
      </div>

      {loading && !summary ? (
        <LoadingState rows={6} />
      ) : !summary ? (
        <EmptyState title="Report unavailable" description="Unable to compute the report for the selected filters." />
      ) : noData ? (
        <EmptyState
          title={hasActiveFilters(applied) ? 'No data matches the filters' : 'No requests in scope yet'}
          description={
            hasActiveFilters(applied)
              ? 'Widen the date range or clear some filters to see results.'
              : 'Requests submitted within your visibility scope will be reported here.'
          }
          action={
            hasActiveFilters(applied) ? (
              <Button variant="outline" size="sm" onClick={reset}>
                <FilterX className="mr-2 h-4 w-4" />
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* KPIs */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Total Requests" value={k!.totalRequests} hint={`${formatAmount(k!.totalAmount)} cumulative`} icon={<FileStack className="h-5 w-5" />} />
            <KpiCard label="In Review" value={k!.inReview} tone="warning" hint={`${k!.returned} returned for correction`} />
            <KpiCard label="Approved" value={k!.approved} tone="success" hint={`Approval rate ${formatPercent(k!.approvalRate)}`} />
            <KpiCard label="Rejected" value={k!.rejected} tone="danger" hint={`Rejection rate ${formatPercent(k!.rejectionRate)}`} />
            <KpiCard label="Overdue" value={k!.overdue} tone="danger" hint="Stages past their SLA" />
            <KpiCard label="Avg. Approval Time" value={formatHours(k!.avgApprovalHours)} hint="Submission to final decision" icon={<Clock className="h-5 w-5" />} />
            <KpiCard label="Approval Rate" value={formatPercent(k!.approvalRate)} hint="Approved / decided requests" />
            <KpiCard label="Total Amount" value={formatAmount(k!.totalAmount)} hint="Sum of request amounts in scope" />
          </div>

          {/* Breakdown tables */}
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="By Department" description="Request volume and outcomes per submitting department.">
              {summary.byDepartment.length === 0 ? (
                <EmptyState title="No department data" />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Department</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right">Pending</TableHead>
                        <TableHead className="text-right">Approved</TableHead>
                        <TableHead className="text-right">Rejected</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.byDepartment.map((d) => (
                        <TableRow key={d.name}>
                          <TableCell className="max-w-40 truncate text-xs font-medium">{d.name}</TableCell>
                          <TableCell className="fc-num text-right text-xs">{d.total}</TableCell>
                          <TableCell className="fc-num text-right text-xs">{d.pending}</TableCell>
                          <TableCell className="fc-num text-right text-xs">{d.approved}</TableCell>
                          <TableCell className="fc-num text-right text-xs">{d.rejected}</TableCell>
                          <TableCell className="fc-num text-right text-xs font-medium">{formatAmount(d.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </SectionCard>

            <SectionCard title="By Category" description="Request volume and outcomes per document category.">
              {summary.byCategory.length === 0 ? (
                <EmptyState title="No category data" />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right">Pending</TableHead>
                        <TableHead className="text-right">Approved</TableHead>
                        <TableHead className="text-right">Rejected</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.byCategory.map((c) => (
                        <TableRow key={c.name}>
                          <TableCell className="max-w-40 truncate text-xs font-medium">{c.name}</TableCell>
                          <TableCell className="fc-num text-right text-xs">{c.total}</TableCell>
                          <TableCell className="fc-num text-right text-xs">{c.pending}</TableCell>
                          <TableCell className="fc-num text-right text-xs">{c.approved}</TableCell>
                          <TableCell className="fc-num text-right text-xs">{c.rejected}</TableCell>
                          <TableCell className="fc-num text-right text-xs font-medium">{formatAmount(c.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </SectionCard>
          </div>

          {/* Stage durations */}
          <SectionCard title="Average Stage Duration" description="Mean dwell time per approval stage for requests in scope.">
            {summary.avgTimeByStage.length === 0 ? (
              <EmptyState title="No stage timing data" description="Durations appear once requests start flowing through approval stages." />
            ) : (
              <div className="space-y-2.5">
                {summary.avgTimeByStage.slice(0, 8).map((s) => {
                  const max = Math.max(...summary.avgTimeByStage.map((x) => x.avgHours), 1)
                  return (
                    <div key={s.stage}>
                      <div className="flex items-center justify-between text-xs">
                        <span className="truncate font-medium">{s.stage}</span>
                        <span className="fc-num text-muted-foreground">{formatHours(s.avgHours)}</span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(4, (s.avgHours / max) * 100)}%` }}
                          aria-label={`Average ${formatHours(s.avgHours)}`}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  )
}
