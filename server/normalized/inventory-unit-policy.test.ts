import { describe, expect, it } from 'vitest'
import {
  inventoryEmployeeUnit,
  inventoryQuantityForEmployee,
  inventoryQuantityForStorage,
  isLiquidInventoryCategory,
  requiresMillilitreInventoryMigration,
} from '../../src/shared/inventory-unit-policy.js'

describe('inventory unit policy', () => {
  it('covers every liquid category family without treating food as liquid', () => {
    expect(['spirits.whisky', 'wine.red', 'beer', 'mixer.juice', 'bottled_spirits']
      .every((category) => isLiquidInventoryCategory(category))).toBe(true)
    expect(isLiquidInventoryCategory('food.snack')).toBe(false)
  })

  it('identifies historical liquid units without changing non-liquid units', () => {
    expect(requiresMillilitreInventoryMigration('wine.red', 'bottle')).toBe(true)
    expect(requiresMillilitreInventoryMigration('wine.red', 'ml')).toBe(false)
    expect(requiresMillilitreInventoryMigration('food.snack', 'piece')).toBe(false)
  })

  it('converts employee millilitre input to the historical storage unit with six-decimal rounding', () => {
    expect(inventoryEmployeeUnit('spirits.whisky', 'bottle')).toBe('ml')
    expect(inventoryQuantityForEmployee('0.064000', 'spirits.whisky', 'bottle', '700.000000')).toBe('44.8')
    expect(inventoryQuantityForStorage('45', 'spirits.whisky', 'bottle', '700.000000')).toBe('0.064286')
    expect(inventoryQuantityForEmployee('2.000000', 'food.snack', 'piece', null)).toBe('2')
  })

  it('refuses compatibility conversion when package capacity is missing or invalid', () => {
    expect(inventoryQuantityForStorage('45', 'spirits.whisky', 'bottle', null)).toBeNull()
    expect(inventoryQuantityForStorage('45', 'spirits.whisky', 'bottle', '0')).toBeNull()
    expect(inventoryQuantityForEmployee('bad', 'spirits.whisky', 'bottle', '700')).toBeNull()
  })
})
