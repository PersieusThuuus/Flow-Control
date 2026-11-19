// ============================================================================
// FlowControl — Client API helper
//
// Thin typed fetch wrapper. All requests use relative URLs with the session
// cookie (SameSite=Lax). Errors are normalized into ApiClientError with the
// server-provided message.
// ============================================================================

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public issues?: { path: string; message: string }[],
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (init?.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    body: body ?? init?.body,
    credentials: 'same-origin',
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const err = data as { error?: string; code?: string; issues?: { path: string; message: string }[] } | null
    throw new ApiClientError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.error ?? `Request failed (${res.status})`,
      err?.issues,
    )
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, json?: unknown) => request<T>(path, { method: 'POST', json: json ?? {} }),
  patch: <T>(path: string, json?: unknown) => request<T>(path, { method: 'PATCH', json: json ?? {} }),
  put: <T>(path: string, json?: unknown) => request<T>(path, { method: 'PUT', json: json ?? {} }),
  /** Multipart upload (file + fields). */
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
}

/** Build a query string from defined values only. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}
