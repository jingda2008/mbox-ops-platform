import { describe, expect, it } from 'vitest'
import { guestDrinkMatchesFamily, isDrinkMenuProduct, resolveMenuBeverageFamily } from './menu-product-classification.js'

describe('menu product classification', () => {
  it('keeps an incompletely classified drink visible in the all-drinks view', () => {
    const product = {
      name: '当日限定饮品',
      categoryId: 'drinks',
      categoryName: '酒水',
      beverageFamily: 'none' as const,
    }

    expect(isDrinkMenuProduct(product)).toBe(true)
    expect(guestDrinkMatchesFamily(product, 'all')).toBe(true)
    expect(guestDrinkMatchesFamily(product, 'beer')).toBe(false)
  })

  it('infers a specific family when legacy product text is clear', () => {
    const product = {
      name: '福佳白精酿',
      categoryId: 'drinks',
      categoryName: '酒水',
      beverageFamily: 'none' as const,
    }

    expect(resolveMenuBeverageFamily(product)).toBe('beer')
    expect(guestDrinkMatchesFamily(product, 'beer')).toBe(true)
  })

  it('does not treat food as a drink', () => {
    expect(isDrinkMenuProduct({
      name: '时令果盘',
      categoryId: 'food',
      categoryName: '小食',
      beverageFamily: 'none',
    })).toBe(false)
  })
})
