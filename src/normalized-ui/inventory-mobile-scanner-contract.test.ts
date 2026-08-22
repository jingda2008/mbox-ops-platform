import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('staff mobile inventory scanning contract', () => {
  it('opens the phone rear camera before selecting a local decoder, supports common liquor codes, and stops tracks', async () => {
    const source = await readFile(new URL('./InventoryBarcodeScanner.tsx', import.meta.url), 'utf8')
    expect(source).toContain("facingMode: { ideal: 'environment' }")
    expect(source).toContain("'ean_13'")
    expect(source).toContain('BarcodeFormat.EAN_13')
    expect(source).toContain('BarcodeFormat.CODE_128')
    expect(source).toContain("'qr_code'")
    expect(source).toContain("import('@zxing/browser')")
    expect(source).toContain("track.stop()")
    expect(source.indexOf('navigator.mediaDevices.getUserMedia')).toBeLessThan(source.indexOf('BarcodeDetector'))
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

  it('lets an authorized employee establish the first alcohol inventory item and exposes the active operation', async () => {
    const source = await readFile(new URL('./StaffModulePanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain("'/api/inventory/items'")
    expect(source).toContain('新建酒水物料')
    expect(source).toContain('建立物料并继续绑定条码')
    expect(source).toContain("setMode('bind')")
    expect(source).toContain('aria-pressed={mode ===')
    const styles = await readFile(new URL('./staff-module-panel.css', import.meta.url), 'utf8')
    expect(styles).toContain("content: '当前'")
  })
})
