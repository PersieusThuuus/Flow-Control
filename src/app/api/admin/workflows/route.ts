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

/** GET /api/admin/workflows — full workflow configurations with stages. */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'admin.workflows')
    const workflows = await db.workflow.findMany({
      include: { category: true, stages: { include: { department: true } } },
      orderBy: { code: 'asc' },
    })
    return json({ items: workflows.map(serializeWorkflow) })
  })
}

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

const createSchema = z.object({
  code: z.string().min(2).max(30).regex(/^[A-Z0-9_-]+$/),
  name: z.string().min(3).max(120),
  description: z.string().max(500).optional().nullable(),
  categoryId: z.string(),
  isActive: z.boolean().default(true),
  minAmount: z.number().int().min(0).max(999_999_999_999).optional().nullable(),
  maxAmount: z.number().int().min(0).max(999_999_999_999).optional().nullable(),
  stages: z.array(stageSchema).min(1),
})

function validateStages(stages: z.infer<typeof stageSchema>[]): string[] {
  const errors: string[] = []
  for (const s of stages) {
    if (s.departmentScope === 'FIXED' && !s.departmentId) {
      errors.push(`Stage "${s.name}": FIXED scope requires a department.`)
    }
    if (s.minAmount !== null && s.minAmount !== undefined && s.maxAmount !== null && s.maxAmount !== undefined && s.minAmount > s.maxAmount) {
      errors.push(`Stage "${s.name}": minimum amount exceeds maximum amount.`)
    }
    if (!APPROVER_ROLES.includes(s.approverRole as never)) {
      errors.push(`Stage "${s.name}": role ${s.approverRole} may not approve documents.`)
    }
  }
  const requiredStages = stages.filter((s) => s.isRequired)
  if (requiredStages.length === 0) errors.push('A workflow needs at least one required stage.')
  return errors
}

/** POST /api/admin/workflows — create a workflow with its stages. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'admin.workflows')
    const body = await parseBody(req, createSchema)

    const errors = validateStages(body.stages)
    if (errors.length > 0) throw new ApiError(422, 'VALIDATION_ERROR', errors.join(' '))
    const category = await db.documentCategory.findUnique({ where: { id: body.categoryId } })
    if (!category) throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown category.')
    const existing = await db.workflow.findUnique({ where: { code: body.code } })
    if (existing) throw new ApiError(422, 'DUPLICATE', 'A workflow with this code already exists.')

    const workflow = await db.$transaction(async (tx) => {
      const created = await tx.workflow.create({
        data: {
          code: body.code,
          name: body.name,
          description: body.description ?? null,
          categoryId: body.categoryId,
          isActive: body.isActive,
          minAmount: body.minAmount ?? null,
          maxAmount: body.maxAmount ?? null,
        },
      })
      for (const s of body.stages) {
        await tx.workflowStage.create({
          data: {
            workflowId: created.id,
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
      await recordAudit(tx, {
        actor: { id: user.id, role: user.role },
        action: 'WORKFLOW_CONFIG_CHANGED',
        entityType: 'workflow',
        entityId: created.id,
        details: { code: body.code, name: body.name, created: true, stageCount: body.stages.length },
        ip: getClientIp(req),
      })
      return tx.workflow.findUnique({
        where: { id: created.id },
        include: { category: true, stages: { include: { department: true } } },
      })
    })
    if (!workflow) throw new ApiError(500, 'INTERNAL', 'Workflow creation failed unexpectedly.')

    return json({ workflow: serializeWorkflow(workflow) }, 201)
  })
}
