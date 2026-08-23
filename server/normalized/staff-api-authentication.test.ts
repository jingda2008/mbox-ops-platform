import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import {
  isStaffAuthenticationRequiredError,
  STAFF_AUTHENTICATION_REQUIRED_ERROR,
} from './staff-api-authentication.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'

describe('staff API authentication classification', () => {
  it('classifies missing request credentials and expired sessions consistently', () => {
    expect(isStaffAuthenticationRequiredError(new NormalizedAuthenticationRequiredError())).toBe(true)
    expect(isStaffAuthenticationRequiredError(new StaffSessionNotFoundError())).toBe(true)
    expect(isStaffAuthenticationRequiredError(new Error('database unavailable'))).toBe(false)
    expect(STAFF_AUTHENTICATION_REQUIRED_ERROR).toEqual({
      code: 'AUTH_REQUIRED',
      message: '登录信息无效或已过期，请重新登录',
    })
  })

  it('keeps every staff-context API wired to an authentication classifier', async () => {
    const directory = new URL('.', import.meta.url)
    const fileNames = (await readdir(directory)).filter((name) => name.endsWith('-api.ts'))
    const unmapped: string[] = []
    for (const fileName of fileNames) {
      const source = await readFile(new URL(fileName, directory), 'utf8')
      if (!source.includes('resolveStaffContext')) continue
      if (source.includes('isStaffAuthenticationRequiredError')
        || source.includes('NormalizedAuthenticationRequiredError')) continue
      unmapped.push(fileName)
    }
    expect(unmapped).toEqual([])
  })
})
