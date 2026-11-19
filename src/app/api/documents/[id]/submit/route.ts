import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, assertSameOrigin, getClientIp, handle, json, parseBody, requireUser } from '@/server/api'
import { submitDocument } from '@/server/engine'

const submitSchema = z.object({})

/** POST /api/documents/[id]/submit — start (or restart) the approval workflow. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req)
    const user = await requireUser()
    const { id } = await ctx.params
    await parseBody(req, submitSchema).catch(() => ({})) // tolerate empty body

    const result = await submitDocument({ user, documentId: id, ip: getClientIp(req) })
    if (!result.ok) throw new ApiError(result.status, result.code, result.message)
    return json({ ok: true, instanceId: result.instanceId, steps: result.startedSteps })
  })
}
