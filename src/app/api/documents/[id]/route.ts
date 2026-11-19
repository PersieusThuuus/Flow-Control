import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, handle, json, requireUser } from '@/server/api'
import { canViewDocument, currentStepOf, eligibleStagesForUser } from '@/server/engine'
import { hasPermission } from '@/server/rbac'
import {
  serializeApproval,
  serializeDocumentSummary,
  serializeException,
  serializeInstance,
  serializeVersion,
  resolveUserNames,
} from '@/server/serializers'

/**
 * GET /api/documents/[id] — full request detail with object-level
 * authorization. Includes versions, approval history, control exceptions and
 * the current user's action eligibility (for the approval interface).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser()
    const { id } = await ctx.params

    const allowed = await canViewDocument(user, id)
    if (!allowed) {
      // Unauthorized access attempts are recorded for the audit dashboard.
      const doc = await db.document.findUnique({ where: { id }, select: { reference: true } })
      await db.controlException.create({
        data: {
          type: 'UNAUTHORIZED_ACCESS',
          severity: 'MEDIUM',
          message: `User ${user.email} attempted to access document ${doc?.reference ?? id} without authorization.`,
          documentId: doc ? id : null,
          userId: user.id,
        },
      })
      const { recordAudit } = await import('@/server/audit')
      await recordAudit(db, {
        actor: { id: user.id, role: user.role },
        action: 'UNAUTHORIZED_ACCESS_BLOCKED',
        entityType: 'document',
        entityId: id,
        details: { email: user.email, reference: doc?.reference ?? id },
      })
      throw new ApiError(403, 'FORBIDDEN', 'You are not authorized to view this document.')
    }

    const document = await db.document.findUnique({
      where: { id },
      include: { department: true, category: true, createdBy: { select: { id: true, name: true, email: true } } },
    })
    if (!document) throw new ApiError(404, 'NOT_FOUND', 'Document not found.')

    const versions = await db.documentVersion.findMany({
      where: { documentId: id },
      include: { uploadedBy: { select: { id: true, name: true } } },
      orderBy: { version: 'desc' },
    })

    const instances = await db.workflowInstance.findMany({
      where: { documentId: id },
      include: { workflow: { select: { id: true, name: true, code: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const approvals = await db.approval.findMany({
      where: { instanceId: { in: instances.map((i) => i.id) } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        documentVersion: { select: { version: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    const approvalNameMap = await resolveUserNames(approvals.map((a) => a.delegatedFromId))

    const exceptions = await db.controlException.findMany({
      where: { documentId: id },
      include: {
        document: { select: { reference: true, title: true } },
        subject: { select: { id: true, name: true, email: true } },
      },
      orderBy: { detectedAt: 'desc' },
    })

    // Current user's action eligibility on the active instance (approval UI).
    const activeInstance = instances.find((i) => i.status === 'IN_PROGRESS') ?? null
    let eligibleStages: Awaited<ReturnType<typeof eligibleStagesForUser>> = []
    if (activeInstance) {
      eligibleStages = await eligibleStagesForUser(db, user, activeInstance, document)
    }

    const canManage =
      document.createdById === user.id &&
      ['DRAFT', 'RETURNED'].includes(document.status)

    return json({
      document: serializeDocumentSummary(document),
      versions: versions.map(serializeVersion),
      instances: instances.map(serializeInstance),
      approvals: approvals.map((a) => ({
        ...serializeApproval(a),
        delegatedFromName: a.delegatedFromId ? approvalNameMap.get(a.delegatedFromId) ?? null : null,
      })),
      exceptions: exceptions.map(serializeException),
      activeInstanceId: activeInstance?.id ?? null,
      permissions: {
        canView: true,
        canManage,
        canSubmit: canManage,
        canUploadVersion: canManage,
        canCancel:
          (document.createdById === user.id && document.status !== 'APPROVED' && document.status !== 'REJECTED' && document.status !== 'CANCELLED') ||
          (user.role === 'SUPER_ADMIN' && !['APPROVED', 'REJECTED', 'CANCELLED'].includes(document.status)),
        canSuspend:
          user.role === 'SUPER_ADMIN' &&
          instances.some((i) => i.status === 'IN_PROGRESS' || i.status === 'SUSPENDED'),
        isAuditor: hasPermission(user, 'audit.view'),
        currentStage: activeInstance ? currentStepOf(activeInstance)?.stages.map((s) => s.name).join(' + ') ?? null : null,
      },
      eligibleStages: eligibleStages.map((e) => ({
        stageId: e.stage.stageId,
        name: e.stage.name,
        isRequired: e.stage.isRequired,
        delegatedFromName: e.delegatorName,
      })),
    })
  })
}
