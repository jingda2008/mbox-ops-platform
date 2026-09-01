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
    expect(source).toContain('仅确认实物入库')
    expect(source).toContain("'/api/inventory/receipts'")
    expect(source).toMatch(/\/api\/inventory\/receipts\/\$\{receipt\.id\}\/receive/)
    expect(source).toContain("'staff_mobile_camera'")
    expect(source).toContain("'staff_mobile_selection'")
    expect(source).toContain('待确认收货')
    expect(source).toContain("receipt.status === 'draft'")
    expect(source).not.toContain('单件成本（元）')
    const receiptPayload = source.slice(
      source.indexOf("const receipt = await api.postEndpoint<PurchaseReceiptCommandView>('/api/inventory/receipts'"),
      source.indexOf('setPendingReceipt(receipt)'),
    )
    expect(receiptPayload).toContain('totalCostMinor,')
    expect(receiptPayload).not.toContain('unitCostMinor')
    expect(receiptPayload).toContain("usesPackageQuantity ? { packages } : { quantity: packages }")
    expect(source).toContain('const operationalItems = view.items')
    expect(source).toContain('const bindableItems = view.items')
    expect(source).toContain('requiresMillilitreInventoryMigration(item.categoryCode, item.baseUnit)')
    expect(source).toContain('系统按已登记的单瓶净含量兼容换算')
    expect(source).toContain("? '个包装' : inventoryUnitLabel")
    expect(source).toContain('unit="元"')
  })

  it('can confirm a related receipt and publish a fully validated beverage atomically', async () => {
    const source = await readFile(new URL('./StaffModulePanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('第四步：按预览入库发布')
    expect(source).toMatch(/\/api\/inventory\/receipts\/\$\{receipt\.id\}\/receive-and-publish-preview/)
    expect(source).toMatch(/\/api\/inventory\/receipts\/\$\{receipt\.id\}\/receive-and-publish/)
    expect(source).toContain("publishPreview?.receiptId !== receipt.id")
    expect(source).toContain('成本与可售预览')
    expect(source).toContain('单份成本')
    expect(source).toContain('每份扣减')
    expect(source).toContain('可售份数')
    expect(source).toContain('毛利率')
    expect(source).toContain('顾客扫码')
    expect(source).toContain('员工协助')
    const apiSource = await readFile(new URL('../../server/normalized/inventory-api.ts', import.meta.url), 'utf8')
    const receiveAndPublishSource = apiSource.slice(
      apiSource.indexOf('async function receiveAndPublishProduct('),
      apiSource.indexOf('async function previewReceiveAndPublishProduct('),
    )
    expect(receiveAndPublishSource).toContain('receivePurchaseReceipt(receiptId')
    expect(receiveAndPublishSource).toContain('previewRecipeCost(productId)')
    expect(receiveAndPublishSource).not.toContain('applyRecipeCost(')
    expect(apiSource).toContain('本次收货成本未能成为当前商品成本')
  })

  it('lets an authorized employee establish the first alcohol inventory item and exposes the active operation', async () => {
    const source = await readFile(new URL('./StaffModulePanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain("'/api/inventory/items'")
    expect(source).toContain('新建库存物料')
    expect(source).toContain('建立物料并继续绑定条码')
    expect(source).toContain("setMode('bind')")
    expect(source).toContain('aria-pressed={mode ===')
    const styles = await readFile(new URL('./staff-module-panel.css', import.meta.url), 'utf8')
    expect(styles).toContain("content: '当前'")
  })
})
