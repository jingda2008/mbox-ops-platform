import type { MenuProduct } from '../shared/contracts'

export function normalizeMenuSearch(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('zh-CN')
}

export function filterMenuProducts(products: MenuProduct[], categoryId: string, query: string) {
  const categoryProducts = categoryId === 'all'
    ? products
    : products.filter((product) => (product.categoryId ?? 'featured') === categoryId)
  const searchTokens = normalizeMenuSearch(query).split(' ').filter(Boolean)
  if (searchTokens.length === 0) return categoryProducts

  return categoryProducts.filter((product) => {
    const searchableText = normalizeMenuSearch([
      product.name,
      product.sku,
      product.categoryName,
      product.specification,
      product.description,
      ...(product.tags ?? []),
    ].filter(Boolean).join(' '))
    return searchTokens.every((token) => searchableText.includes(token))
  })
}
