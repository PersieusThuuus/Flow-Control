import { db } from '@/lib/db'
import { requireUser } from '@/server/api'
import { handle, json } from '@/server/api'
import { ROLE_KEYS, ROLE_LABELS, APPROVER_ROLES } from '@/server/rbac'
import { serializeCategory, serializeDepartment } from '@/server/serializers'

/** Reference data for forms: categories, departments, role taxonomy, workflow catalogue. */
export async function GET() {
  return handle(async () => {
    await requireUser()
    const [categories, departments, workflows] = await Promise.all([
      db.documentCategory.findMany({ orderBy: { name: 'asc' } }),
      db.department.findMany({ orderBy: { name: 'asc' } }),
      db.workflow.findMany({
        where: { isActive: true },
        include: { category: true, stages: { orderBy: { sequence: 'asc' } } },
        orderBy: { name: 'asc' },
      }),
    ])
    return json({
      categories: categories.map(serializeCategory),
      departments: departments.map(serializeDepartment),
      roles: ROLE_KEYS.map((r) => ({ key: r, label: ROLE_LABELS[r], approver: APPROVER_ROLES.includes(r) })),
      workflows: workflows.map((w) => ({
        id: w.id,
        code: w.code,
        name: w.name,
        categoryId: w.categoryId,
        categoryName: w.category.name,
        minAmount: w.minAmount === null ? null : Number(w.minAmount),
        maxAmount: w.maxAmount === null ? null : Number(w.maxAmount),
        stageCount: w.stages.length,
      })),
    })
  })
}
