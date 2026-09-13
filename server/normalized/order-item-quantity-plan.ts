/** Quantities are supplied by the locked fulfilment facts, never inferred from refund money. */
export interface ItemQuantityFacts {
  ordered: number
  stoppedUnmade: number
  stoppedMade: number
  heldUnmade: number
  heldMade: number
  started: number
  ready: number
  delivered: number
}

export interface OriginalItemPrice {
  quantity: number
  unitAmountMinor: number
  totalAmountMinor: number
  includedInBundle: boolean
  /** Only a persisted, original unit allocation may supply non-uniform unit prices. */
  unitAllocationsMinor?: readonly number[]
}

export class ItemQuantityConflict extends Error {
  constructor(public readonly code: 'QUANTITY_INVALID' | 'QUANTITY_FACTS_CONFLICT' | 'QUANTITY_UNAVAILABLE' | 'PRODUCTION_REVIEW_REQUIRED' | 'PRICE_REVIEW_REQUIRED' | 'QUANTITY_BATCH_NOT_ENABLED', message: string) {
    super(message)
    this.name = 'ItemQuantityConflict'
  }
}

export function itemQuantityAvailability(facts: Readonly<ItemQuantityFacts>) {
  for (const quantity of Object.values(facts)) {
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT', '商品处理数量记录不完整，请核对原单')
  }
  if (facts.ordered < 1 || facts.delivered > facts.ready || facts.ready > facts.started
    || facts.started + facts.heldUnmade > facts.ordered - facts.stoppedUnmade
    || facts.heldMade + facts.stoppedMade > facts.started) {
    throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT', '制作、暂停和原单数量不一致，请核对原任务')
  }
  const unmade = facts.ordered - facts.stoppedUnmade - facts.started - facts.heldUnmade
  const made = facts.started - facts.stoppedMade - facts.heldMade
  return { unmade, made, selectable: unmade + made }
}

/** Stops take from unmade units first. A started unit always retains its production evidence. */
export function planItemQuantityHold(facts: Readonly<ItemQuantityFacts>, requested: number, kind: 'unpaid_stop' | 'paid_return') {
  if (!Number.isSafeInteger(requested) || requested < 1) throw new ItemQuantityConflict('QUANTITY_INVALID', '请选择大于零的商品数量')
  const available = itemQuantityAvailability(facts)
  if (requested > available.selectable) throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE', `当前最多可处理${available.selectable}份，其他数量已停止或正在处理中`)
  const unmade = Math.min(requested, available.unmade)
  const madeReview = requested - unmade
  if (kind === 'unpaid_stop' && madeReview > 0) {
    throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED', `其中${madeReview}份已有制作记录，请按现有免单或损耗权限处理；本次尚未修改原单`)
  }
  return { requested, unmade, madeReview, otherUnmade: available.unmade - unmade }
}

/** Select exact original unit positions. Discounted/bundle child prices are never guessed. */
export function originalQuantityAmount(price: Readonly<OriginalItemPrice>, unitIndexes: readonly number[]): number {
  if (!Number.isSafeInteger(price.quantity) || price.quantity < 1
    || !Number.isSafeInteger(price.unitAmountMinor) || price.unitAmountMinor < 0
    || !Number.isSafeInteger(price.totalAmountMinor) || price.totalAmountMinor < 0
    || unitIndexes.length === 0 || new Set(unitIndexes).size !== unitIndexes.length
    || unitIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= price.quantity)) {
    throw new ItemQuantityConflict('QUANTITY_INVALID', '原成交金额或所选份数无效')
  }
  if (price.includedInBundle) throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED', '套餐内商品不能按单卖价格退钱，请选择原套餐或核对原分摊金额')
  let amount: bigint
  if (price.unitAllocationsMinor !== undefined) {
    const allocations = price.unitAllocationsMinor
    if (allocations.length !== price.quantity || allocations.some(value => !Number.isSafeInteger(value) || value < 0)
      || allocations.reduce((sum, value) => sum + BigInt(value), 0n) !== BigInt(price.totalAmountMinor)) {
      throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED', '原单份分摊记录不完整，请核对成交金额')
    }
    amount = unitIndexes.reduce((sum, index) => sum + BigInt(allocations[index]!), 0n)
  } else if (unitIndexes.length === price.quantity) {
    amount = BigInt(price.totalAmountMinor)
  } else if (BigInt(price.unitAmountMinor) * BigInt(price.quantity) === BigInt(price.totalAmountMinor)) {
    amount = BigInt(price.unitAmountMinor) * BigInt(unitIndexes.length)
  } else {
    throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED', '这行含优惠且没有原单份分摊，需核对所选数量的原成交金额')
  }
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED', '金额超出安全计算范围')
  return Number(amount)
}
