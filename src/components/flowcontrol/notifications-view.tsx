// ============================================================================
// FlowControl — Notifications Center
//
// Full-screen notification list (the top-bar bell only shows a preview).
// Notifications sync with the polled store so unread counters stay consistent.
// ============================================================================

'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import { timeAgo } from '@/lib/client/format'
import type { NotificationDTO } from '@/types/flowcontrol'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { PageHeader, EmptyState } from './shared'
import { toast } from 'sonner'
import { AlertTriangle, Bell, CheckCheck, Info, RefreshCw, Settings } from 'lucide-react'

function NotificationIcon({ type }: { type: NotificationDTO['type'] }) {
  if (type === 'ALERT') return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
  if (type === 'ACTION_REQUIRED') return <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
  if (type === 'SYSTEM') return <Settings className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
  return <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
}

function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString()
}

export function NotificationsView() {
  const { setNotifications, openDocument, dataVersion } = useFlowControlStore()
  const [items, setItems] = useState<NotificationDTO[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [markingAll, setMarkingAll] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<{ items: NotificationDTO[]; unreadCount: number }>('/api/notifications')
      setItems(data.items)
      setUnreadCount(data.unreadCount)
      setNotifications(data.items, data.unreadCount)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load notifications.')
    } finally {
      setLoading(false)
    }
  }, [setNotifications])

  useEffect(() => {
    void load()
  }, [load, dataVersion])

  const open = (n: NotificationDTO) => {
    if (!n.isRead) {
      // Optimistic local + store update; the API call is fire-and-forget.
      const updated = items.map((x) => (x.id === n.id ? { ...x, isRead: true } : x))
      const nextUnread = Math.max(0, unreadCount - 1)
      setItems(updated)
      setUnreadCount(nextUnread)
      setNotifications(updated, nextUnread)
      void api.post('/api/notifications/read', { ids: [n.id] }).catch(() => {
        // Silent: the poller will reconcile on the next cycle.
      })
    }
    if (n.link?.startsWith('document:')) {
      openDocument(n.link.slice('document:'.length))
    }
  }

  const markAllAsRead = async () => {
    setMarkingAll(true)
    try {
      await api.post('/api/notifications/read', { all: true })
      const updated = items.map((x) => ({ ...x, isRead: true }))
      setItems(updated)
      setUnreadCount(0)
      setNotifications(updated, 0)
      toast.success('All notifications marked as read.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to mark notifications as read.')
    } finally {
      setMarkingAll(false)
    }
  }

  const today = items.filter((n) => isToday(n.createdAt))
  const earlier = items.filter((n) => !isToday(n.createdAt))

  const renderGroup = (list: NotificationDTO[]) => (
    <ul className="divide-y divide-border">
      {list.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            onClick={() => open(n)}
            className="flex w-full items-start gap-3 px-1 py-3 text-left transition-colors hover:bg-accent/50 sm:px-3"
            aria-label={n.title}
          >
            <NotificationIcon type={n.type} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                {!n.isRead ? <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-label="Unread" /> : null}
                <span className={cn('truncate text-sm', !n.isRead ? 'font-medium' : 'font-normal')}>{n.title}</span>
              </span>
              {n.body ? <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">{n.body}</span> : null}
            </span>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">{timeAgo(n.createdAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <div className="space-y-5">
      <PageHeader
        title="Notifications"
        description="System alerts, required actions and workflow events addressed to you."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load()} aria-label="Refresh notifications">
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button size="sm" onClick={() => void markAllAsRead()} disabled={unreadCount === 0 || markingAll}>
              <CheckCheck className="mr-2 h-4 w-4" />
              {markingAll ? 'Marking…' : 'Mark all as read'}
            </Button>
          </>
        }
      />

      {loading && items.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No notifications yet"
          description="You will be notified here about approval requests, decisions and control alerts."
        />
      ) : (
        <div className="max-h-[calc(100vh-16rem)] overflow-y-auto fc-scroll rounded-lg border bg-card">
          {today.length > 0 ? (
            <section aria-label="Today">
              <p className="border-b bg-muted/50 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Today · {today.length}
              </p>
              {renderGroup(today)}
            </section>
          ) : null}
          {earlier.length > 0 ? (
            <section aria-label="Earlier">
              <p className="border-b bg-muted/50 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Earlier · {earlier.length}
              </p>
              {renderGroup(earlier)}
            </section>
          ) : null}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Showing the {items.length} most recent notifications. Unread items are marked with a green dot; click a
        notification to open the linked request.
      </p>
    </div>
  )
}
