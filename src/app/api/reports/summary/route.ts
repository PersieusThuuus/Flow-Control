import type { NextRequest } from 'next/server'
import { handle, json, parseFiltersFromUrl, requirePermission, requireUser } from '@/server/api'
import { computeDashboard } from '@/server/stats'

/** GET /api/reports/summary — aggregations for the reporting center (role-scoped). */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    requirePermission(user, 'reports.view')
    const f = parseFiltersFromUrl(new URL(req.url))
    const data = await computeDashboard(user, {
      from: f.from,
      to: f.to,
      departmentId: f.departmentId,
      categoryId: f.categoryId,
      status: f.status,
      userId: f.userId,
      minAmount: f.minAmount,
      maxAmount: f.maxAmount,
    })
    return json(data)
  })
}
