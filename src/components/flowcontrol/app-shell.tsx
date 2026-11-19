// ============================================================================
// FlowControl — Application Shell
//
// Single-route enterprise layout: role-aware sidebar navigation, top bar with
// notification center and session menu, sticky footer. Navigation visibility
// mirrors the server-side RBAC matrix; the server remains the enforcement
// point (hidden UI is never a security control).
// ============================================================================

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { api } from '@/lib/client/api'
import { useFlowControlStore, type ViewKey } from '@/lib/client/store'
import { ROLE_LABELS } from '@/lib/client/format'
import type { NotificationDTO, RoleKey } from '@/types/flowcontrol'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  FileStack,
  ClipboardCheck,
  History,
  Bell,
  UserCog,
  ShieldCheck,
  BarChart3,
  Settings,
  LogOut,
  Sun,
  Moon,
  Menu,
  Workflow,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'

// ---- Client-side mirror of the server permission matrix (visibility only) ----
const NAV: { key: ViewKey; label: string; icon: React.ComponentType<{ className?: string }>; roles: RoleKey[] }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['SUPER_ADMIN', 'PURCHASING', 'DEPT_MANAGER', 'FIN_CONTROLLER', 'ACCOUNTANT', 'TREASURY', 'GENERAL_DIRECTOR', 'INTERNAL_AUDITOR'] },
  { key: 'my-requests', label: 'My Requests', icon: FileStack, roles: ['SUPER_ADMIN', 'PURCHASING', 'DEPT_MANAGER', 'FIN_CONTROLLER', 'ACCOUNTANT', 'TREASURY', 'GENERAL_DIRECTOR', 'INTERNAL_AUDITOR'] },
  { key: 'approvals', label: 'Pending Approvals', icon: ClipboardCheck, roles: ['DEPT_MANAGER', 'FIN_CONTROLLER', 'ACCOUNTANT', 'TREASURY', 'GENERAL_DIRECTOR'] },
  { key: 'approval-history', label: 'My Decisions', icon: History, roles: ['DEPT_MANAGER', 'FIN_CONTROLLER', 'ACCOUNTANT', 'TREASURY', 'GENERAL_DIRECTOR'] },
  { key: 'delegations', label: 'Delegations', icon: UserCog, roles: ['SUPER_ADMIN', 'DEPT_MANAGER', 'FIN_CONTROLLER', 'ACCOUNTANT', 'TREASURY', 'GENERAL_DIRECTOR'] },
  { key: 'notifications', label: 'Notifications', icon: Bell, roles: ['SUPER_ADMIN', 'PURCHASING', 'DEPT_MANAGER', 'FIN_CONTROLLER', 'ACCOUNTANT', 'TREASURY', 'GENERAL_DIRECTOR', 'INTERNAL_AUDITOR'] },
  { key: 'audit', label: 'Internal Audit', icon: ShieldCheck, roles: ['SUPER_ADMIN', 'INTERNAL_AUDITOR'] },
  { key: 'reports', label: 'Reports', icon: BarChart3, roles: ['SUPER_ADMIN', 'DEPT_MANAGER', 'FIN_CONTROLLER', 'ACCOUNTANT', 'TREASURY', 'GENERAL_DIRECTOR', 'INTERNAL_AUDITOR'] },
  { key: 'admin', label: 'Administration', icon: Settings, roles: ['SUPER_ADMIN'] },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, view, navigate, notifications, unreadCount, setNotifications } = useFlowControlStore()
  const [mobileOpen, setMobileOpen] = useState(false)
  const { theme, setTheme } = useTheme()

  const pollNotifications = useCallback(async () => {
    try {
      const data = await api.get<{ items: NotificationDTO[]; unreadCount: number }>('/api/notifications')
      setNotifications(data.items, data.unreadCount)
    } catch {
      // Silent: notification polling must never break the UI.
    }
  }, [setNotifications])

  useEffect(() => {
    if (!user) return
    void pollNotifications()
    const timer = setInterval(pollNotifications, 30000)
    return () => clearInterval(timer)
  }, [user, pollNotifications])

  const logout = async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      // Ignore — cookie is cleared regardless.
    }
    window.location.reload()
  }

  const openLinkedNotification = (n: NotificationDTO) => {
    if (n.link?.startsWith('document:')) {
      navigate('request-detail', n.link.slice('document:'.length))
    } else {
      navigate('notifications')
    }
  }

  if (!user) return null
  const nav = NAV.filter((n) => n.roles.includes(user.role))

  const sidebarContent = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Workflow className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-semibold leading-tight text-foreground">FlowControl</p>
          <p className="text-[11px] leading-tight text-muted-foreground">Workflow & Internal Control</p>
        </div>
      </div>
      <nav className="flex-1 space-y-1 px-3" aria-label="Main navigation">
        {nav.map((item) => {
          const Icon = item.icon
          const active = view === item.key
          return (
            <button
              key={item.key}
              onClick={() => {
                navigate(item.key)
                setMobileOpen(false)
              }}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-primary/15 font-medium text-primary-foreground [&_svg]:text-primary'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground [&_svg]:text-muted-foreground',
                active ? 'text-foreground' : '',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
              {item.key === 'notifications' && unreadCount > 0 ? (
                <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              ) : null}
            </button>
          )
        })}
      </nav>
      <div className="border-t border-sidebar-border px-4 py-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Signed in as
          <span className="block truncate font-medium text-foreground">{user.name}</span>
          <span className="block truncate">{ROLE_LABELS[user.role]}</span>
        </p>
      </div>
    </div>
  )

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex flex-1">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:block">
          {sidebarContent}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-5">
            {/* Mobile menu */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation menu">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-64 bg-sidebar p-0 text-sidebar-foreground">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                {sidebarContent}
              </SheetContent>
            </Sheet>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {nav.find((n) => n.key === view)?.label ?? 'FlowControl'}
              </p>
            </div>

            {/* Notifications */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
                  <Bell className="h-5 w-5" />
                  {unreadCount > 0 ? (
                    <span className="absolute right-1.5 top-1.5 flex h-2 w-2 rounded-full bg-red-500" aria-hidden />
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel className="flex items-center justify-between">
                  <span>Notifications</span>
                  <span className="text-xs font-normal text-muted-foreground">{unreadCount} unread</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <div className="max-h-80 overflow-y-auto fc-scroll">
                  {notifications.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">No notifications yet.</p>
                  ) : (
                    notifications.slice(0, 8).map((n) => (
                      <DropdownMenuItem
                        key={n.id}
                        className="flex cursor-pointer flex-col items-start gap-0.5 px-3 py-2"
                        onClick={() => openLinkedNotification(n)}
                      >
                        <span className="flex w-full items-center gap-1.5">
                          {n.type === 'ALERT' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" /> : null}
                          <span className={cn('truncate text-xs', !n.isRead && 'font-semibold')}>{n.title}</span>
                        </span>
                        {n.body ? <span className="line-clamp-2 text-[11px] text-muted-foreground">{n.body}</span> : null}
                      </DropdownMenuItem>
                    ))
                  )}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="cursor-pointer justify-center text-xs" onClick={() => navigate('notifications')}>
                  View all notifications
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* User menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="flex items-center gap-2 px-2" aria-label="Account menu">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {user.name
                      .split(' ')
                      .map((p) => p[0])
                      .slice(0, 2)
                      .join('') ?? '?'}
                  </span>
                  <span className="hidden max-w-32 truncate text-sm md:inline">{user.name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>
                  <p className="text-sm font-medium">{user.name}</p>
                  <p className="text-xs font-normal text-muted-foreground">{user.email}</p>
                  <p className="mt-1 text-xs font-normal text-muted-foreground">
                    {ROLE_LABELS[user.role]}
                    {user.departmentName ? ` — ${user.departmentName}` : ''}
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="cursor-pointer" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                  {theme === 'dark' ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
                  Toggle theme
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="cursor-pointer text-red-600 focus:text-red-600" onClick={() => void logout()}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          {/* Main content */}
          <main className="flex-1 px-3 py-5 sm:px-5 lg:px-7" aria-live="polite">
            <div className="mx-auto w-full max-w-7xl">{children}</div>
          </main>

          {/* Sticky footer: pushed down naturally when content overflows */}
          <footer className="mt-auto border-t bg-background">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-1 px-3 py-3 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-5 lg:px-7">
              <p>FlowControl v1.0 — Enterprise Workflow, Document Approval & Internal Control Platform</p>
              <p>Internal use only. All approval actions are recorded in the tamper-evident audit trail.</p>
            </div>
          </footer>
        </div>
      </div>
    </div>
  )
}

/** Helper used by views to surface API errors consistently. */
export function toastError(error: unknown, fallback = 'The operation failed.') {
  const message = error instanceof Error ? error.message : fallback
  toast.error(message)
}
