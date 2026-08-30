import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

async function loadShareModule() {
  const source = await read('miniprogram/utils/public-share.js')
  const calls = []
  const context = {
    module: { exports: {} }, exports: {},
    wx: {
      showShareMenu: (options) => {
        calls.push(options)
        return Promise.resolve()
      },
    },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/public-share.js' })
  return { share: context.module.exports, calls }
}

test('public sharing exposes only approved public routes and strips unsafe query state', async () => {
  const { share } = await loadShareModule()
  assert.equal(
    share.publicSharePayload({ title: '今晚菜单', path: '/pages/order/index?tableToken=secret' }).path,
    '/pages/order/index',
  )
  assert.equal(
    share.publicSharePayload({ title: '活动', path: '/pages/community-detail/index?id=ACT-001&source=share' }).path,
    '/pages/community-detail/index?id=ACT-001&source=share',
  )
  assert.equal(
    share.publicSharePayload({ title: '个人订单', path: '/pages/account/index?orderId=ORD-001' }).path,
    '/pages/home/index',
  )
  assert.equal(
    JSON.stringify(share.publicTimelinePayload({ title: '演出', path: '/pages/performances/index?date=2026-09-01' })),
    JSON.stringify({ title: '演出', query: 'date=2026-09-01' }),
  )
})

test('public pages explicitly expose WeChat friend and timeline sharing while private pages remain excluded', async () => {
  const publicPages = [
    'home/index.js', 'brand-story/index.js', 'performances/index.js', 'community/index.js',
    'community-detail/index.js', 'reservations/index.js', 'order/index.js',
  ]
  const privatePages = [
    'account/index.js', 'profile/index.js', 'profile-coupons/index.js', 'profile-notifications/index.js',
    'member-center/index.js', 'points/index.js', 'service/index.js', 'status/index.js', 'complaint/index.js', 'songs/index.js',
  ]
  for (const page of publicPages) {
    const source = await read(`miniprogram/pages/${page}`)
    assert.match(source, /enablePublicShareMenu/)
    assert.match(source, /onShareAppMessage\(\)/)
    assert.match(source, /onShareTimeline\(\)/)
  }
  for (const page of privatePages) {
    const source = await read(`miniprogram/pages/${page}`)
    assert.doesNotMatch(source, /onShareAppMessage\(\)|onShareTimeline\(\)|open-type="share"/)
  }
})

test('the native share menu enables both recipient surfaces without a share ticket', async () => {
  const { share, calls } = await loadShareModule()
  share.enablePublicShareMenu()
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([{ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] }]),
  )
})

test('shared performance links preserve a future selected date but never revive a past date', async () => {
  const source = await read('miniprogram/pages/performances/index.js')
  assert.match(source, /function shareableDate\(value\)/)
  assert.match(source, /onLoad\(options\)[\s\S]*?shareableDate\(options && options\.date\)/)
  assert.match(source, /pages\/performances\/index\?date=\$\{encodeURIComponent\(shareableDate\(this\.data\.selectedDate\)\)\}/)
})
