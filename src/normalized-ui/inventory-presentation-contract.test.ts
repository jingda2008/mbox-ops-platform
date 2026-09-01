import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

describe('inventory and public-reference presentation contract', () => {
  it('routes the active staff inventory workflow through the shared presentation layer', () => {
    const staff = read('./StaffModulePanel.tsx')
    expect(staff).toContain('formatInventoryQuantityWithUnit(item.availableQuantity, item.baseUnit)')
    expect(staff).toContain('formatReceiptReference(pendingReceipt.publicId)')
    expect(staff).toContain('inventoryUnitLabel(selectedBindableItem?.baseUnit')
    expect(staff).not.toContain('当前{item.availableQuantity}{item.baseUnit}')
    expect(staff).not.toContain('<small>{pendingReceipt.publicId}')
    expect(staff).not.toContain('${result.remainingQuantity}${result.baseUnit}')
  })

  it('does not expose raw inventory units or unavailable material ids in configuration pages', () => {
    const catalog = read('./CatalogManagementPanel.tsx')
    const activities = read('./ActivityOperationsPanel.tsx')
    expect(catalog).toContain('inventoryUnitLabel(inventoryEmployeeUnit(item.categoryCode, item.baseUnit))')
    expect(catalog).toContain('inventoryQuantityForEmployee(')
    expect(catalog).not.toContain('{item.baseUnit}</small>')
    expect(activities).toContain('inventoryUnitLabel(item.baseUnit)')
    expect(activities).not.toContain('已选物料当前不可用：${component.inventoryItemId}')
  })

  it('uses compact references on customer-facing order and reservation results', () => {
    const guest = read('./guest/GuestApp.tsx')
    const reservation = read('./reservation/ReservationBooking.tsx')
    const miniActivity = read('../../miniprogram/pages/community-detail/index.wxml')
    expect(guest).toContain('订单 {shortPublicReference(result.order.publicId)}')
    expect(reservation).toContain('{shortPublicReference(record.publicId)}')
    expect(miniActivity).toContain('报名编号 {{registration.referenceText}}')
    expect(guest).not.toContain('订单 {result.order.publicId}')
    expect(reservation).not.toContain('>{record.publicId}</dd>')
    expect(miniActivity).not.toContain('报名编号 {{registration.publicId}}')
  })
})
