import { describe, expect, it } from 'vitest'
import { guestDrinkMatchesFamily, isDrinkMenuProduct, isEligibleForGuestStyleMenu, isFoodMenuProduct, resolveMenuBeverageFamily } from './menu-product-classification.js'

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

  it('uses the editable category hierarchy for food child categories', () => {
    expect(isFoodMenuProduct({
      name: '炸薯条', categoryId: 'snack', categoryName: '小食',
      categoryParentId: 'food', categoryParentName: '鲜果与冷食', beverageFamily: 'none',
    })).toBe(true)
    expect(isFoodMenuProduct({
      name: '泥煤威士忌', categoryId: 'fruit', categoryName: '艾雷岛烟熏泥煤威士忌',
      categoryParentId: 'weishiji', categoryParentName: '威士忌', beverageFamily: 'spirits',
    })).toBe(false)
  })

  it('lets a server-approved staff catalog use the guest-style menu without applying guest visibility', () => {
    const product = { guestVisible: false }

    expect(isEligibleForGuestStyleMenu(product)).toBe(false)
    expect(isEligibleForGuestStyleMenu(product, true)).toBe(true)
  })
})
