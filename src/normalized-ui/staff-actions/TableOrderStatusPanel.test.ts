import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('TableOrderStatusPanel', () => {
  it('never treats a ready KDS item as already delivered and stops automatic retries after a failed table read', () => {
    const source = readFileSync(new URL('./TableOrderStatusPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain("ready_for_delivery: { label: '待送达'")
    expect(source).toContain("delivered: { label: '已送达'")
    expect(source).toContain('api.loadTableOrderDetails(table.activeSession.id, signal)')
    expect(source).toContain('setInterval')
    expect(source).toContain('setAutoRefreshEnabled(false)')
    expect(source).toContain('本桌点单暂未显示，收款不受影响。')
    expect(source).toContain('复制参考号')
    expect(source).toContain('不需要送达')
  })
})
