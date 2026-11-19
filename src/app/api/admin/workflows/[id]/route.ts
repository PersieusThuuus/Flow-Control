import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit'
import {
  ApiError,
  assertSameOrigin,
  getClientIp,
  handle,
  json,
  parseBody,
  requirePermission,
  requireUser,
} from '@/server/api'
import { APPROVER_ROLES } from '@/server/rbac'
import { serializeWorkflow } from '@/server/serializers'

const stageSchema = z.object({
  id: z.string().optional().nullable(),
  sequence: z.number().int().min(1).max(999),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional().nullable(),
  approverRole: z.enum(APPROVER_ROLES as [string, ...string[]]),
  departmentScope: z.enum(['ANY', 'DOCUMENT', 'FIXED']),
  departmentId: z.string().optional().nullable(),
  minAmount: z.number().int().min(0).max(999_999_999_999).optional().nullable(),
  maxAmount: z.number().int().min(0).max(999_999_999_999).optional().nullable(),
  isRequired: z.boolean(),
  slaHours: z.number().int().min(1).max(2160).optional().nullable(),
})

const patchSchema = z.object({
  name: z.string().min(3).max(120).optional(),
  description: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
  minAmount: z.number().int().min(0).max(999_999_999_999).optional().nullable(),
  maxAmount: z.number().int().min(0).max(999_999_999_999).optional().nullable(),
  stages: z.array(stageSchema).min(1).optional(),
})

/**
 * PATCH /api/admin/workflows/[id] — update a workflow. When `stages` is
 * provided, the stage set is REPLACED (stages are recreated). Historical
 * approvals are unaffected: they reference stages by ID/name snapshots, so
 * reconfiguration never rewrites approval history.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'admin.workflows')
    const { id } = await ctx.params
    const body = await parseBody(req, patchSchema)

    const target = await db.workflow.findUnique({ where: { id } })
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'Workflow not found.')

    if (body.stages) {
      const errors: string[] = []
      for (const s of body.stages) {
        if (s.departmentScope === 'FIXED' && !s.departmentId) {
          errors.push(`Stage "${s.name}": FIXED scope requires a department.`)
        }
      }
      if (body.stages.filter((s) => s.isRequired).length === 0) {
        errors.push('A workflow needs at least one required stage.')
      }
      if (errors.length > 0) throw new ApiError(422, 'VALIDATION_ERROR', errors.join(' '))
    }

    const workflow = await db.$transaction(async (tx) => {
      await tx.workflow.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.minAmount !== undefined ? { minAmount: body.minAmount } : {}),
          ...(body.maxAmount !== undefined ? { maxAmount: body.maxAmount } : {}),
        },
      })
      if (body.stages) {
        await tx.workflowStage.deleteMany({ where: { workflowId: id } })
        for (const s of body.stages) {
          await tx.workflowStage.create({
            data: {
              workflowId: id,
              sequence: s.sequence,
              name: s.name,
              description: s.description ?? null,
              approverRole: s.approverRole,
              departmentScope: s.departmentScope,
              departmentId: s.departmentScope === 'FIXED' ? (s.departmentId ?? null) : null,
              minAmount: s.minAmount ?? null,
              maxAmount: s.maxAmount ?? null,
              isRequired: s.isRequired,
              slaHours: s.slaHours ?? null,
            },
          })
        }
      }
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'WORKFLOW_CONFIG_CHANGED',
        entityType: 'workflow',
        entityId: id,
        details: {
          code: target.code,
          stagesReplaced: body.stages ? body.stages.length : undefined,
          isActiveChanged: body.isActive !== undefined ? body.isActive : undefined,
        },
        ip: getClientIp(req),
      })
      return tx.workflow.findUnique({
        where: { id },
        include: { category: true, stages: { include: { department: true } } },
      })
    })
    if (!workflow) throw new ApiError(500, 'INTERNAL', 'Workflow update failed unexpectedly.')

    return json({ workflow: serializeWorkflow(workflow) })
  })
}
