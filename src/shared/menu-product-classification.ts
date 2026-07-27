import type { MenuBeverageFamily, MenuProduct } from './contracts.js'

type ClassifiableMenuProduct = Pick<
  MenuProduct,
  'beverageFamily' | 'categoryId' | 'categoryName' | 'name' | 'description' | 'tags'
>

export function resolveMenuBeverageFamily(product: ClassifiableMenuProduct): MenuBeverageFamily {
  if (product.beverageFamily && product.beverageFamily !== 'none') return product.beverageFamily
  const haystack = [
    product.categoryId,
    product.categoryName,
    product.name,
    product.description,
    ...(product.tags ?? []),
  ].filter(Boolean).join(' ').toLowerCase()
  if (/鸡尾酒|cocktail/.test(haystack)) return 'cocktail'
  if (/啤酒|beer|精酿/.test(haystack)) return 'beer'
  if (/起泡|香槟|sparkling|champagne/.test(haystack)) return 'sparkling'
  if (/葡萄酒|红酒|白葡萄酒|wine/.test(haystack)) return 'wine'
  if (/洋酒|威士忌|白兰地|干邑|伏特加|朗姆|龙舌兰|金酒|烈酒|spirit|whisky|whiskey|brandy|cognac|vodka|rum|tequila|gin/.test(haystack)) return 'spirits'
  if (/无酒精|咖啡|茶|果汁|汽水|软饮|苏打|气泡水|mocktail|coffee|tea|juice|soda/.test(haystack)) return 'non_alcoholic'
  return 'none'
}

export function isDrinkMenuProduct(product: ClassifiableMenuProduct) {
  const categoryId = product.categoryId?.trim().toLowerCase()
  const categoryName = product.categoryName?.trim().toLowerCase()
  return categoryId === 'drink'
    || categoryId === 'drinks'
    || categoryId === 'beverage'
    || categoryId === 'beverages'
    || categoryName === '酒水'
    || categoryName === '饮品'
    || resolveMenuBeverageFamily(product) !== 'none'
}

export function guestDrinkMatchesFamily(product: ClassifiableMenuProduct, family: string) {
  if (!isDrinkMenuProduct(product)) return false
  return family === 'all' || resolveMenuBeverageFamily(product) === family
}
