// Shared deterministic arithmetic. Callers must resolve ownership, eligibility,
// prices and policy versions on the server before using a result for an order.
export type PricingStage = 'member' | 'coupon' | 'points'
export interface StackingPolicy {
  allowMemberPrice: boolean
  allowBundlePrice: boolean
  allowCheckoutUpgrade: boolean
  allowOtherCoupons: boolean
  allowPoints: boolean
  maxCoupons: number
  calculationOrder: PricingStage[]
  maximumDiscountMinor: number | null
  minimumPayableMinor: number
}
export interface PricingUnit {
  id: string
  amountMinor: number
  costMinor: number | null
  bundle: boolean
  upgraded?: boolean
}
export interface PricingEffect {
  id: string
  stage: PricingStage
  kind: 'fixed_price' | 'amount_off' | 'rate' | 'free'
  value: number
  unitIds: string[]
  minimumSpendMinor: number
}
export class StackingPricingError extends Error {
  constructor(message: string) { super(message); this.name = 'StackingPricingError' }
}
const stages: PricingStage[] = ['member', 'coupon', 'points']
export const DEFAULT_STACKING_POLICY: Readonly<StackingPolicy> = Object.freeze({
  allowMemberPrice: false, allowBundlePrice: false, allowOtherCoupons: false, allowPoints: false,
  allowCheckoutUpgrade: false,
  maxCoupons: 1, calculationOrder: ['member', 'coupon', 'points'] as PricingStage[],
  maximumDiscountMinor: null, minimumPayableMinor: 0,
})
function fail(message: string): never { throw new StackingPricingError(message) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('计价数据格式不正确')
  return value as Record<string, unknown>
}
function integer(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail(`${label}须为范围内的整数`)
  return value as number
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail('叠加开关必须明确选择'); return value }
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail('计价份次或优惠编号无效')
  return value
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) fail('计价明细数量无效')
  return value
}
function safe(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('金额超出安全范围')
  return Number(value)
}
function sum(values: readonly number[]): number { return safe(values.reduce((total, value) => total + BigInt(value), 0n)) }

export function parseStackingPolicy(input: unknown): StackingPolicy {
  const value = object(input)
  const order = list(value.calculationOrder, 3)
  if (order.length !== 3 || new Set(order).size !== 3 || order.some(entry => !stages.includes(entry as PricingStage))) fail('计算顺序必须包含会员价、优惠券、积分各一次')
  const maxCoupons = integer(value.maxCoupons, '最多用券数', 10)
  if (maxCoupons < 1) fail('最多用券数不能小于1')
  const allowOtherCoupons = bool(value.allowOtherCoupons)
  if (!allowOtherCoupons && maxCoupons !== 1) fail('禁止多券叠加时最多只能使用1张券')
  return {
    allowMemberPrice: bool(value.allowMemberPrice), allowBundlePrice: bool(value.allowBundlePrice),
    allowCheckoutUpgrade: value.allowCheckoutUpgrade===undefined?false:bool(value.allowCheckoutUpgrade),
    allowOtherCoupons, allowPoints: bool(value.allowPoints), maxCoupons,
    calculationOrder: [...order] as PricingStage[],
    maximumDiscountMinor: value.maximumDiscountMinor === null ? null : integer(value.maximumDiscountMinor, '优惠上限（分）'),
    minimumPayableMinor: integer(value.minimumPayableMinor, '最低实付（分）'),
  }
}

/** Each unit is one independently refundable portion, not an arbitrary quantity. */
export function parsePricingScenario(input: unknown): { units: PricingUnit[]; effects: PricingEffect[] } {
  const scenario = object(input)
  const units = list(scenario.units, 100).map(raw => {
    const unit = object(raw)
    return { id: id(unit.id), amountMinor: integer(unit.amountMinor, '原金额（分）'),
      costMinor: unit.costMinor === null ? null : integer(unit.costMinor, '成本（分）'), bundle: bool(unit.bundle),upgraded:unit.upgraded===undefined?false:bool(unit.upgraded) }
  })
  if (new Set(units.map(unit => unit.id)).size !== units.length) fail('计价份次编号重复')
  if (!Array.isArray(scenario.effects) || scenario.effects.length > 20) fail('优惠数量无效')
  const effects = scenario.effects.map(raw => {
    const effect = object(raw)
    const stage = effect.stage as PricingStage
    const kind = effect.kind as PricingEffect['kind']
    if (!stages.includes(stage) || !['fixed_price', 'amount_off', 'rate', 'free'].includes(kind)) fail('不支持的优惠方式')
    if (stage === 'points' && kind !== 'amount_off') fail('积分只能按明确抵扣金额计价')
    if (stage === 'member' && kind !== 'rate' && kind !== 'fixed_price') fail('会员价须使用固定价格或折扣')
    const unitIds = list(effect.unitIds, 100).map(id)
    if (new Set(unitIds).size !== unitIds.length || unitIds.some(key => !units.some(unit => unit.id === key))) fail('优惠份次不存在或重复')
    if ((kind === 'fixed_price' || kind === 'free') && unitIds.length !== 1) fail('固定兑换价和免费券必须明确对应一份商品')
    const value = integer(effect.value, '优惠数值', kind === 'rate' ? 10_000 : Number.MAX_SAFE_INTEGER)
    if (kind === 'free' && value !== 0) fail('免费券金额必须为零')
    return { id: id(effect.id), stage, kind, value, unitIds, minimumSpendMinor: integer(effect.minimumSpendMinor, '使用门槛（分）') }
  })
  if (new Set(effects.map(effect => effect.id)).size !== effects.length) fail('同一优惠不能重复计算')
  if (effects.filter(effect => effect.stage === 'member').length > 1 || effects.filter(effect => effect.stage === 'points').length > 1) fail('会员价和积分抵扣各只能计算一次')
  return { units, effects }
}

// Exact largest-remainder allocation; input order cannot move a rounding cent.
export function allocateMinorAmount(amount: number, weights: readonly { id: string; amountMinor: number }[]): Map<string, number> {
  integer(amount, '待分摊金额')
  const denominator = weights.reduce((total, row) => total + BigInt(integer(row.amountMinor, '分摊权重')), 0n)
  if (new Set(weights.map(row => row.id)).size !== weights.length || BigInt(amount) > denominator) fail('金额不能分摊到这些份次')
  if (denominator === 0n) return new Map(weights.map(row => [row.id, 0]))
  const rows = weights.map(row => {
    const numerator = BigInt(amount) * BigInt(row.amountMinor)
    return { id: row.id, value: Number(numerator / denominator), remainder: numerator % denominator }
  })
  let left = amount - sum(rows.map(row => row.value))
  const ranked = [...rows].sort((a, b) => a.remainder === b.remainder ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.remainder > b.remainder ? -1 : 1)
  for (const row of ranked) { if (left === 0) break; row.value += 1; left -= 1 }
  return new Map(rows.map(row => [row.id, row.value]))
}

export function calculateStackingPrice(policyInput: unknown, scenarioInput: unknown) {
  const policy = parseStackingPolicy(policyInput)
  const { units, effects } = parsePricingScenario(scenarioInput)
  const coupons = effects.filter(effect => effect.stage === 'coupon')
  if (coupons.length > policy.maxCoupons || (!policy.allowOtherCoupons && coupons.length > 1)) fail('本规则不允许使用这些优惠券组合')
  if (coupons.length && !policy.allowMemberPrice && effects.some(effect => effect.stage === 'member')) fail('优惠券不能叠加会员价')
  if (coupons.length && !policy.allowPoints && effects.some(effect => effect.stage === 'points')) fail('优惠券不能叠加积分抵扣')
  if (!policy.allowBundlePrice && coupons.some(effect => effect.unitIds.some(key => units.some(unit => unit.id === key && unit.bundle)))) fail('本券不能用于套餐价商品')
  if(!policy.allowCheckoutUpgrade&&coupons.some(effect=>effect.unitIds.some(key=>units.some(unit=>unit.id===key&&unit.upgraded))))fail('本券不能用于升级套餐')
  const subtotalMinor = sum(units.map(unit => unit.amountMinor))
  if (policy.minimumPayableMinor > subtotalMinor) fail('最低实付不能高于原金额')
  const availableDiscount = Math.min(policy.maximumDiscountMinor ?? subtotalMinor, subtotalMinor - policy.minimumPayableMinor)
  let discountMinor = 0
  const amounts = new Map(units.map(unit => [unit.id, unit.amountMinor]))
  const steps: Array<{ effectId: string; stage: PricingStage; kind: PricingEffect['kind']; discountMinor: number; payableMinor: number; allocations: Array<{ unitId: string; discountMinor: number }> }> = []
  for (const stage of policy.calculationOrder) {
    // Coupon sequence is explicit; never silently reorder to maximize margin.
    for (const effect of effects.filter(candidate => candidate.stage === stage)) {
      const eligible = effect.unitIds.map(key => ({ id: key, amountMinor: amounts.get(key)! }))
      const before = sum(eligible.map(unit => unit.amountMinor))
      if (before < effect.minimumSpendMinor) fail('当前计算步骤未达到该优惠的使用门槛')
      const desired = effect.kind === 'free' ? before : effect.kind === 'fixed_price' ? Math.max(0, before - effect.value)
        : effect.kind === 'amount_off' ? Math.min(before, effect.value)
          : before - safe((BigInt(before) * BigInt(effect.value) + 5_000n) / 10_000n)
      const applied = Math.min(desired, availableDiscount - discountMinor)
      if (applied !== desired && (effect.kind === 'fixed_price' || effect.kind === 'free')) fail('最低实付或优惠上限与承诺兑换价冲突')
      const allocation = allocateMinorAmount(applied, eligible)
      for (const [key, amount] of allocation) amounts.set(key, amounts.get(key)! - amount)
      discountMinor += applied
      steps.push({ effectId: effect.id, stage, kind: effect.kind, discountMinor: applied, payableMinor: subtotalMinor - discountMinor,
        allocations: [...allocation].map(([unitId, amount]) => ({ unitId, discountMinor: amount })) })
    }
  }
  const costMinor = units.some(unit => unit.costMinor === null) ? null : sum(units.map(unit => unit.costMinor!))
  return {
    subtotalMinor, discountMinor, payableMinor: subtotalMinor - discountMinor, costMinor,
    grossProfitMinor: costMinor === null ? null : subtotalMinor - discountMinor - costMinor,
    steps, units: units.map(unit => ({ id: unit.id, originalMinor: unit.amountMinor, discountMinor: unit.amountMinor - amounts.get(unit.id)!, payableMinor: amounts.get(unit.id)! })),
  }
}
