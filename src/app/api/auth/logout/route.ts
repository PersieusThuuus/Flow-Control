import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { clearSessionCookie, revokeCurrentSession, getCurrentUser } from '@/server/auth'
import { recordAudit } from '@/server/audit'
import { assertSameOrigin, getClientIp, handle, json } from '@/server/api'

export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await getCurrentUser()
    await revokeCurrentSession()
    await clearSessionCookie()
    if (user) {
      await recordAudit(db, {
        actor: { id: user.id, role: user.role },
        action: 'LOGOUT',
        entityType: 'user',
        entityId: user.id,
        ip: getClientIp(req),
      })
    }
    return json({ ok: true })
  })
}
