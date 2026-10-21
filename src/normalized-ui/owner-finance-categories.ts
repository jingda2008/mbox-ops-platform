export function operatingExpenseCategories<T extends { systemCategory: string; code: string }>(items: readonly T[]): T[] {
  return items.filter((item) =>
    item.systemCategory !== 'beverage_purchase'
    && item.systemCategory !== 'personnel'
    && item.code !== 'payroll'
    && item.code !== 'beverage_purchase',
  )
}
