import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit'
import { getClientIp, handle, requirePermission, requireUser, ApiError } from '@/server/api'

function csvEscape(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value)
  const s = /^[=+\-@\t]/.test(raw) ? `'${raw}` : raw
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(',')
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(',')).join('\n')
  return `${header}\n${body}\n`
}

/**
 * GET /api/audit/export?format=csv|json&type=events|exceptions|logins
 * Exportable audit reports. Every export is itself audited.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'audit.export')
    const url = new URL(req.url)
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv'
    const type = url.searchParams.get('type') ?? 'events'

    let rows: Record<string, unknown>[] = []
    let columns: string[] = []

    if (type === 'events') {
      const events = await db.auditEvent.findMany({
        include: { actor: { select: { name: true, email: true } } },
        orderBy: { seq: 'asc' },
      })
      columns = ['seq', 'occurredAt', 'actor', 'actorRole', 'action', 'entityType', 'entityId', 'ip', 'hash', 'prevHash']
      rows = events.map((e) => ({
        seq: e.seq,
        occurredAt: e.occurredAt.toISOString(),
        actor: e.actor?.email ?? 'SYSTEM',
        actorRole: e.actorRole ?? '',
        action: e.action,
        entityType: e.entityType ?? '',
        entityId: e.entityId ?? '',
        ip: e.ip ?? '',
        hash: e.hash,
        prevHash: e.prevHash,
      }))
    } else if (type === 'exceptions') {
      const exceptions = await db.controlException.findMany({
        include: { document: { select: { reference: true } }, subject: { select: { email: true } } },
        orderBy: { detectedAt: 'asc' },
      })
      columns = ['detectedAt', 'type', 'severity', 'document', 'subject', 'message', 'resolvedAt', 'resolution']
      rows = exceptions.map((x) => ({
        detectedAt: x.detectedAt.toISOString(),
        type: x.type,
        severity: x.severity,
        document: x.document?.reference ?? '',
        subject: x.subject?.email ?? '',
        message: x.message,
        resolvedAt: x.resolvedAt?.toISOString() ?? '',
        resolution: x.resolution ?? '',
      }))
    } else if (type === 'logins') {
      const attempts = await db.loginAttempt.findMany({ orderBy: { createdAt: 'asc' } })
      columns = ['createdAt', 'email', 'success', 'reason', 'ip']
      rows = attempts.map((a) => ({
        createdAt: a.createdAt.toISOString(),
        email: a.email,
        success: a.success,
        reason: a.reason ?? '',
        ip: a.ip ?? '',
      }))
    } else {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown export type.')
    }

    await recordAudit(db, {
      actor: { id: user.id, role: user.role },
      action: 'AUDIT_EXPORTED',
      entityType: 'system',
      details: { format, type, rowCount: rows.length },
      ip: getClientIp(req),
    })

    if (format === 'json') {
      return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), type, rows }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="flowcontrol-audit-${type}-${Date.now()}.json"`,
        },
      })
    }
    return new Response(toCsv(rows, columns), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="flowcontrol-audit-${type}-${Date.now()}.csv"`,
      },
    })
  })
}
