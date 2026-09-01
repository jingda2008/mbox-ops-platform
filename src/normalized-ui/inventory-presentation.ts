export {
  inventoryEmployeeUnit,
  inventoryQuantityForEmployee,
  inventoryQuantityForStorage,
  isLiquidInventoryCategory,
  requiresMillilitreInventoryMigration,
} from '../shared/inventory-unit-policy'

const inventoryUnitLabels: Record<string, string> = {
  ml: '毫升',
  g: '克',
  piece: '件',
  bottle: '瓶',
  portion: '份',
}

export const inventoryCategoryOptions = [
  ['spirits.whisky', '威士忌'], ['spirits.american_whisky', '美国威士忌'],
  ['spirits.japanese_whisky', '日本威士忌'], ['spirits.cognac_brandy', '干邑白兰地'],
  ['wine.sparkling_champagne', '起泡酒/香槟'], ['wine.red', '红酒'], ['wine.white', '干白'],
  ['spirits.vodka', '伏特加'], ['spirits.gin', '金酒'], ['spirits.rum', '朗姆酒'],
  ['spirits.tequila', '龙舌兰'], ['spirits.liqueur_absinthe', '力娇酒/苦艾'],
  ['mixer.syrup_beverage', '糖浆饮料'], ['beer', '啤酒'], ['food.snack', '食品零食'],
  ['mixer.juice', '果汁'], ['ingredient.seasoning', '调料配料'],
] as const

const legacyInventoryCategoryLabels: Readonly<Record<string, string>> = {
  spirits: '洋酒',
  bottled_spirits: '瓶装洋酒',
  wine: '葡萄酒',
  mixer: '饮料与调饮原料',
  food: '食品',
  uncategorized: '未分类',
}

export function inventoryUnitLabel(unit: string): string {
  const normalized = unit.trim().toLowerCase()
  return inventoryUnitLabels[normalized] ?? (normalized === '' ? '单位' : '未知单位')
}

export function inventoryCategoryLabel(categoryCode: string): string {
  return inventoryCategoryOptions.find(([code]) => code === categoryCode)?.[1]
    ?? legacyInventoryCategoryLabels[categoryCode]
    ?? '其他分类'
}

export function formatInventoryQuantity(value: string | number): string {
  const normalized = String(value).trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return '待确认'
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  const [rawWhole = '0', fraction = ''] = unsigned.split('.')
  const whole = rawWhole.replace(/^0+(?=\d)/, '')
  const trimmedFraction = fraction.replace(/0+$/, '')
  const result = trimmedFraction === '' ? whole : `${whole}.${trimmedFraction}`
  return negative && Number(result) !== 0 ? `-${result}` : result
}

export function formatInventoryQuantityWithUnit(value: string | number, unit: string): string {
  return `${formatInventoryQuantity(value)} ${inventoryUnitLabel(unit)}`
}

export function formatReceiptReference(publicId: string): string {
  const compact = publicId.trim().replace(/^receipt-/i, '').replace(/-/g, '')
  const suffix = compact.slice(-6).toUpperCase()
  return suffix === '' ? '收货单' : `收货单 ${suffix}`
}

export function formatInventoryUnitCostMinor(value: string, unit: string): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '待确认'
  const precision = unit === 'ml' || unit === 'g' ? 4 : 2
  const formatted = (parsed / 100).toFixed(precision)
  if (precision === 2) return formatted
  return formatted.replace(/0+$/, '').replace(/\.$/, '')
}
