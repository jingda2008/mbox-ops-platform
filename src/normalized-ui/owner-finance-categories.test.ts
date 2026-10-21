import { describe, expect, it } from 'vitest'
import { operatingExpenseCategories } from './owner-finance-categories'

const categories = [
  { id: 'rent', code: 'rent', name: '房租', systemCategory: 'rent', isSystem: true },
  { id: 'payroll', code: 'payroll', name: '员工工资', systemCategory: 'personnel', isSystem: true },
  { id: 'band', code: 'band', name: '乐队', systemCategory: 'band', isSystem: true },
  { id: 'performer', code: 'performer', name: '其他演出', systemCategory: 'performer', isSystem: true },
  { id: 'utilities', code: 'utilities', name: '水电与物业', systemCategory: 'utilities', isSystem: true },
  { id: 'labor', code: 'labor', name: '人工费用', systemCategory: 'miscellaneous', isSystem: true },
  { id: 'purchase', code: 'beverage_purchase', name: '酒水采购', systemCategory: 'beverage_purchase', isSystem: true },
  { id: 'misc', code: 'miscellaneous', name: '其他费用', systemCategory: 'miscellaneous', isSystem: true },
]

describe('expense form categories', () => {
  it('offers 人工费用 on the expense form and keeps payroll and purchases out', () => {
    expect(operatingExpenseCategories(categories).map((item) => item.name)).toEqual([
      '房租', '乐队', '其他演出', '水电与物业', '人工费用', '其他费用',
    ])
  })
})
