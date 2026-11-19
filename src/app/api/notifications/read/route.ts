import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { assertSameOrigin, handle, json, parseBody, requireUser } from '@/server/api'

const readSchema = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
})

/** POST /api/notifications/read — mark specific notifications (or all) as read. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    const body = await parseBody(req, readSchema)

    if (body.all) {
      await db.notification.updateMany({ where: { userId: user.id, isRead: false }, data: { isRead: true } })
    } else if (body.ids && body.ids.length > 0) {
      await db.notification.updateMany({
        where: { userId: user.id, id: { in: body.ids } },
        data: { isRead: true },
      })
    }
    return json({ ok: true })
  })
}
