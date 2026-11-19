import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChannelRuleSummary } from './ChannelRuleSummary'
import type { ChannelRule } from '../shared/channel-distribution'
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
const rule:ChannelRule={title:'审核优惠',totalClaims:13,perCustomerClaims:2,perVisitUses:3,allowStacking:true,visitDiscountCapMinor:4567,claimFrom:'2026-12-31T15:59:00Z',claimUntil:'2026-12-31T16:01:00Z',useFrom:'2026-12-31T15:59:00Z',useUntil:'2027-01-01T02:00:00Z',minimumMinor:12345,eligibleProductIds:[id],eligibleProductNames:[{id,name:'发行时饮品名'}],commissionProductIds:[other],offer:{kind:'discount',discountBps:1500,maximumMinor:2000},commissionBps:850,observationDays:9}
describe('complete channel review summary',()=>{
 it('shows saved eligibility and separate commission scope with every financial and time condition',()=>{
  const html=renderToStaticMarkup(createElement(ChannelRuleSummary,{rule,products:[{id,name:'改名后的饮品'},{id:other,name:'单独计佣薯条'}],contract:{version:'v2',settlementSubject:'演示结算公司',terms:'按净实收计佣'},saved:true}))
  for(const part of ['8.5折','123.45','13','2','3','45.67','2026-12-31 23:59','2027-01-01 00:01','2027-01-01 10:00','发行时饮品名','单独计佣薯条','8.5','9','v2','演示结算公司','按净实收计佣'])expect(html).toContain(part)
  expect(html).not.toContain('改名后的饮品')
 })
 it('keeps the same complete rule display before generation and on approval; marks unknown products',()=>{
  const modified={...rule,allowStacking:false,visitDiscountCapMinor:null,commissionProductIds:undefined,eligibleProductNames:undefined}
  const html=renderToStaticMarkup(createElement(ChannelRuleSummary,{rule:modified}));expect(html).toContain('不叠加');expect(html).toContain('与适用商品相同');expect(html).toContain('待核对商品');expect(html).toContain('待核对原合作条款');expect(html).not.toContain('全场')
 })
 it('distinguishes pending server gift cost from the frozen cost and explicit unlimited stacking',()=>{
  const gift={...rule,visitDiscountCapMinor:null,offer:{kind:'gift' as const,productId:id,quantity:2,costMinor:1234,productName:'赠品'}}
  expect(renderToStaticMarkup(createElement(ChannelRuleSummary,{rule:gift}))).toContain('保存时由服务器')
  const saved=renderToStaticMarkup(createElement(ChannelRuleSummary,{rule:gift,saved:true}));expect(saved).toContain('12.34');expect(saved).toContain('未设置客组总优惠上限')
 })
})
