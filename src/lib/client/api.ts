export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = body?.error ?? { code: 'INTERNAL', message: 'request failed' }
    throw new ApiError(response.status, error.code, error.message)
  }
  return body.data as T
}

export async function apiGet<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(path, { cache: 'no-store' }))
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  )
}
