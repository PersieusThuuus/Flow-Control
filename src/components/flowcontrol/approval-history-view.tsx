// ============================================================================
// FlowControl — My Decisions (approval history)
//
// The signed-in user's recorded decisions with their audit binding: stage,
// action, delegation, the exact document version and hash, comment and IP.
// ============================================================================
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, qs } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import { formatDate, ACTION_META } from '@/lib/client/format'
import type { ApprovalAction, ApprovalDTO, DocumentSummaryDTO, Paginated } from '@/types/flowcontrol'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight, History, RefreshCw } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, PageHeader, SectionCard, TableSkeleton } from './shared'
import { StatusBadge } from './status-badge'

type HistoryRow = ApprovalDTO & { documentReference: string | null; documentTitle: string | null }

const ACTION_KEYS: ApprovalAction[] = ['APPROVE', 'REJECT', 'RETURN_FOR_CORRECTION', 'COMMENT']
const PAGE_SIZE = 10

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

export function ApprovalHistoryView() {
  const { dataVersion, bumpData, openDocument } = useFlowControlStore()
  const [action, setAction] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Paginated<HistoryRow> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const query = qs({
          action: action === 'all' ? undefined : action,
          page,
          pageSize: PAGE_SIZE,
        })
        const res = await api.get<Paginated<HistoryRow>>(`/api/approvals/history${query}`)
        if (!cancelled) {
          setData(res)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(errMessage(err, 'Failed to load your decision history.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [action, page, dataVersion])

  /**
   * History rows carry the document reference but not its id; resolve it via
   * the document search (routed documents are visible to approvers).
   */
  const openByReference = async (reference: string | null) => {
    if (!reference) return
    setResolving(true)
    try {
      const res = await api.get<Paginated<DocumentSummaryDTO>>(`/api/documents${qs({ q: reference })}`)
      const target = res.items.find((d) => d.reference === reference)
      if (!target) {
        toast.error('This document is no longer visible to your account.')
        return
      }
      openDocument(target.id)
    } catch (err) {
      toast.error(errMessage(err, 'Could not open the document.'))
    } finally {
      setResolving(false)
    }
  }

  const rows = data?.items ?? []
  const from = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0
  const to = data ? Math.min(data.page * data.pageSize, data.total) : 0

  return (
    <div className="space-y-5">
      <PageHeader
        title="My Decisions"
        description="Every decision you recorded, with its stage, document version, hash and IP binding."
        actions={
          <Button variant="outline" size="sm" onClick={bumpData}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Refresh
          </Button>
        }
      />

      <SectionCard
        title="Decision History"
        description={data ? `${data.total} recorded decision${data.total === 1 ? '' : 's'}.` : 'Your recorded approvals, rejections, returns and comments.'}
      >
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <Select
            value={action}
            onValueChange={(v) => {
              setAction(v)
              setPage(1)
            }}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="Filter by action">
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {ACTION_KEYS.map((a) => (
                <SelectItem key={a} value={a}>
                  {ACTION_META[a].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading && !data ? (
          <TableSkeleton />
        ) : error ? (
          <EmptyState
            title="History unavailable"
            description={error}
            action={
              <Button variant="outline" size="sm" onClick={bumpData}>
                Retry
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center">
            <History className="h-8 w-8 text-muted-foreground/60" aria-hidden />
            <p className="mt-3 text-sm font-medium">No decisions recorded yet</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Approvals, rejections, returns and comments you record appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-36">Date</TableHead>
                  <TableHead className="min-w-56">Document</TableHead>
                  <TableHead className="min-w-36">Stage</TableHead>
                  <TableHead className="w-28">Action</TableHead>
                  <TableHead className="min-w-32">On behalf of</TableHead>
                  <TableHead className="w-16 text-right">Version</TableHead>
                  <TableHead className="min-w-48">Comment</TableHead>
                  <TableHead className="min-w-28">IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-muted-foreground">{formatDate(a.createdAt)}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left"
                        disabled={resolving || !a.documentReference}
                        onClick={() => void openByReference(a.documentReference)}
                        aria-label={`Open ${a.documentReference ?? 'document'}`}
                      >
                        <p className="font-medium text-primary hover:underline">{a.documentReference ?? '—'}</p>
                        <p className="max-w-64 truncate text-xs text-muted-foreground" title={a.documentTitle ?? undefined}>
                          {a.documentTitle ?? '—'}
                        </p>
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.stageName}</TableCell>
                    <TableCell>
                      <StatusBadge variant={ACTION_META[a.action].variant}>{ACTION_META[a.action].label}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.delegatedFromName ?? '—'}</TableCell>
                    <TableCell className="fc-num text-right text-muted-foreground">
                      {a.documentVersion !== null ? `v${a.documentVersion}` : '—'}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <p className="truncate text-xs text-muted-foreground" title={a.comment ?? undefined}>
                        {a.comment ?? '—'}
                      </p>
                    </TableCell>
                    <TableCell className="fc-num text-muted-foreground">{a.ip ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {data && data.total > 0 ? (
          <div className="flex flex-col gap-2 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              Showing <span className="fc-num">{from}</span>–<span className="fc-num">{to}</span> of{' '}
              <span className="fc-num">{data.total}</span>
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
                Prev
              </Button>
              <span className="text-xs text-muted-foreground">
                Page <span className="fc-num">{data.page}</span> of <span className="fc-num">{data.pages}</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={data.page >= data.pages}
                onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
              >
                Next
                <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>
    </div>
  )
}
