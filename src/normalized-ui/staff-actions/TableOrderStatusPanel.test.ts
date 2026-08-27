import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('TableOrderStatusPanel', () => {
  it('never treats a ready KDS item as already delivered and refreshes a selected table status', () => {
    const source = readFileSync(new URL('./TableOrderStatusPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain("ready_for_delivery: { label: '待送达'")
    expect(source).toContain("delivered: { label: '已送达'")
    expect(source).toContain('api.loadTableOrderDetails(table.activeSession.id, signal)')
    expect(source).toContain('setInterval')
    expect(source).toContain('不需要送达')
  })
})
