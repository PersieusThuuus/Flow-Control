import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { login, setSessionCookie } from '@/server/auth'
import { recordAudit } from '@/server/audit'
import { assertSameOrigin, getClientIp, handle, json, parseBody, ApiError } from '@/server/api'

const loginSchema = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
})

export async function POST(req: NextRequest) {
  return handle(async () => {
    assertSameOrigin(req)
    const { email, password } = await parseBody(req, loginSchema)
    const ip = getClientIp(req)
    const userAgent = req.headers.get('user-agent')?.slice(0, 250) ?? null
    const normalizedEmail = email.trim().toLowerCase()

    const result = await login(normalizedEmail, password, ip, userAgent)

    // Every attempt is recorded (LoginAttempt table) and audited (hash chain).
    await db.loginAttempt.create({
      data: {
        email: normalizedEmail,
        success: result.ok,
        reason: result.ok ? 'OK' : result.code,
        ip,
        userAgent,
      },
    })

    if (!result.ok) {
      await recordAudit(db, {
        actor: null,
        action: 'LOGIN_FAILED',
        entityType: 'user',
        entityId: normalizedEmail,
        details: { email: normalizedEmail, reason: result.code },
        ip,
      })
      const status = result.code === 'ACCOUNT_LOCKED' ? 423 : result.code === 'ACCOUNT_DISABLED' ? 403 : 401
      throw new ApiError(status, result.code, result.message)
    }

    await recordAudit(db, {
      actor: { id: result.user.id, role: result.user.role },
      action: 'LOGIN_SUCCESS',
      entityType: 'user',
      entityId: result.user.id,
      details: { email: normalizedEmail },
      ip,
    })
    await setSessionCookie(result.token)
    return json({ user: result.user })
  })
}
