import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { readVersionBytes } from '@/server/documents'
import { recordAudit } from '@/server/audit'
import { ApiError, assertSameOrigin, getClientIp, handle, requireUser } from '@/server/api'
import { canViewDocument } from '@/server/engine'

/**
 * GET /api/documents/[id]/download?version=N — authorized download from the
 * private vault. Every download of a non-latest version (audit-relevant) and
 * every download overall is audited. Files are served with
 * X-Content-Type-Options: nosniff and a Content-Disposition header.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    const { id } = await ctx.params
    const url = new URL(req.url)
    const versionParam = url.searchParams.get('version')

    if (!(await canViewDocument(user, id))) {
      throw new ApiError(403, 'FORBIDDEN', 'You are not authorized to download this document.')
    }

    const document = await db.document.findUnique({ where: { id } })
    if (!document) throw new ApiError(404, 'NOT_FOUND', 'Document not found.')

    const version = versionParam ? parseInt(versionParam, 10) : document.currentVersion
    const row = await db.documentVersion.findUnique({
      where: { documentId_version: { documentId: id, version } },
    })
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Version not found.')

    const bytes = await readVersionBytes(row.storageKey)

    await recordAudit(db, {
      actor: { id: user.id, role: user.role },
      action: 'DOCUMENT_DOWNLOADED',
      entityType: 'document',
      entityId: id,
      details: { reference: document.reference, version: row.version, sha256: row.sha256 },
      ip: getClientIp(req),
    })

    const inline = row.mimeType === 'application/pdf' || row.mimeType.startsWith('image/')
    const safeName = row.fileName.replace(/[^\w.\- ]/g, '_')
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': row.mimeType,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    })
  })
}
