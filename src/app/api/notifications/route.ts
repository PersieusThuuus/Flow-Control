import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { handle, json, requireUser } from '@/server/api'
import { serializeNotification } from '@/server/serializers'

/** GET /api/notifications — latest notifications + unread count (polled). */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const user = await requireUser()
    const [items, unreadCount] = await Promise.all([
      db.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      db.notification.count({ where: { userId: user.id, isRead: false } }),
    ])
    return json({ items: items.map(serializeNotification), unreadCount })
  })
}
