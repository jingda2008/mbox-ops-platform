import type { GuestSharedCartLine } from './guest-shared-cart-repository.js'

export interface CheckoutLineNote { portionId: string; note: string }

/** Bind instructions to stable portions, never an array position or product name. */
export function checkoutLinesWithNotes(lines: readonly GuestSharedCartLine[], notes: readonly CheckoutLineNote[], splitForCoupons: boolean) {
  const known = new Set(lines.flatMap(line => line.portionIds || []))
  const byPortion = new Map<string, string>()
  for (const entry of notes) {
    if (!known.has(entry.portionId) || byPortion.has(entry.portionId) || entry.note.length > 300) {
      throw new Error('菜品备注对应的份次已变化，请刷新购物车后重新核对')
    }
    byPortion.set(entry.portionId, entry.note.trim())
  }
  return lines.flatMap(line => {
    if (!splitForCoupons && !(line.portionIds || []).some(id => byPortion.has(id))) return [line]
    return Array.from({ length: line.quantity }, (_, index) => ({
      ...line, quantity: 1,
      note: byPortion.get(line.portionIds?.[index] || '') || null,
      bundleSelections: line.bundleSelections.length ? [line.bundleSelections[index]!] : [],
    }))
  })
}
