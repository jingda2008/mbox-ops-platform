import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('staff mobile inventory scanning contract', () => {
  it('uses the phone rear camera with manual fallback and stops camera tracks', async () => {
    const source = await readFile(new URL('./InventoryBarcodeScanner.tsx', import.meta.url), 'utf8')
    expect(source).toContain("facingMode: { ideal: 'environment' }")
    expect(source).toContain("'ean_13'")
    expect(source).toContain("'qr_code'")
    expect(source).toContain("track.stop()")
    expect(source).toContain('当前浏览器无法调用摄像头')
  })

  it('keeps receipt creation and physical receipt confirmation as separate actions', async () => {
    const source = await readFile(new URL('./StaffModulePanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('第一步：建立待收货单')
    expect(source).toContain('第二步：确认实物无误并入库')
    expect(source).toContain("'/api/inventory/receipts'")
    expect(source).toMatch(/\/api\/inventory\/receipts\/\$\{receipt\.id\}\/receive/)
    expect(source).toContain("entryMethod: 'staff_mobile_camera'")
    expect(source).toContain('待确认收货')
    expect(source).toContain("receipt.status === 'draft'")
    expect(source).not.toContain('单件成本（元）')
    expect(source).not.toContain('unitCostMinor,')
    expect(source).toContain("item.categoryCode !== 'food'")
  })
})
