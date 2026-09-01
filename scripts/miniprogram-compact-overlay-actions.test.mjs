import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('overlay close and share controls keep an 88rpx hit target with compact visual surfaces', async () => {
  const style = await source('miniprogram/app.wxss')

  assert.match(style, /\.compact-icon-action,\s*\.compact-text-action\s*\{\s*position:\s*relative;/)
  assert.doesNotMatch(style, /\.compact-icon-action\.compact-icon-action,\s*\.compact-text-action\.compact-text-action\s*\{[^}]*position:/)
  assert.match(style, /\.compact-icon-action\.compact-icon-action,\s*\.compact-text-action\.compact-text-action\s*\{[\s\S]*?width:\s*88rpx;[\s\S]*?min-width:\s*88rpx;[\s\S]*?height:\s*88rpx;[\s\S]*?min-height:\s*88rpx;/)
  assert.match(style, /\.compact-icon-action::before\s*\{[^}]*width:\s*48rpx;[^}]*height:\s*48rpx;[^}]*border-radius:\s*50%;/)
  assert.match(style, /\.compact-text-action::before\s*\{[^}]*width:\s*80rpx;[^}]*height:\s*48rpx;[^}]*border-radius:\s*24rpx;/)
})

test('all overlay dismiss controls and the custom activity share control use the compact visual system', async () => {
  const [order, home, profile, community, detail] = await Promise.all([
    source('miniprogram/pages/order/index.wxml'),
    source('miniprogram/pages/home/index.wxml'),
    source('miniprogram/pages/profile/index.wxml'),
    source('miniprogram/pages/community/index.wxml'),
    source('miniprogram/pages/community-detail/index.wxml'),
  ])

  assert.match(order, /class="recommend-question__close compact-text-action"/)
  assert.match(order, /class="product-detail-close compact-icon-action"/)
  assert.match(order, /class="checkout-confirm__close compact-text-action"[^>]*>关闭<\/button>/)
  assert.match(order, /class="payment-result__close compact-text-action"[^>]*>关闭<\/button>/)
  assert.doesNotMatch(order, /取消并关闭付款提示|取消并关闭订单明细/)
  assert.match(home, /class="compact-icon-action" aria-label="关闭演出详情"/)
  assert.match(home, /class="editorial-panel__close compact-icon-action"/)
  assert.match(home, /class="member-invite-close compact-icon-action"/)
  assert.match(profile, /class="login-sheet__close compact-icon-action"/)
  assert.match(community, /class="community-member-close compact-icon-action"/)
  assert.match(detail, /class="detail-share compact-text-action" open-type="share"/)
  assert.match(detail, /class="detail-member-close compact-icon-action"/)
})

test('order headers reclaim the space previously reserved for oversized dismiss controls', async () => {
  const style = await source('miniprogram/pages/order/index.wxss')

  assert.match(style, /\.recommend-question__head text:last-child\s*\{[^}]*padding-right:\s*112rpx;/)
  assert.match(style, /\.checkout-confirm__head\s*\{\s*padding-right:\s*112rpx;/)
  assert.match(style, /\.checkout-confirm__close-slot\s*\{[\s\S]*?width:\s*88rpx;[\s\S]*?height:\s*88rpx;/)
  assert.doesNotMatch(style, /\.checkout-confirm__close-slot\s*\{[^}]*width:\s*200rpx;/)
})
