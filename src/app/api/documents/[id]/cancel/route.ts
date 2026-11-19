import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, assertSameOrigin, getClientIp, handle, json, parseBody, requireUser } from '@/server/api'
import { cancelDocument } from '@/server/engine'

const cancelSchema = z.object({ reason: z.string().min(3).max(500) })

/** POST /api/documents/[id]/cancel — cancel with reason (creator pre-approval, admin anytime). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    const { id } = await ctx.params
    const { reason } = await parseBody(req, cancelSchema)

    const result = await cancelDocument({ user, documentId: id, reason, ip: getClientIp(req) })
    if (!result.ok) throw new ApiError(result.status, result.code, result.message)
    return json({ ok: true, message: result.message })
  })
}
