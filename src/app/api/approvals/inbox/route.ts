import { handle, json, requireUser } from '@/server/api'
import { getInbox } from '@/server/engine'

/** GET /api/approvals/inbox — approval tasks awaiting the current user (incl. delegated). */
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    const items = await getInbox(user)
    return json({
      items: items.map((item) => ({
        instanceId: item.instance.id,
        documentId: item.document.id,
        reference: item.document.reference,
        title: item.document.title,
        categoryName: item.document.category.name,
        departmentName: item.document.department.name,
        supplierName: item.document.supplierName,
        amount: Number(item.document.amount),
        currency: item.document.currency,
        submittedAt: item.instance.submittedAt.toISOString(),
        stepStartedAt: item.instance.currentStepStartedAt.toISOString(),
        currentStep: item.instance.currentStep,
        totalSteps: JSON.parse(item.instance.stagePath).length,
        cycle: item.instance.cycle,
        dueAt: item.dueAt?.toISOString() ?? null,
        stages: item.eligibleStages.map((e) => ({
          stageId: e.stage.stageId,
          name: e.stage.name,
          delegatedFromName: e.delegatorName,
        })),
      })),
    })
  })
}
