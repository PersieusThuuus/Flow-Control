import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { addDocumentVersion, validateUpload } from '@/server/documents'
import { recordAudit } from '@/server/audit'
import { ApiError, assertSameOrigin, getClientIp, handle, json, requireUser } from '@/server/api'
import { serializeVersion } from '@/server/serializers'

/**
 * POST /api/documents/[id]/versions — append a new immutable version.
 * Only the creator (or an admin) may add versions, and only while the
 * document is a DRAFT or has been RETURNED for correction. Files under
 * active review can never be replaced (approval integrity).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    const { id } = await ctx.params

    const form = await req.formData().catch(() => {
      throw new ApiError(400, 'BAD_FORM', 'Request must be multipart/form-data.')
    })
    const note = String(form.get('note') ?? '').trim() || null

    const document = await db.document.findUnique({ where: { id } })
    if (!document) throw new ApiError(404, 'NOT_FOUND', 'Document not found.')
    if (document.createdById !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ApiError(403, 'FORBIDDEN', 'Only the creator may upload a new version.')
    }
    if (!['DRAFT', 'RETURNED'].includes(document.status)) {
      throw new ApiError(409, 'INVALID_STATE', 'A new version can only be added to a draft or a returned document.')
    }

    const file = form.get('file')
    if (!(file instanceof File)) throw new ApiError(422, 'VALIDATION_ERROR', 'A file is required.')
    const validation = await validateUpload(file)
    if (!validation.ok) throw new ApiError(422, 'INVALID_FILE', validation.error)
    if (validation.sha256 === (await db.documentVersion.findFirst({ where: { documentId: id }, orderBy: { version: 'desc' } }))?.sha256) {
      throw new ApiError(422, 'DUPLICATE_CONTENT', 'The uploaded file is identical (same SHA-256) to the latest version.')
    }

    const result = await db.$transaction(async (tx) => {
      const { version } = await addDocumentVersion(tx, {
        documentId: id,
        buffer: validation.buffer,
        originalName: validation.originalName,
        ext: validation.ext,
        mimeType: validation.mimeType,
        sha256: validation.sha256,
        sizeBytes: validation.sizeBytes,
        uploadedById: user.id,
        note,
      })
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'DOCUMENT_VERSION_UPLOADED',
        entityType: 'document',
        entityId: id,
        details: { reference: document.reference, version, sha256: validation.sha256, note },
        ip: getClientIp(req),
      })
      return tx.documentVersion.findUnique({
        where: { documentId_version: { documentId: id, version } },
        include: { uploadedBy: { select: { id: true, name: true } } },
      })
    })
    if (!result) throw new ApiError(500, 'INTERNAL', 'Version creation failed unexpectedly.')

    return json({ version: serializeVersion(result) }, 201)
  })
}
