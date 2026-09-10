import { describe, expect, it } from 'vitest'
import { allocateMinorAmount, calculateStackingPrice, DEFAULT_STACKING_POLICY, parseStackingPolicy } from './stacking-pricing.js'

const unit = { id: 'drink-1', amountMinor: 6800, costMinor: 1800, bundle: false }
const coupon = { id: 'coupon-1', stage: 'coupon', kind: 'fixed_price', value: 990, unitIds: [unit.id], minimumSpendMinor: 0 }
const member = { id: 'member-1', stage: 'member', kind: 'rate', value: 9000, unitIds: [unit.id], minimumSpendMinor: 0 }
describe('configurable stacking integer pricing', () => {
  it('requires a separate explicit switch for coupons on upgraded portions',()=>{
    const scenario={units:[{...unit,bundle:true,upgraded:true}],effects:[coupon]}
    expect(()=>calculateStackingPrice({...DEFAULT_STACKING_POLICY,allowBundlePrice:true},scenario)).toThrow('不能用于升级')
    expect(calculateStackingPrice({...DEFAULT_STACKING_POLICY,allowBundlePrice:true,allowCheckoutUpgrade:true},scenario).payableMinor).toBe(990)
    expect(()=>calculateStackingPrice({...DEFAULT_STACKING_POLICY,allowCheckoutUpgrade:true},scenario)).toThrow('套餐价商品')
    const {allowCheckoutUpgrade:ignored,...legacy}=DEFAULT_STACKING_POLICY;void ignored
    expect(parseStackingPolicy(legacy).allowCheckoutUpgrade).toBe(false)
  })
  it('distinguishes final 9.9 from reducing 9.9, retains actual cost', () => {
    const fixed = calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [unit], effects: [coupon] })
    expect(fixed.payableMinor).toBe(990)
    expect(fixed.costMinor).toBe(1800)
    expect(fixed.grossProfitMinor).toBe(-810)
    const reduction = calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [unit], effects: [{ ...coupon, kind: 'amount_off' }] })
    expect(reduction.payableMinor).toBe(5810)
  })
  it('configures order explicitly: member before fixed coupon versus after', () => {
    expect(() => calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [unit], effects: [coupon, member] })).toThrow('不能叠加会员价')
    const policy = { ...DEFAULT_STACKING_POLICY, allowMemberPrice: true }
    expect(calculateStackingPrice(policy, { units: [unit], effects: [coupon, member] }).payableMinor).toBe(990)
    expect(calculateStackingPrice({ ...policy, calculationOrder: ['coupon', 'member', 'points'] }, { units: [unit], effects: [coupon, member] }).payableMinor).toBe(891)
  })
  it('does not discount another portion or infer zero cost', () => {
    const result = calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [unit, { ...unit, id: 'drink-2', costMinor: null }], effects: [coupon] })
    expect(result.units[1]!.payableMinor).toBe(6800)
    expect(result.costMinor).toBeNull()
    expect(result.grossProfitMinor).toBeNull()
  })
  it('free means zero payment but real cost; conflicting minimum is rejected', () => {
    const scenario = { units: [unit], effects: [{ ...coupon, kind: 'free', value: 0 }] }
    expect(calculateStackingPrice(DEFAULT_STACKING_POLICY, scenario).payableMinor).toBe(0)
    expect(() => calculateStackingPrice({ ...DEFAULT_STACKING_POLICY, minimumPayableMinor: 1 }, scenario)).toThrow('承诺兑换价冲突')
  })
  it('checks bundle, other coupon and points switches independently', () => {
    expect(() => calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [{ ...unit, bundle: true }], effects: [coupon] })).toThrow('套餐价')
    expect(calculateStackingPrice({ ...DEFAULT_STACKING_POLICY, allowBundlePrice: true }, { units: [{ ...unit, bundle: true }], effects: [coupon] }).payableMinor).toBe(990)
    const second = { ...coupon, id: 'coupon-2', kind: 'amount_off', value: 100 }
    expect(() => calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [unit], effects: [coupon, second] })).toThrow('组合')
    expect(calculateStackingPrice({ ...DEFAULT_STACKING_POLICY, allowOtherCoupons: true, maxCoupons: 2 }, { units: [unit], effects: [coupon, second] }).payableMinor).toBe(890)
    const points = { ...second, id: 'points-1', stage: 'points' }
    expect(() => calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [unit], effects: [coupon, points] })).toThrow('积分')
    expect(calculateStackingPrice({ ...DEFAULT_STACKING_POLICY, allowPoints: true }, { units: [unit], effects: [coupon, points] }).payableMinor).toBe(890)
  })
  it('bounds discount and never increases price when existing price is lower', () => {
    expect(calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [{ ...unit, amountMinor: 500 }], effects: [coupon] }).payableMinor).toBe(500)
    expect(calculateStackingPrice({ ...DEFAULT_STACKING_POLICY, maximumDiscountMinor: 300 }, { units: [unit], effects: [{ ...coupon, kind: 'amount_off', value: 1000 }] }).discountMinor).toBe(300)
  })
  it('retains exact safe-integer arithmetic where multiplication would overflow', () => {
    const max = Number.MAX_SAFE_INTEGER
    const result = calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [{ ...unit, amountMinor: max, costMinor: 0 }], effects: [{ ...coupon, kind: 'rate', value: 5000 }] })
    expect(result.payableMinor).toBe(4503599627370496)
    expect(result.payableMinor + result.discountMinor).toBe(max)
    expect(() => calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [{ ...unit, amountMinor: max }, { ...unit, id: 'other' }], effects: [] })).toThrow('安全范围')
  })
  it('rejects duplicate effects, invalid scope, fractions and policy contradictions', () => {
    for (const effect of [{ ...coupon, value: 9.9 }, { ...coupon, unitIds: ['missing'] }, { ...coupon, unitIds: [unit.id, unit.id] }, { ...coupon, kind: 'free', value: 10 }]) {
      expect(() => calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [unit], effects: [effect] })).toThrow()
    }
    expect(() => calculateStackingPrice(DEFAULT_STACKING_POLICY, { units: [unit], effects: [coupon, coupon] })).toThrow('重复')
    expect(() => parseStackingPolicy({ ...DEFAULT_STACKING_POLICY, maxCoupons: 2 })).toThrow()
    expect(() => parseStackingPolicy({ ...DEFAULT_STACKING_POLICY, calculationOrder: ['member', 'member', 'points'] })).toThrow()
  })
  it('does not mutate source price/policy and allocates exact discount cents stably', () => {
    const scenario = { units: [unit], effects: [coupon] }
    const before = structuredClone(scenario)
    calculateStackingPrice(DEFAULT_STACKING_POLICY, scenario)
    expect(scenario).toEqual(before)
    expect([...allocateMinorAmount(1, [{ id: 'b', amountMinor: 1 }, { id: 'a', amountMinor: 1 }])]).toEqual([['b', 0], ['a', 1]])
    for (let a = 0; a < 20; a++) for (let b = 0; b < 20; b++) for (let amount = 0; amount <= a + b; amount++) {
      const values = allocateMinorAmount(amount, [{ id: 'a', amountMinor: a }, { id: 'b', amountMinor: b }])
      expect(values.get('a')! + values.get('b')!).toBe(amount)
      expect(values.get('a')!).toBeLessThanOrEqual(a)
      expect(values.get('b')!).toBeLessThanOrEqual(b)
    }
  })
})
