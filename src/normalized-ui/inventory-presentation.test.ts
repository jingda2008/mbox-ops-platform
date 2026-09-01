import { describe, expect, it } from 'vitest'
import {
  formatInventoryQuantity,
  formatInventoryQuantityWithUnit,
  formatInventoryUnitCostMinor,
  formatReceiptReference,
  inventoryCategoryLabel,
  inventoryEmployeeUnit,
  inventoryQuantityForEmployee,
  inventoryQuantityForStorage,
  inventoryUnitLabel,
  isLiquidInventoryCategory,
  requiresMillilitreInventoryMigration,
} from './inventory-presentation'

describe('inventory presentation', () => {
  it('turns database decimals and unit codes into staff-readable Chinese', () => {
    expect(formatInventoryQuantity('3.000000')).toBe('3')
    expect(formatInventoryQuantity('0.250000')).toBe('0.25')
    expect(formatInventoryQuantity('0003.000000')).toBe('3')
    expect(formatInventoryQuantity('-0.000000')).toBe('0')
    expect(inventoryUnitLabel('bottle')).toBe('瓶')
    expect(inventoryUnitLabel('piece')).toBe('件')
    expect(formatInventoryQuantityWithUnit('35.000000', 'bottle')).toBe('35 瓶')
  })

  it('does not expose unknown internal codes or invalid numeric payloads', () => {
    expect(inventoryUnitLabel('future_unit')).toBe('未知单位')
    expect(inventoryCategoryLabel('spirits.cognac_brandy')).toBe('干邑白兰地')
    expect(inventoryCategoryLabel('bottled_spirits')).toBe('瓶装洋酒')
    expect(inventoryCategoryLabel('future.category')).toBe('其他分类')
    expect(formatInventoryQuantity('not-a-number')).toBe('待确认')
  })

  it('keeps fine-grained costs precise while making discrete-unit money readable', () => {
    expect(formatInventoryUnitCostMinor('33.333333', 'bottle')).toBe('0.33')
    expect(formatInventoryUnitCostMinor('42.857143', 'ml')).toBe('0.4286')
  })

  it('shows a short traceable receipt reference instead of a raw UUID', () => {
    expect(formatReceiptReference('receipt-aa20e721-4822-43ad-9df2-ffd1d8e1b8f5')).toBe('收货单 E1B8F5')
  })

  it('presents liquid employee operations in millilitres while preserving compatible historical storage', () => {
    expect(isLiquidInventoryCategory('spirits.whisky')).toBe(true)
    expect(isLiquidInventoryCategory('mixer.juice')).toBe(true)
    expect(isLiquidInventoryCategory('food.snack')).toBe(false)
    expect(requiresMillilitreInventoryMigration('spirits.whisky', 'bottle')).toBe(true)
    expect(requiresMillilitreInventoryMigration('spirits.whisky', 'ml')).toBe(false)
    expect(requiresMillilitreInventoryMigration('food.snack', 'piece')).toBe(false)
    expect(inventoryEmployeeUnit('spirits.whisky', 'bottle')).toBe('ml')
    expect(inventoryQuantityForEmployee('0.3', 'mixer.juice', 'bottle', '330')).toBe('99')
    expect(inventoryQuantityForStorage('99', 'mixer.juice', 'bottle', '330')).toBe('0.3')
  })
})
