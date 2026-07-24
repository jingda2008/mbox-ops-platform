import { describe, expect, it } from 'vitest'
import type { MenuProduct } from '../shared/contracts'
import { filterMenuProducts, normalizeMenuSearch } from './menu-search'

const products: MenuProduct[] = [
  {
    id: 'beer-1',
    sku: 'BEER-330',
    name: '精酿啤酒',
    specification: '330ml',
    categoryId: 'drinks',
    categoryName: '酒水',
    description: '入口清爽，适合分享',
    tags: ['冰镇', '啤酒'],
    listPriceAmount: 6800,
    costAmount: 1800,
    stationId: 'bar',
    enabled: true,
    configVersion: 1,
  },
  {
    id: 'snack-1',
    sku: 'FOOD-001',
    name: '小食拼盘',
    specification: '1份',
    categoryId: 'food',
    categoryName: '餐食',
    description: '热制下酒小食',
    tags: ['热食'],
    listPriceAmount: 9800,
    costAmount: 3200,
    stationId: 'kitchen',
    enabled: true,
    configVersion: 1,
  },
]

describe('shared menu search', () => {
  it('matches names, categories, specifications, SKUs, descriptions and configured tags', () => {
    expect(filterMenuProducts(products, 'all', '精酿')).toEqual([products[0]])
    expect(filterMenuProducts(products, 'all', '酒水')).toEqual([products[0]])
    expect(filterMenuProducts(products, 'all', '330ml')).toEqual([products[0]])
    expect(filterMenuProducts(products, 'all', 'beer-330')).toEqual([products[0]])
    expect(filterMenuProducts(products, 'all', '清爽')).toEqual([products[0]])
    expect(filterMenuProducts(products, 'all', '冰镇')).toEqual([products[0]])
  })

  it('supports multiple terms and keeps category filtering predictable', () => {
    expect(filterMenuProducts(products, 'all', '啤酒 330')).toEqual([products[0]])
    expect(filterMenuProducts(products, 'food', '啤酒')).toEqual([])
    expect(filterMenuProducts(products, 'food', '')).toEqual([products[1]])
  })

  it('normalizes full-width characters, case and extra spaces', () => {
    expect(normalizeMenuSearch('  ＢＥＥＲ－３３０  ')).toBe('beer-330')
    expect(filterMenuProducts(products, 'all', 'ＢＥＥＲ－３３０')).toEqual([products[0]])
  })
})
