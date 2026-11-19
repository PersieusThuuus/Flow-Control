// ============================================================================
// FlowControl — Application entry (single user-visible route: "/")
//
// Bootstraps the session, then renders the login screen or the application
// shell with the active view. All data flows through the authenticated API.
// ============================================================================

'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client/api'
import { useFlowControlStore, type ViewKey } from '@/lib/client/store'
import type { SessionUserDTO } from '@/types/flowcontrol'
import { LoginView } from '@/components/flowcontrol/login-view'
import { AppShell } from '@/components/flowcontrol/app-shell'
import { DashboardView } from '@/components/flowcontrol/dashboard-view'
import { MyRequestsView } from '@/components/flowcontrol/my-requests-view'
import { RequestDetailView } from '@/components/flowcontrol/request-detail-view'
import { ApprovalsView } from '@/components/flowcontrol/approvals-view'
import { ApprovalHistoryView } from '@/components/flowcontrol/approval-history-view'
import { NotificationsView } from '@/components/flowcontrol/notifications-view'
import { DelegationsView } from '@/components/flowcontrol/delegations-view'
import { AuditView } from '@/components/flowcontrol/audit-view'
import { ReportsView } from '@/components/flowcontrol/reports-view'
import { AdminView } from '@/components/flowcontrol/admin-view'
import { Workflow, Loader2 } from 'lucide-react'

const VIEWS: Record<ViewKey, React.ComponentType> = {
  dashboard: DashboardView,
  'my-requests': MyRequestsView,
  'request-detail': RequestDetailView,
  approvals: ApprovalsView,
  'approval-history': ApprovalHistoryView,
  notifications: NotificationsView,
  delegations: DelegationsView,
  audit: AuditView,
  reports: ReportsView,
  admin: AdminView,
}

export default function FlowControlApp() {
  const { user, setUser, view } = useFlowControlStore()
  const [bootstrapping, setBootstrapping] = useState(true)

  useEffect(() => {
    let cancelled = false
    api
      .get<{ user: SessionUserDTO | null }>('/api/auth/me')
      .then((data) => {
        if (!cancelled) setUser(data.user)
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setBootstrapping(false)
      })
    return () => {
      cancelled = true
    }
  }, [setUser])

  if (bootstrapping) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background" role="status" aria-label="Loading FlowControl">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Workflow className="h-6 w-6" />
        </div>
        <p className="text-sm font-medium">FlowControl</p>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
      </div>
    )
  }

  if (!user) return <LoginView />

  const ActiveView = VIEWS[view] ?? DashboardView
  return (
    <AppShell>
      <ActiveView />
    </AppShell>
  )
}
