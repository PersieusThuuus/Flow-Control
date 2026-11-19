// ============================================================================
// FlowControl — Secure Document Vault
//
// - Upload validation: extension whitelist + declared MIME + magic bytes
//   (file signature) + size limit. Content is never trusted from its name.
// - Storage: files are written OUTSIDE the publicly served directory under
//   STORAGE_DIR with randomized names. Downloads are only possible through
//   an API route that performs authorization checks and records an audit
//   event. The original uploaded bytes are never modified.
// - Versioning: append-only. Every modification creates a new version row
//   with its own SHA-256; previous versions are preserved forever.
// ============================================================================

import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB ?? '10', 10)
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

export const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(process.cwd(), 'storage', 'documents')

type AllowedType = {
  ext: string
  mime: string
  /** Returns true when the first bytes match the expected file signature. */
  magic: (buf: Buffer) => boolean
}

const ALLOWED_TYPES: AllowedType[] = [
  {
    ext: '.pdf',
    mime: 'application/pdf',
    magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  {
    ext: '.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: (b) => b.subarray(0, 4).toString('latin1') === 'PK\x03\x04',
  },
  {
    ext: '.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    magic: (b) => b.subarray(0, 4).toString('latin1') === 'PK\x03\x04',
  },
  {
    ext: '.png',
    mime: 'image/png',
    magic: (b) => b.subarray(0, 4).toString('hex') === '89504e47',
  },
  {
    ext: '.jpg',
    mime: 'image/jpeg',
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
]

export type UploadValidation =
  | { ok: true; buffer: Buffer; ext: string; mimeType: string; sha256: string; sizeBytes: number; originalName: string }
  | { ok: false; error: string }

/** Full upload validation pipeline. Returns the pinned buffer on success. */
export function validateUpload(file: File): Promise<UploadValidation> {
  return (async () => {
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: 'A non-empty document file is required.' }
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return { ok: false, error: `File exceeds the maximum allowed size of ${MAX_UPLOAD_MB} MB.` }
    }
    const originalName = file.name ?? 'document'
    const ext = path.extname(originalName).toLowerCase()
    const allowed = ALLOWED_TYPES.find((t) => t.ext === ext)
    if (!allowed) {
      return {
        ok: false,
        error: `File type "${ext || 'unknown'}" is not allowed. Accepted: ${ALLOWED_TYPES.map((t) => t.ext).join(', ')}.`,
      }
    }
    const buffer = Buffer.from(await file.arrayBuffer())
    // Magic-byte verification: the declared/observed MIME type must match the
    // actual file signature. Generic browser MIME values are normalized.
    const observedMime = file.type || allowed.mime
    const mimeMatchesGroup =
      (ext === '.jpg' && observedMime === 'image/jpeg') ||
      observedMime === allowed.mime ||
      observedMime === 'application/octet-stream'
    if (!mimeMatchesGroup) {
      return { ok: false, error: 'The file content does not match its declared type.' }
    }
    if (!allowed.magic(buffer)) {
      return { ok: false, error: 'File signature check failed — the file content does not match its extension.' }
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    return { ok: true, buffer, ext, mimeType: allowed.mime, sha256, sizeBytes: buffer.length, originalName }
  })()
}

async function ensureStorage(): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true })
}

/**
 * Append a new immutable version to a document. Runs inside the caller's
 * transaction so version creation, document status change and the audit
 * event commit atomically.
 */
export async function addDocumentVersion(
  tx: Prisma.TransactionClient,
  params: {
    documentId: string
    buffer: Buffer
    originalName: string
    ext: string
    mimeType: string
    sha256: string
    sizeBytes: number
    uploadedById: string
    note?: string | null
  },
): Promise<{ version: number }> {
  await ensureStorage()
  const doc = await tx.document.findUnique({ where: { id: params.documentId }, select: { currentVersion: true } })
  if (!doc) throw new Error('Document not found')
  const version = doc.currentVersion + 1
  const storageKey = `${randomUUID()}${params.ext}`
  await writeFile(path.join(STORAGE_DIR, storageKey), params.buffer, { mode: 0o640 })
  await tx.documentVersion.create({
    data: {
      documentId: params.documentId,
      version,
      fileName: path.basename(params.originalName).slice(0, 200),
      storageKey,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      sha256: params.sha256,
      note: params.note ?? null,
      uploadedById: params.uploadedById,
    },
  })
  await tx.document.update({ where: { id: params.documentId }, data: { currentVersion: version } })
  return { version }
}

/** Read the raw bytes of a stored version (authorization is the caller's duty). */
export async function readVersionBytes(storageKey: string): Promise<Buffer> {
  // Defense in depth: refuse any path that tries to escape the vault.
  const safe = path.basename(storageKey)
  return readFile(path.join(STORAGE_DIR, safe))
}

/** Generate the next human-readable document reference (DOC-YYYY-NNNNN). */
export async function nextDocumentReference(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear()
  const count = await tx.document.count()
  let n = count + 1
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = `DOC-${year}-${String(n).padStart(5, '0')}`
    const exists = await tx.document.findUnique({ where: { reference }, select: { id: true } })
    if (!exists) return reference
    n++
  }
  return `DOC-${year}-${Date.now()}`
}
