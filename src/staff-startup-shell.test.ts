import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('staff startup shell', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  it('renders the real role home while the full operations workspace is loading', () => {
    expect(source).toContain('function StaffWorkspaceFallback')
    expect(source).toContain('<RoleHomeView')
    expect(source).toMatch(/<Suspense fallback=\{\(\s*<StaffWorkspaceFallback/)
  })

  it('forwards fallback navigation instead of presenting a dead loading screen', () => {
    expect(source).toContain('setNavigationRequest({ id: nextNavigationRequestId.current, target, focus })')
    expect(source).toContain('focusQuery ? { objectId: focusQuery, query: focusQuery } : undefined')
  })
})
