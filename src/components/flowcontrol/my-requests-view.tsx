// ============================================================================
// FlowControl — My Requests
//
// The request register of the signed-in user (scope=mine): drafts, submissions,
// returns for correction and terminal states. Provides creation (purchasing),
// version upload, submission for approval and cancellation with reason.
// ============================================================================
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, qs } from '@/lib/client/api'
import { useFlowControlStore } from '@/lib/client/store'
import { formatAmount, formatBytes, timeAgo, DOCUMENT_STATUS_META } from '@/lib/client/format'
import type { DocumentStatus, DocumentSummaryDTO, MetaDTO, Paginated } from '@/types/flowcontrol'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileUp,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  XCircle,
} from 'lucide-react'
import { ConfirmDialog, EmptyState, PageHeader, SectionCard, TableSkeleton } from './shared'
import { StatusBadge } from './status-badge'

type DialogKind = 'create' | 'submit' | 'version' | 'cancel' | null

const STATUS_KEYS = Object.keys(DOCUMENT_STATUS_META) as DocumentStatus[]
const PAGE_SIZES = [10, 20, 50]

/** First workflow (by meta order) matching the category and amount window. */
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

/** errmsg helper shared by the dialogs. */
function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

// ---------------------------------------------------------------------------
// New Request dialog (documents.create — purchasing)
// ---------------------------------------------------------------------------
function NewRequestDialog({
  open,
  onOpenChange,
  meta,
  onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  meta: MetaDTO | null
  onDone: () => void
}) {
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('MAD')
  const [supplier, setSupplier] = useState('')
  const [description, setDescription] = useState('')
  const [evidence, setEvidence] = useState<string[]>([])
  const [justification, setJustification] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const category = meta?.categories.find((c) => c.id === categoryId) ?? null
  const required = category?.requiredEvidence ?? []
  const missing = required.filter((r) => !evidence.includes(r))

  useEffect(() => {
    if (!open) return
    setTitle('')
    setCategoryId('')
    setAmount('')
    setCurrency('MAD')
    setSupplier('')
    setDescription('')
    setEvidence([])
    setJustification('')
    setFile(null)
    setFileKey((k) => k + 1)
    setError(null)
    setBusy(false)
  }, [open])

  const toggleEvidence = (item: string, checked: boolean) => {
    setEvidence((prev) => (checked ? [...prev, item] : prev.filter((e) => e !== item)))
  }

  const submit = async () => {
    setError(null)
    const amountNum = Number(amount)
    if (title.trim().length < 3) return setError('Title must be at least 3 characters.')
    if (!categoryId) return setError('A document category is required.')
    if (!Number.isInteger(amountNum) || amountNum < 0 || amountNum > 999_999_999_999) {
      return setError('Amount must be a whole number between 0 and 999,999,999,999.')
    }
    if (!/^[A-Z]{3}$/.test(currency)) return setError('Currency must be a 3-letter code.')
    if (!file) return setError('Attach the document file (PDF, DOCX, XLSX, PNG or JPG).')
    if (missing.length > 0 && justification.trim().length < 3) {
      return setError('Provide a written justification for the missing evidence, or attach all required evidence.')
    }
    setBusy(true)
    try {
      const form = new FormData()
      form.set('title', title.trim())
      form.set('categoryId', categoryId)
      form.set('amount', String(amountNum))
      form.set('currency', currency)
      if (description.trim()) form.set('description', description.trim())
      if (supplier.trim()) form.set('supplierName', supplier.trim())
      form.set('evidenceProvided', JSON.stringify(evidence))
      if (justification.trim()) form.set('evidenceJustification', justification.trim())
      form.set('file', file)
      const res = await api.upload<{ document: DocumentSummaryDTO }>('/api/documents', form)
      toast.success(`Draft ${res.document.reference} created. Submit it for approval when ready.`)
      onDone()
    } catch (err) {
      const message = errMessage(err, 'Failed to create the request.')
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto fc-scroll sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Request</DialogTitle>
          <DialogDescription>
            Create a draft request with its supporting file. Submission for approval is a separate, explicit step.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="req-title">Title</Label>
            <Input
              id="req-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Annual office supplies order"
              maxLength={200}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Category</Label>
              <Select
                value={categoryId}
                onValueChange={(v) => {
                  setCategoryId(v)
                  setEvidence([])
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {(meta?.categories ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {category && required.length > 0 ? (
                <p className="text-xs text-muted-foreground">Required evidence: {required.join(', ')}</p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="req-amount">Amount</Label>
              <Input
                id="req-amount"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 25000"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['MAD', 'EUR', 'USD', 'GBP'].map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="req-supplier">Supplier (optional)</Label>
              <Input
                id="req-supplier"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                placeholder="e.g. Atlas Office SARL"
                maxLength={200}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="req-description">Description (optional)</Label>
            <Textarea
              id="req-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Business purpose, references, budget line…"
              rows={3}
            />
          </div>

          {required.length > 0 ? (
            <div className="grid gap-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Supporting evidence required for this category
              </Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {required.map((item, idx) => {
                  const checked = evidence.includes(item)
                  return (
                    <label
                      key={item}
                      htmlFor={`req-evidence-${idx}`}
                      className="flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-sm transition-colors hover:bg-accent"
                    >
                      <Checkbox
                        id={`req-evidence-${idx}`}
                        checked={checked}
                        onCheckedChange={(c) => toggleEvidence(item, c === true)}
                        className="mt-0.5"
                      />
                      <span className="leading-tight">{item}</span>
                    </label>
                  )
                })}
              </div>
              {missing.length > 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Missing: {missing.join(', ')} — a written justification is required to submit.
                </p>
              ) : (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">All required evidence is attached.</p>
              )}
            </div>
          ) : null}

          {missing.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="req-justification">Justification for missing evidence</Label>
              <Textarea
                id="req-justification"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Explain why the missing evidence cannot be provided."
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Recorded with the request. Submission without mandatory evidence is blocked unless a justification is on
                file.
              </p>
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="req-file">Document file</Label>
            <Input
              key={fileKey}
              id="req-file"
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Submit for approval dialog
// ---------------------------------------------------------------------------
function SubmitRequestDialog({
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      const res = await api.post<{ ok: true; instanceId: string; steps: number }>(`/api/documents/${doc.id}/submit`, {
        evidenceJustification: justification.trim() || null,
      })
      toast.success(
        `${doc.reference} submitted for approval — workflow started with ${res.steps} step${res.steps === 1 ? '' : 's'}.`,
      )
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
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Mandatory evidence</p>
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
        </div>
      ) : null}

      {missing.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="submit-justification">Justification on record</Label>
          <Textarea
            id="submit-justification"
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="No justification is on record — submission will be rejected unless evidence is attached."
            rows={3}
          />
          <p className="text-xs text-muted-foreground">
            This justification was recorded when the request was created and authorizes submission despite the missing
            evidence. Without it, submission is blocked by the evidence control.
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
// Upload new version dialog
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
    setError(null)
    if (!file) return setError('Select the corrected file to upload.')
    setBusy(true)
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload New Version</DialogTitle>
          <DialogDescription>
            {doc.reference} — current version v{doc.currentVersion}. The uploaded file becomes the new immutable
            version under review.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-4 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="ver-file">File</Label>
            <Input
              key={fileKey}
              id="ver-file"
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
            <Label htmlFor="ver-note">Note (optional)</Label>
            <Textarea
              id="ver-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Corrected supplier bank details per reviewer comment"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Upload Version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Cancel request dialog
// ---------------------------------------------------------------------------
function CancelRequestDialog({
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
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setReason('')
      setError(null)
      setBusy(false)
    }
  }, [open])

  const confirm = async () => {
    if (!doc) return
    if (reason.trim().length < 3) {
      setError('Provide a reason (at least 3 characters) — it is recorded in the audit trail.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ ok: true; message: string }>(`/api/documents/${doc.id}/cancel`, {
        reason: reason.trim(),
      })
      toast.success(res.message)
      onDone()
    } catch (err) {
      const message = errMessage(err, 'Cancellation failed.')
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
      title="Cancel Request"
      description={`${doc.reference} — ${doc.title}`}
      confirmLabel="Cancel Request"
      destructive
      loading={busy}
      onConfirm={() => void confirm()}
    >
      {error ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="cancel-reason">Reason</Label>
        <Textarea
          id="cancel-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Duplicate of REQ-…; supplier withdrew the offer"
          rows={3}
          maxLength={500}
        />
        <p className="text-xs text-muted-foreground">
          The reason is recorded in the tamper-evident audit trail. This cannot be undone.
        </p>
      </div>
    </ConfirmDialog>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------
export function MyRequestsView() {
  const { user, dataVersion, bumpData, openDocument } = useFlowControlStore()
  const [meta, setMeta] = useState<MetaDTO | null>(null)

  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [status, setStatus] = useState<string>('all')
  const [categoryId, setCategoryId] = useState<string>('all')
  const [scope, setScope] = useState<'mine' | 'department' | 'visible'>(
    // Creators land on their own register; finance/approver roles land on
    // everything visible to them (they rarely create requests themselves).
    user?.role === 'PURCHASING' || user?.role === 'DEPT_MANAGER' ? 'mine' : 'visible',
  )
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)

  const [data, setData] = useState<Paginated<DocumentSummaryDTO> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dialog, setDialog] = useState<DialogKind>(null)
  const [actionDoc, setActionDoc] = useState<DocumentSummaryDTO | null>(null)

  // Reference data (categories for filters and dialogs).
  useEffect(() => {
    let cancelled = false
    api
      .get<MetaDTO>('/api/meta')
      .then((m) => {
        if (!cancelled) setMeta(m)
      })
      .catch(() => {
        /* filters degrade gracefully without meta */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced search (400 ms) — resets pagination.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQ(q.trim())
      setPage(1)
    }, 400)
    return () => clearTimeout(timer)
  }, [q])

  // List loading (refetch on filters, pagination and dataVersion bumps).
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const query = qs({
          scope: scope === 'mine' ? 'mine' : scope === 'department' ? 'department' : undefined,
          q: debouncedQ,
          status: status === 'all' ? undefined : status,
          categoryId: categoryId === 'all' ? undefined : categoryId,
          page,
          pageSize,
        })
        const res = await api.get<Paginated<DocumentSummaryDTO>>(`/api/documents${query}`)
        if (!cancelled) {
          setData(res)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(errMessage(err, 'Failed to load requests.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [scope, debouncedQ, status, categoryId, page, pageSize, dataVersion])

  const openAction = (kind: Exclude<DialogKind, null>, doc: DocumentSummaryDTO) => {
    setActionDoc(doc)
    setDialog(kind)
  }
  const closeAction = () => {
    setDialog(null)
    setActionDoc(null)
  }
  const afterMutation = () => {
    closeAction()
    bumpData()
  }

  const rows = data?.items ?? []
  const from = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0
  const to = data ? Math.min(data.page * data.pageSize, data.total) : 0

  return (
    <div className="space-y-5">
      <PageHeader
        title="My Requests"
        description="The request register — drafts, active reviews, returns for correction and final decisions."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={bumpData}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
              Refresh
            </Button>
            {user?.role === 'PURCHASING' || user?.role === 'DEPT_MANAGER' ? (
              <Button size="sm" onClick={() => setDialog('create')}>
                <Plus className="mr-2 h-4 w-4" aria-hidden />
                New Request
              </Button>
            ) : null}
          </>
        }
      />

      <SectionCard
        title="Request Register"
        description={
          data
            ? `${data.total} request${data.total === 1 ? '' : 's'} ${scope === 'mine' ? 'in your name' : scope === 'department' ? 'from your department' : 'visible to you'}${debouncedQ ? ` matching “${debouncedQ}”` : ''}.`
            : 'Loading the register…'
        }
      >
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search reference, title or supplier"
              className="pl-8"
              aria-label="Search requests"
            />
          </div>
          <Select
            value={scope}
            onValueChange={(v) => {
              setScope(v as 'mine' | 'department' | 'visible')
              setPage(1)
            }}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="Filter by scope">
              <SelectValue placeholder="Scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mine">Created by me</SelectItem>
              {user?.departmentId ? <SelectItem value="department">My department</SelectItem> : null}
              <SelectItem value="visible">All visible to me</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v)
              setPage(1)
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Filter by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUS_KEYS.map((s) => (
                <SelectItem key={s} value={s}>
                  {DOCUMENT_STATUS_META[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={categoryId}
            onValueChange={(v) => {
              setCategoryId(v)
              setPage(1)
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Filter by category">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {(meta?.categories ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => {
              setPageSize(Number(v))
              setPage(1)
            }}
          >
            <SelectTrigger className="w-full sm:w-28" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        {loading && !data ? (
          <TableSkeleton />
        ) : error ? (
          <EmptyState
            title="Requests unavailable"
            description={error}
            action={
              <Button variant="outline" size="sm" onClick={bumpData}>
                Retry
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No requests match these filters"
            description="Adjust the search or filters, or create a new request."
          />
        ) : (
          <div className="max-h-[520px] overflow-y-auto fc-scroll">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Reference</TableHead>
                    <TableHead className="min-w-56">Title</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead className="w-16 text-right">Version</TableHead>
                    <TableHead className="w-28">Updated</TableHead>
                    <TableHead className="w-36 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => {
                    const meta_ = DOCUMENT_STATUS_META[d.status]
                    const actionable = d.status === 'DRAFT' || d.status === 'RETURNED'
                    return (
                      <TableRow key={d.id}>
                        <TableCell className="fc-num font-medium">{d.reference}</TableCell>
                        <TableCell>
                          <p className="font-medium leading-tight">{d.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {d.categoryName}
                            {d.supplierName ? ` · ${d.supplierName}` : ''}
                          </p>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="fc-num font-semibold">{formatAmount(d.amount, d.currency)}</span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge variant={meta_.variant}>{meta_.label}</StatusBadge>
                        </TableCell>
                        <TableCell className="fc-num text-right text-muted-foreground">
                          v{d.currentVersion}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{timeAgo(d.updatedAt)}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button variant="outline" size="sm" onClick={() => openDocument(d.id)}>
                              <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                              View
                            </Button>
                            {actionable ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="sm" aria-label={`More actions for ${d.reference}`}>
                                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-52">
                                  <DropdownMenuItem onClick={() => openAction('submit', d)}>
                                    <Send className="mr-2 h-4 w-4" aria-hidden />
                                    Submit for approval
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => openAction('version', d)}>
                                    <FileUp className="mr-2 h-4 w-4" aria-hidden />
                                    Upload new version
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="text-red-600 focus:text-red-600"
                                    onClick={() => openAction('cancel', d)}
                                  >
                                    <Ban className="mr-2 h-4 w-4" aria-hidden />
                                    Cancel request
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => openDocument(d.id)}>
                                    <Eye className="mr-2 h-4 w-4" aria-hidden />
                                    View details
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Pagination footer */}
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

      {/* Dialogs */}
      <NewRequestDialog
        open={dialog === 'create'}
        onOpenChange={(o) => (o ? null : closeAction())}
        meta={meta}
        onDone={afterMutation}
      />
      <SubmitRequestDialog
        open={dialog === 'submit'}
        onOpenChange={(o) => (o ? null : closeAction())}
        doc={dialog === 'submit' ? actionDoc : null}
        meta={meta}
        onDone={afterMutation}
      />
      <UploadVersionDialog
        open={dialog === 'version'}
        onOpenChange={(o) => (o ? null : closeAction())}
        doc={dialog === 'version' ? actionDoc : null}
        onDone={afterMutation}
      />
      <CancelRequestDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => (o ? null : closeAction())}
        doc={dialog === 'cancel' ? actionDoc : null}
        onDone={afterMutation}
      />
    </div>
  )
}
