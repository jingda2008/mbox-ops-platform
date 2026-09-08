import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, it, expect } from 'vitest'

function guardModule() {
  const context = { module: { exports: {} as { createTableRequestGuard: (read: () => string) => any } } }
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/table-request-scope.js', import.meta.url), 'utf8'), context)
  return context.module.exports
}

describe('mini-program write ownership is independent of read/poll lifetime', () => {
  it('settles a service write after onHide and onShow re-read', () => {
    const guard = guardModule().createTableRequestGuard(() => 'table-A')
    const firstRead = guard.begin('table-A')
    const write = guard.beginWrite('table-A', 'service')
    guard.invalidate()
    guard.begin('table-A')
    expect(guard.isCurrent(firstRead)).toBe(false)
    expect(guard.isCurrentWrite(write)).toBe(true)
    expect(guard.finishWrite(write)).toBe(true)
    expect(guard.finishWrite(write)).toBe(false)
  })
  it('ignores old-table results and does not clear a newer submission', () => {
    let scope = 'table-A'
    const guard = guardModule().createTableRequestGuard(() => scope)
    const old = guard.beginWrite(scope, 'cart')
    scope = 'table-B'
    expect(guard.isCurrentWrite(old)).toBe(false)
    const next = guard.beginWrite(scope, 'cart')
    expect(guard.finishWrite(old)).toBe(false)
    expect(guard.isCurrentWrite(next)).toBe(true)
    expect(guard.finishWrite(next)).toBe(true)
  })
  it('keeps independent write lanes separate', () => {
    const guard = guardModule().createTableRequestGuard(() => 'table-A')
    const cart = guard.beginWrite('table-A', 'cart')
    const service = guard.beginWrite('table-A', 'service')
    expect(guard.finishWrite(cart)).toBe(true)
    expect(guard.isCurrentWrite(service)).toBe(true)
  })
})
