// Errors the API returns on purpose. Every handler throws ApiError instead
// of building responses by hand, so the error shape {error: {code, message}}
// is uniform and the HTTP status is always honest (400/401/403/404/409/429).

export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export const badRequest = (code: string, message: string) =>
  new ApiError(400, code, message)
export const unauthorized = (message = 'You need to log in first.') =>
  new ApiError(401, 'unauthorized', message)
export const forbidden = (message = 'You are not allowed to do that.') =>
  new ApiError(403, 'forbidden', message)
export const notFound = (what = 'Not found') =>
  new ApiError(404, 'not_found', what)
export const conflict = (code: string, message: string) =>
  new ApiError(409, code, message)
export const tooManyRequests = (message: string) =>
  new ApiError(429, 'rate_limited', message)

/** Postgres unique-violation (23505) → which constraint fired, if we know it. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string }
  if (e?.code !== '23505') return false
  return constraint === undefined || e.constraint === constraint
}
