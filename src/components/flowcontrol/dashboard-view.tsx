// ============================================================================
// FlowControl — Main Dashboard
// Role-scoped KPIs, volume charts (real data), stage bottlenecks, pending
// actions and recent audit activity. Every figure comes from /api/dashboard.
// ============================================================================

'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import { formatAmount, formatHours, formatPercent, timeAgo, shortHash } from '@/lib/client/format'
import type { DashboardDTO } from '@/types/flowcontrol'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard, SectionCard, EmptyState, PageHeader } from './shared'
import { StatusBadge } from './status-badge'
import { RefreshCw, ClipboardCheck, Clock, AlertTriangle, CheckCircle2, XCircle, FileStack, Inbox } from 'lucide-react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  LineChart,
  Line,
  CartesianGrid,
} from 'recharts'

export function DashboardView() {
  const { user, navigate, dataVersion } = useFlowControlStore()
  const [data, setData] = useState<DashboardDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const result = await api.get<DashboardDTO>('/api/dashboard')
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load dashboard.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [dataVersion])

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    )
  }

  if (error || !data) {
    return <EmptyState title="Dashboard unavailable" description={error ?? undefined} />
  }

  const k = data.kpis

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Welcome, ${user?.name.split(' ')[0] ?? ''}`}
        description={
          data.scope === 'GLOBAL'
            ? 'Organization-wide overview — all departments and requests.'
            : 'Overview of the requests visible to you.'
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => useFlowControlStore.getState().bumpData()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Total Requests" value={k.totalRequests} hint={`${formatAmount(k.totalAmount)} cumulative`} icon={<FileStack className="h-5 w-5" />} />
        <KpiCard label="In Review" value={k.inReview} tone="warning" hint={`${k.myPendingActions} awaiting your action`} icon={<Inbox className="h-5 w-5" />} />
        <KpiCard label="Approved" value={k.approved} tone="success" hint={`Approval rate ${formatPercent(k.approvalRate)}`} icon={<CheckCircle2 className="h-5 w-5" />} />
        <KpiCard label="Rejected" value={k.rejected} tone="danger" hint={`Rejection rate ${formatPercent(k.rejectionRate)}`} icon={<XCircle className="h-5 w-5" />} />
        <KpiCard label="Overdue" value={k.overdue} tone="danger" hint="Stages past their SLA" icon={<AlertTriangle className="h-5 w-5" />} />
        <KpiCard label="Avg. Approval Time" value={formatHours(k.avgApprovalHours)} hint="Submission to final approval" icon={<Clock className="h-5 w-5" />} />
        <KpiCard label="Returned" value={k.returned} tone="warning" hint="Awaiting correction" icon={<ClipboardCheck className="h-5 w-5" />} />
        <KpiCard label="Drafts" value={k.drafts} hint="Not yet submitted" />
      </div>

      {/* My pending actions */}
      {data.myPendingDocuments.length > 0 ? (
        <SectionCard
          title="Awaiting Your Decision"
          description="Requests routed to you at their current approval stage."
          contentClassName="max-h-72 overflow-y-auto fc-scroll"
        >
          <div className="space-y-2">
            {data.myPendingDocuments.map((d) => (
              <button
                key={d.documentId}
                className="flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-accent sm:flex-row sm:items-center sm:justify-between"
                onClick={() => navigate('request-detail', d.documentId)}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {d.reference} — {d.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Stage: {d.currentStage} · waiting since {timeAgo(d.stepStartedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2 sm:shrink-0">
                  <span className="fc-num text-sm font-semibold">{formatAmount(d.amount, d.currency)}</span>
                  <StatusBadge variant="warning">Open</StatusBadge>
                </div>
              </button>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Requests by Department</CardTitle>
            <CardDescription className="text-xs">Volume of visible requests per submitting department.</CardDescription>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.byDepartment} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11 }}
                  interval={0}
                  angle={-18}
                  textAnchor="end"
                  height={56}
                  stroke="var(--muted-foreground)"
                  tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--popover)' }}
                />
                <Bar dataKey="total" name="Total" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="approved" name="Approved" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Monthly Volume (6 months)</CardTitle>
            <CardDescription className="text-xs">Submissions and approvals per month.</CardDescription>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.monthly} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--popover)' }}
                />
                <Line type="monotone" dataKey="total" name="Submitted" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="approved" name="Approved" stroke="var(--chart-2)" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Bottlenecks + recent activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Workflow Bottlenecks" description="Average dwell time per approval stage (slowest first).">
          {data.avgTimeByStage.length === 0 ? (
            <EmptyState title="No stage data yet" description="Dwell times appear once approvals start flowing." />
          ) : (
            <div className="space-y-2.5">
              {data.avgTimeByStage.slice(0, 6).map((s) => {
                const max = data.avgTimeByStage[0]?.avgHours || 1
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

        <SectionCard
          title="Recent Activity"
          description={data.recentEvents.length > 0 ? 'Latest audited system events.' : 'Audit events are visible to administrators and auditors.'}
          contentClassName="max-h-80 overflow-y-auto fc-scroll"
        >
          {data.recentEvents.length === 0 ? (
            <EmptyState title="No audit visibility" description="Your role can see request activity in the request lists." />
          ) : (
            <ul className="space-y-2.5">
              {data.recentEvents.map((e) => (
                <li key={e.seq} className="flex items-start gap-2.5 text-xs">
                  <span className="fc-num mt-0.5 shrink-0 text-muted-foreground">#{e.seq}</span>
                  <div className="min-w-0">
                    <p className="truncate">
                      <span className="font-medium">{e.action}</span>
                      {e.actorName ? <span className="text-muted-foreground"> by {e.actorName}</span> : <span className="text-muted-foreground"> (system)</span>}
                    </p>
                    <p className="truncate text-muted-foreground">
                      {timeAgo(e.occurredAt)} · {e.entityType ?? 'system'} · hash {shortHash(e.hash)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
