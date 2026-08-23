import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'

export const STAFF_AUTHENTICATION_REQUIRED_ERROR = Object.freeze({
  code: 'AUTH_REQUIRED',
  message: '登录信息无效或已过期，请重新登录',
})

export function isStaffAuthenticationRequiredError(error: unknown): boolean {
  return error instanceof NormalizedAuthenticationRequiredError
    || error instanceof StaffSessionNotFoundError
}
