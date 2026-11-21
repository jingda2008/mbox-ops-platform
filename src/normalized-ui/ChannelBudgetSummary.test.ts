import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {describe,it,expect} from 'vitest'
import type {ChannelRule} from '../shared/channel-distribution'
import {ChannelBudgetSummary} from './ChannelBudgetSummary'
const gift={totalClaims:50,offer:{kind:'gift',productId:'gift',quantity:1,costMinor:260000}} as ChannelRule
const render=(props:Parameters<typeof ChannelBudgetSummary>[0])=>renderToStaticMarkup(createElement(ChannelBudgetSummary,props))
describe('staff coupon cost explanation',()=>{
 it('reproduces the 50 coupons, 2600 yuan gift and 2000 yuan warning budgets without blocking claims',()=>{
  const html=render({rule:gift,saved:true,campaignLimit:'200000',storeLimit:'200000'})
  for(const text of ['¥2600.00','¥130000.00','¥2000.00','不拦截新领取','不自动调整预算'])expect(html).toContain(text)
 })
 it('uses current catalog cost before saving and immutable batch cost afterwards',()=>{
  const props={rule:gift,products:[{id:'gift',costAmountMinor:'1040'}]}
  expect(render(props)).toContain('¥10.40');expect(render({...props,saved:true})).toContain('¥2600.00')
  expect(render({rule:gift})).toContain('赠品成本尚未读回')
 })
 it('distinguishes a zero gift cost and maximum discount estimate without reserving',()=>{
  expect(render({rule:gift,products:[{id:'gift',costAmountMinor:'0'}],campaignLimit:'0',storeLimit:'0'})).not.toContain('当前无法领取')
  const rule={...gift,offer:{kind:'discount',discountBps:1000,maximumMinor:1234}} as ChannelRule
  const html=render({rule,campaignLimit:'1234',storeLimit:'1234'})
  expect(html).toContain('¥12.34');expect(html).not.toContain('当前无法领取');expect(html).toContain('以上估算不是实际支出')
 })
})
