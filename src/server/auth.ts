// ============================================================================
// FlowControl — Authentication & Session Management
//
// - Passwords: scrypt (N=16384, r=8, p=1) with per-user random salt,
//   constant-time comparison. Policy: >=10 chars, upper, lower, digit, special.
// - Sessions: 256-bit random bearer token in an httpOnly, SameSite=Lax cookie.
//   Only an HMAC-SHA256(token, SESSION_SECRET) digest is stored in the
//   database, so a database leak does not yield usable session tokens.
// - Lockout: 5 consecutive failures lock the account for 15 minutes.
// ============================================================================

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import type { SessionUser } from './rbac'
import type { RoleKey } from './rbac'

export const SESSION_COOKIE = 'fc_session'
export const SESSION_TTL_HOURS = 8
export const MAX_FAILED_LOGINS = 5
export const LOCKOUT_MINUTES = 15
const DUMMY_PASSWORD_HASH = hashPassword('FlowControlDummy!123')

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 16) {
    // Fail closed in production, permissive default only for local development.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET must be set (>= 16 characters) in production')
    }
    return 'flowcontrol-dev-only-secret'
  }
  return secret
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const N = 16384
  const r = 8
  const p = 1
  const derived = scryptSync(password, salt, 64, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split('$')
    if (scheme !== 'scrypt') return false
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const derived = scryptSync(password, salt, expected.length, {
      N: parseInt(N, 10),
      r: parseInt(r, 10),
      p: parseInt(p, 10),
    })
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

export type PasswordPolicyResult = { valid: boolean; errors: string[] }

export function validatePasswordPolicy(password: string): PasswordPolicyResult {
  const errors: string[] = []
  if (password.length < 10) errors.push('At least 10 characters')
  if (!/[a-z]/.test(password)) errors.push('At least one lowercase letter')
  if (!/[A-Z]/.test(password)) errors.push('At least one uppercase letter')
  if (!/[0-9]/.test(password)) errors.push('At least one digit')
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('At least one special character')
  return { valid: errors.length === 0, errors }
}

function tokenHashFor(token: string): string {
  return createHmac('sha256', sessionSecret()).update(token).digest('hex')
}

export type LoginResult =
  | { ok: true; user: SessionUser; token: string }
  | { ok: false; code: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | 'ACCOUNT_DISABLED'; message: string }

/**
 * Verify credentials, enforce lockout, and create a session.
 * Every attempt (success or failure) is recorded in LoginAttempt and in the
 * audit chain by the calling route.
 */
export async function login(
  email: string,
  password: string,
  ip: string | null,
  userAgent: string | null,
): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase()
  const user = await db.user.findUnique({ where: { email: normalized }, include: { department: true } })
  const genericFailure = { ok: false as const, code: 'INVALID_CREDENTIALS' as const, message: 'Invalid email or password.' }

  if (!user) {
    verifyPassword(password, DUMMY_PASSWORD_HASH)
    return genericFailure
  }

  const now = new Date()
  if (user.lockedUntil && user.lockedUntil > now) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60000)
    return {
      ok: false,
      code: 'ACCOUNT_LOCKED',
      message: `Account temporarily locked after repeated failed attempts. Try again in ${minutes} minute(s).`,
    }
  }

  const passwordValid = verifyPassword(password, user.passwordHash)
  if (!passwordValid) {
    const updatedUser = await db.user.update({
      where: { id: user.id },
      data: { failedLogins: { increment: 1 } },
      select: { failedLogins: true },
    })
    const failedLogins = updatedUser.failedLogins
    const shouldLock = failedLogins >= MAX_FAILED_LOGINS
    await db.user.update({
      where: { id: user.id },
      data: {
        lockedUntil: shouldLock ? new Date(now.getTime() + LOCKOUT_MINUTES * 60000) : null,
      },
    })
    return shouldLock
      ? { ok: false, code: 'ACCOUNT_LOCKED', message: `Account locked for ${LOCKOUT_MINUTES} minutes after ${MAX_FAILED_LOGINS} failed attempts.` }
      : genericFailure
  }

  if (!user.isActive) {
    return { ok: false, code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated. Contact an administrator.' }
  }

  // Success: reset counters, create session.
  await db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } })
  const token = randomBytes(32).toString('hex')
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: tokenHashFor(token),
      ip,
      userAgent,
      expiresAt: new Date(now.getTime() + SESSION_TTL_HOURS * 3600_000),
    },
  })

  return { ok: true, user: toSessionUser(user), token }
}

export function toSessionUser(user: {
  id: string
  email: string
  name: string
  role: string
  jobTitle: string | null
  departmentId: string | null
  department?: { name: string; code: string } | null
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as RoleKey,
    jobTitle: user.jobTitle,
    departmentId: user.departmentId,
    departmentName: user.department?.name ?? null,
    departmentCode: user.department?.code ?? null,
  }
}

/** Resolve the current user from the session cookie. Returns null when absent/expired. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = await db.session.findUnique({
    where: { tokenHash: tokenHashFor(token) },
    include: { user: { include: { department: true } } },
  })
  if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.isActive) {
    return null
  }
  return toSessionUser(session.user)
}

export async function revokeCurrentSession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return
  await db.session.updateMany({ where: { tokenHash: tokenHashFor(token), revokedAt: null }, data: { revokedAt: new Date() } })
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_HOURS * 3600,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
}
