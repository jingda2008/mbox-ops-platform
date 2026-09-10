import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const row = (id, state = 'upcoming') => ({
  id, type: 'gift_product', state, quantityAvailable: 1, quantityReserved: 0, quantityRedeemed: 0,
  display: { title: '限时鸡尾酒' }, validFrom: '2026-09-09T16:00:00Z', validUntil: null,
  valueAmountMinor: 6800,
})
async function harness(platform, api) {
  let page
  vm.runInNewContext(await readFile(new URL('../' + platform + '/pages/profile-coupons/index.js', import.meta.url), 'utf8'), {
    Page(value) { page = value; page.setData = next => Object.assign(page.data, next) },
    require(name) {
      if (name.endsWith('/api')) return { getCustomerBenefitWallet: api }
      if (name.endsWith('/format')) return { money: n => '¥' + n / 100, dateInput: value => value }
      return { customerErrorMessage: (_, fallback) => fallback }
    },
  })
  return page
}
for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(platform + ': fixed selling price is not rendered as a deduction or a free gift', async () => {
    const page = await harness(platform, async () => ({ items: [{ ...row('low-price','available'),type:'discount',valueAmountMinor:0,pricePromise:{kind:'fixed_price',fixedPriceMinor:990,products:[{id:'snack',name:'薯条'}]} }],nextCursor:null }))
    await page.load()
    assert.equal(page.data.coupons[0].typeText,'固定低价兑换券')
    assert.equal(page.data.coupons[0].valueText,'¥9.9/份')
    assert.match(page.data.coupons[0].description,/不是减免金额.*薯条.*订单确认/)
  })
  test(platform + ': shows server calendar and shared frequency without claiming weekly grants', async () => {
    const page = await harness(platform, async () => ({ items: [{ ...row('window', 'outside_window'), calendar: {
      summary: '周一至周三，按营业日使用。', nextAvailableAt: '2026-09-14T13:00:00Z',
      limits: { perCustomerDay: 1, perCustomerWeek: 2, perCustomerCampaign: null },
    } }], nextCursor: null }))
    await page.load()
    const coupon = page.data.coupons[0]
    assert.equal(coupon.stateText, '非可用时段')
    assert.match(coupon.calendarNextText, /2026-09-14 21:00/)
    assert.match(coupon.calendarLimitText, /每日最多1次.*每周最多2次.*同活动多张券合计/)
    assert.match(coupon.quantityText, /^剩余/)
  })
  test(platform + ': future status and Beijing date, no fake gift cash balance', async () => {
    const page = await harness(platform, async () => ({ items: [row('a')], nextCursor: null }))
    await page.load()
    assert.equal(page.data.coupons[0].stateText, '未到使用时间')
    assert.match(page.data.coupons[0].validText, /2026-09-10 00:00/)
    assert.equal(page.data.coupons[0].valueText, '')
  })
  test(platform + ': pagination retry keeps existing wallet and deduplicates overlapping rows', async () => {
    let count = 0
    const page = await harness(platform, async cursor => {
      count++
      if (!cursor) return { items: [row('a')], nextCursor: 'next' }
      if (count === 2) throw new Error('network')
      return { items: [row('a'), row('b', 'reserved')], nextCursor: null }
    })
    await page.load()
    await page.loadMore()
    assert.equal(page.data.coupons.length, 1)
    assert.equal(page.data.nextCursor, 'next')
    assert.ok(page.data.moreError)
    await page.loadMore()
    assert.equal(page.data.coupons.length, 2)
    assert.equal(page.data.coupons[1].stateText, '使用处理中')
    assert.equal(page.data.nextCursor, null)
  })
  test(platform + ': hidden page rejects late response; next identity load clears old data', async () => {
    let resolve
    const page = await harness(platform, () => new Promise(r => { resolve = r }))
    const pending = page.load()
    page.onHide()
    resolve({ items: [row('old-account')], nextCursor: null })
    await pending
    assert.equal(page.data.coupons.length, 0)
    const fresh = page.load()
    resolve({ items: [row('new-account')], nextCursor: null })
    await fresh
    assert.equal(page.data.coupons[0].id, 'new-account')
  })
}
