// ============================================================================
// FlowControl — Login
// Professional split-panel sign-in with demo account shortcuts (demo data
// only — credentials are documented in README.md and are fictional).
// ============================================================================

'use client'

import { useState } from 'react'
import { api, ApiClientError } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Workflow, ShieldCheck, Lock, FileSearch, AlertTriangle, Loader2 } from 'lucide-react'
import type { SessionUserDTO } from '@/types/flowcontrol'

const DEMO_PASSWORD = 'FlowDemo#2024'

const DEMO_ACCOUNTS: { email: string; label: string }[] = [
  { email: 'admin@flowcontrol.local', label: 'Super Administrator' },
  { email: 'purchasing@flowcontrol.local', label: 'Purchasing Officer' },
  { email: 'manager.ops@flowcontrol.local', label: 'Operations Manager' },
  { email: 'controller@flowcontrol.local', label: 'Financial Controller' },
  { email: 'accountant@flowcontrol.local', label: 'Accountant' },
  { email: 'treasury@flowcontrol.local', label: 'Treasury' },
  { email: 'director@flowcontrol.local', label: 'General Director' },
  { email: 'auditor@flowcontrol.local', label: 'Internal Auditor' },
]

export function LoginView() {
  const setUser = useFlowControlStore((s) => s.setUser)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [locked, setLocked] = useState(false)
  const [loading, setLoading] = useState(false)

  const doLogin = async (loginEmail: string, loginPassword: string) => {
    setLoading(true)
    setError(null)
    setLocked(false)
    try {
      const data = await api.post<{ user: SessionUserDTO }>('/api/auth/login', {
        email: loginEmail,
        password: loginPassword,
      })
      setUser(data.user)
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message)
        setLocked(err.code === 'ACCOUNT_LOCKED')
      } else {
        setError('Unable to reach the server. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="grid w-full max-w-4xl overflow-hidden rounded-xl border shadow-sm md:grid-cols-2">
          {/* Brand panel */}
          <div className="hidden flex-col justify-between bg-zinc-950 p-8 text-zinc-50 md:flex">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-600">
                  <Workflow className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-lg font-semibold leading-tight">FlowControl</p>
                  <p className="text-xs text-zinc-400">Enterprise Workflow & Internal Control</p>
                </div>
              </div>
              <p className="mt-8 text-sm leading-relaxed text-zinc-300">
                Digitize and secure your internal approval processes: purchase requisitions, supplier
                invoices, expense approvals, contracts and payment authorizations — with configurable
                workflows, segregation of duties and a tamper-evident audit trail.
              </p>
              <ul className="mt-8 space-y-3 text-sm text-zinc-300">
                <li className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                  Role-based access control with eight business roles
                </li>
                <li className="flex items-start gap-2.5">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                  Segregation of duties and approval thresholds enforced server-side
                </li>
                <li className="flex items-start gap-2.5">
                  <FileSearch className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                  Hash-chained audit trail with integrity verification
                </li>
              </ul>
            </div>
            <p className="text-[11px] text-zinc-500">
              Electronic approvals recorded by this platform are internal traceability records, not
              qualified electronic signatures.
            </p>
          </div>

          {/* Form panel */}
          <div className="bg-card p-6 sm:p-8">
            <div className="mb-6 md:hidden">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Workflow className="h-5 w-5" />
                </div>
                <p className="text-base font-semibold">FlowControl</p>
              </div>
            </div>
            <h1 className="text-lg font-semibold">Sign in to your workspace</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Use your corporate account. Repeated failures lock the account for 15 minutes.
            </p>

            <form
              className="mt-6 space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                void doLogin(email, password)
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="login-email">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="username"
                  placeholder="name@company.ma"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-password">Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              {error ? (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                >
                  {locked ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
                  <span>{error}</span>
                </div>
              ) : null}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Sign in
              </Button>
            </form>

            <div className="mt-6">
              <p className="text-xs font-medium text-muted-foreground">Demo accounts (click to fill)</p>
              <Card className="mt-2 border-dashed">
                <CardContent className="grid max-h-52 gap-1 overflow-y-auto p-2 fc-scroll">
                  {DEMO_ACCOUNTS.map((acc) => (
                    <button
                      key={acc.email}
                      type="button"
                      className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-accent"
                      onClick={() => {
                        setEmail(acc.email)
                        setPassword(DEMO_PASSWORD)
                      }}
                    >
                      <span className="font-medium">{acc.label}</span>
                      <span className="text-muted-foreground">{acc.email}</span>
                    </button>
                  ))}
                </CardContent>
              </Card>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Demo password for all accounts: <code className="rounded bg-muted px-1 py-0.5">{DEMO_PASSWORD}</code>
              </p>
            </div>
          </div>
        </div>
      </main>

      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-4 py-3 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>FlowControl v1.0 — Enterprise Workflow & Internal Control Platform</p>
          <p>Unauthorized access attempts are logged and audited.</p>
        </div>
      </footer>
    </div>
  )
}
