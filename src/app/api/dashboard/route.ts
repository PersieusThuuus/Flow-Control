import type { NextRequest } from 'next/server'
import { handle, json, parseFiltersFromUrl, requireUser } from '@/server/api'
import { computeDashboard } from '@/server/stats'

/** Role-scoped dashboard: every KPI is computed live from database records. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    const url = new URL(req.url)
    const f = parseFiltersFromUrl(url)
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
