import type { NextRequest } from 'next/server'
import { assertSameOrigin, getClientIp, handle, json, requirePermission, requireUser } from '@/server/api'
import { runControlMonitors } from '@/server/monitors'

/** POST /api/admin/monitors — run the internal control monitors on demand. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    requirePermission(user, 'admin.monitors')
    const summary = await runControlMonitors(user, getClientIp(req))
    return json({ ok: true, summary })
  })
}
