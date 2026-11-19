// ============================================================================
// FlowControl — API Infrastructure Helpers
//
// Cross-cutting concerns for every route handler:
//   - Typed errors (ApiError) with a uniform error envelope
//   - Authentication guard (requireUser) and permission guards
//   - CSRF defense for state-changing verbs: Origin/Referer validation on
//     top of SameSite=Lax session cookies (defense in depth)
//   - Client IP resolution behind the reverse proxy
//   - Pagination and BigInt-aware amount parsing
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { ZodError, type ZodType } from 'zod'
import { getCurrentUser } from './auth'
import { hasPermission, type Permission, type SessionUser } from './rbac'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data as Record<string, unknown>, { status })
}

/**
 * Wrap a route handler with uniform error translation:
 *   ApiError        -> its status/code/message
 *   ZodError        -> 422 with field details
 *   anything else   -> 500 (internal details never leaked to the client)
 */
export function handle<T>(fn: () => Promise<T>): Promise<Response> {
  return fn()
    .then((result) => {
      // File downloads and exports return plain web Responses (NextResponse
      // extends Response, so this covers both) — pass them through untouched.
      if (result instanceof Response) return result
      return json(result)
    })
    .catch((error: unknown) => {
      if (error instanceof ApiError) {
        return json({ error: error.message, code: error.code }, error.status)
      }
      if (error instanceof ZodError) {
        return json(
          {
            error: 'Validation failed.',
            code: 'VALIDATION_ERROR',
            issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          422,
        )
      }
      console.error('[FlowControl] Unhandled API error:', error)
      return json({ error: 'Internal server error.', code: 'INTERNAL' }, 500)
    })
}

export function getClientIp(req: NextRequest): string {
  const realIp = req.headers.get('x-real-ip')
  if (realIp) return realIp.split(',')[0].trim()
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return 'unknown'
}

/**
 * CSRF mitigation (secondary layer; the primary layer is the SameSite=Lax
 * session cookie): for state-changing requests that carry an Origin or
 * Referer header, the origin must match the request's own host.
 */
export function assertSameOrigin(req: NextRequest): void {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const origin = req.headers.get('origin') ?? req.headers.get('referer')
  if (!origin) return // Non-browser clients (curl, tests) — cookie CSRF still applies
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  try {
    const originHost = new URL(origin).host
    if (host && originHost !== host) {
      throw new ApiError(403, 'CSRF', 'Cross-origin request rejected.')
    }
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(403, 'CSRF', 'Invalid request origin.')
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser()
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.')
  return user
}

export function requirePermission(user: SessionUser, permission: Permission): void {
  if (!hasPermission(user, permission)) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.')
  }
}

export function requireRole(user: SessionUser, ...roles: SessionUser['role'][]): void {
  if (!roles.includes(user.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'Your role does not allow this action.')
  }
}

/** Parse and validate a JSON body with zod, mapping failures to 422. */
export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new ApiError(400, 'BAD_JSON', 'Request body must be valid JSON.')
  }
  return schema.parse(raw)
}

export type Pagination = { page: number; pageSize: number; skip: number; take: number }

export function parsePagination(url: URL, defaultPageSize = 20): Pagination {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? String(defaultPageSize), 10) || defaultPageSize))
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
}

/** Amounts arrive as JS numbers (safe integers <= 999,999,999,999) and are stored as BigInt. */
export function toBigIntAmount(value: number): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 999_999_999_999) {
    throw new ApiError(422, 'INVALID_AMOUNT', 'Amount must be a whole number between 0 and 999,999,999,999.')
  }
  return BigInt(value)
}

export function parseFiltersFromUrl(url: URL): {
  from: Date | null
  to: Date | null
  departmentId: string | null
  categoryId: string | null
  status: string | null
  userId: string | null
  minAmount: bigint | null
  maxAmount: bigint | null
  q: string | null
} {
  const sp = url.searchParams
  const fromStr = sp.get('from')
  const toStr = sp.get('to')
  const minStr = sp.get('minAmount')
  const maxStr = sp.get('maxAmount')
  return {
    from: fromStr ? new Date(fromStr) : null,
    to: toStr ? new Date(toStr + 'T23:59:59.999Z') : null,
    departmentId: sp.get('departmentId'),
    categoryId: sp.get('categoryId'),
    status: sp.get('status'),
    userId: sp.get('userId'),
    minAmount: minStr !== null && minStr !== '' ? toBigIntAmount(parseInt(minStr, 10)) : null,
    maxAmount: maxStr !== null && maxStr !== '' ? toBigIntAmount(parseInt(maxStr, 10)) : null,
    q: sp.get('q'),
  }
}
