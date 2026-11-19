import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { addDocumentVersion, nextDocumentReference, validateUpload } from '@/server/documents'
import { recordAudit } from '@/server/audit'
import {
  ApiError,
  assertSameOrigin,
  getClientIp,
  handle,
  json,
  parsePagination,
  requirePermission,
  requireUser,
  toBigIntAmount,
} from '@/server/api'
import type { Prisma } from '@prisma/client'
import { serializeDocumentSummary } from '@/server/serializers'
import { visibleDocumentsWhere } from '@/server/visibility'

/**
 * GET /api/documents — visible documents with filters and pagination.
 * Visibility is enforced server-side (anti-IDOR): own documents, department
 * documents (when the role grants it), routed/participated documents, or all
 * for administrators and auditors.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    const url = new URL(req.url)
    const { page, pageSize, skip, take } = parsePagination(url)
    const status = url.searchParams.get('status')
    const categoryId = url.searchParams.get('categoryId')
    const departmentId = url.searchParams.get('departmentId')
    const scope = url.searchParams.get('scope') // mine | department | all
    const q = url.searchParams.get('q')
    const minAmount = url.searchParams.get('minAmount')
    const maxAmount = url.searchParams.get('maxAmount')

    // Filters (never self-referential — Prisma where objects are plain data).
    const filters: Prisma.DocumentWhereInput = {
      ...(status ? { status } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(q
        ? {
            OR: [
              { reference: { contains: q } },
              { title: { contains: q } },
              { supplierName: { contains: q } },
            ],
          }
        : {}),
      ...(minAmount ? { amount: { gte: toBigIntAmount(parseInt(minAmount, 10)) } } : {}),
      ...(maxAmount ? { amount: { lte: toBigIntAmount(parseInt(maxAmount, 10)) } } : {}),
    }

    // Visibility / scope (server-enforced, anti-IDOR).
    const visibility = await visibleDocumentsWhere(user)
    let scopeFilter: Prisma.DocumentWhereInput = {}
    if (scope === 'mine') {
      scopeFilter = { createdById: user.id }
    } else if (scope === 'department' && user.departmentId) {
      scopeFilter = { departmentId: user.departmentId }
    }

    const where: Prisma.DocumentWhereInput = { AND: [filters, visibility, scopeFilter] }

    const [total, documents] = await Promise.all([
      db.document.count({ where }),
      db.document.findMany({
        where,
        include: { department: true, category: true, createdBy: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ])

    return json({
      items: documents.map(serializeDocumentSummary),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    })
  })
}

/**
 * POST /api/documents — create a draft document (multipart).
 * The file is validated (extension, MIME, magic bytes, size), hashed (SHA-256)
 * and stored in the private vault as version 1.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'documents.create')

    const form = await req.formData().catch(() => {
      throw new ApiError(400, 'BAD_FORM', 'Request must be multipart/form-data.')
    })
    const title = String(form.get('title') ?? '').trim()
    const categoryId = String(form.get('categoryId') ?? '').trim()
    const amountRaw = String(form.get('amount') ?? '').trim()
    const description = String(form.get('description') ?? '').trim() || null
    const supplierName = String(form.get('supplierName') ?? '').trim() || null
    const currency = String(form.get('currency') ?? 'MAD').trim() || 'MAD'
    const evidenceJustification = String(form.get('evidenceJustification') ?? '').trim() || null
    let evidenceProvided: string[] = []
    try {
      const parsed = JSON.parse(String(form.get('evidenceProvided') ?? '[]'))
      if (Array.isArray(parsed)) evidenceProvided = parsed.map(String)
    } catch {
      evidenceProvided = []
    }

    const schema = z.object({ title: z.string().min(3).max(200) })
    schema.parse({ title })
    if (!categoryId) throw new ApiError(422, 'VALIDATION_ERROR', 'A document category is required.')
    const amount = toBigIntAmount(parseInt(amountRaw, 10) || -1)
    if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, 'VALIDATION_ERROR', 'Currency must be a 3-letter code.')

    const category = await db.documentCategory.findUnique({ where: { id: categoryId } })
    if (!category) throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown document category.')

    const file = form.get('file')
    if (!(file instanceof File)) throw new ApiError(422, 'VALIDATION_ERROR', 'A document file is required.')
    const validation = await validateUpload(file)
    if (!validation.ok) throw new ApiError(422, 'INVALID_FILE', validation.error)

    const departmentId = user.departmentId
    if (!departmentId) {
      throw new ApiError(422, 'NO_DEPARTMENT', 'Your account has no department assigned; a department is required to create requests.')
    }

    const document = await db.$transaction(async (tx) => {
      const reference = await nextDocumentReference(tx)
      const doc = await tx.document.create({
        data: {
          reference,
          title,
          description,
          categoryId,
          departmentId,
          createdById: user.id,
          supplierName,
          currency,
          amount,
          evidenceProvided: JSON.stringify(evidenceProvided),
          evidenceJustification,
          status: 'DRAFT',
          currentVersion: 0,
        },
      })
      await addDocumentVersion(tx, {
        documentId: doc.id,
        buffer: validation.buffer,
        originalName: validation.originalName,
        ext: validation.ext,
        mimeType: validation.mimeType,
        sha256: validation.sha256,
        sizeBytes: validation.sizeBytes,
        uploadedById: user.id,
        note: 'Initial version',
      })
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'DOCUMENT_CREATED',
        entityType: 'document',
        entityId: doc.id,
        details: {
          reference,
          title,
          amount: amount.toString(),
          currency,
          category: category.name,
          sha256: validation.sha256,
        },
        ip: getClientIp(req),
      })
      return tx.document.findUnique({
        where: { id: doc.id },
        include: { department: true, category: true, createdBy: { select: { id: true, name: true, email: true } } },
      })
    })
    if (!document) throw new ApiError(500, 'INTERNAL', 'Document creation failed unexpectedly.')

    return json({ document: serializeDocumentSummary(document) }, 201)
  })
}
