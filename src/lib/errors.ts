/**
 * Framework-agnostic error carrying an HTTP status + optional i18n code.
 * Services throw this for expected failures (not-found, invalid input) so route
 * handlers can map them to the right status without leaking internals. Lives here
 * (not in api-helpers) so services stay free of any Next/runtime imports.
 */
export class ApiError extends Error {
  status: number
  code?: string

  constructor(message: string, status = 500, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}
