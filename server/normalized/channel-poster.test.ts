import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { buildChannelPosterSvg, renderChannelPoster, wrapChannelPosterText } from './channel-poster.js'
import type { ChannelRule } from '../../src/shared/channel-distribution.js'
const id='11111111-1111-4111-8111-111111111111'
const base:ChannelRule={title:'晚间餐后小聚',totalClaims:10,perCustomerClaims:1,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:3500,claimFrom:'2026-12-31T15:59:00Z',claimUntil:'2026-12-31T16:01:00Z',useFrom:'2026-12-31T15:59:00Z',useUntil:'2027-01-01T02:00:00Z',minimumMinor:10000,eligibleProductIds:[id],eligibleProductNames:[{id,name:'指定鸡尾酒 <限量> & 双人款'}],offer:{kind:'discount',discountBps:1500,maximumMinor:2000},commissionBps:1000,observationDays:7}
const input=(rule=base)=>({source:'演示川菜店',code:'ABCDEFGH2345',rule,accepting:true})
describe('channel poster saved scope and safe layout',()=>{
 it('shows exact eligibility, payable discount and Beijing year boundary without private commission terms',()=>{
  const svg=buildChannelPosterSvg(input(),'data:image/png;base64,demo')
  for(const text of ['8.5折（减免 15%）','每券上限 ¥20.00','仅限以下商品（共 1 款）','指定鸡尾酒 &lt;限量&gt; &amp; 双人款','满 ¥100.00','每人限领 1 次 · 每客组限用 2 次','2026-12-31 23:59','2027-01-01 00:01','2027-01-01 10:00','客组优惠合计最高 ¥35.00'])expect(svg).toContain(text)
  expect(svg).not.toMatch(/commission|佣金|结算主体/)
 })
 it.each([{kind:'credit',amountMinor:1234} as const,{kind:'gift',productId:id,productName:'演示薯条',quantity:2,costMinor:4321} as const])('keeps product restrictions on $kind posters without exposing gift costs',async offer=>{
  const rule={...base,offer,allowStacking:false,visitDiscountCapMinor:null};const svg=buildChannelPosterSvg(input(rule),'data:image/png;base64,demo')
  expect(svg).toContain('仅限以下商品');expect(svg).toContain('不叠加');expect(svg).not.toContain('43.21');expect(svg).toContain(offer.kind==='credit'?'减免 ¥12.34':'赠 演示薯条 × 2')
  const code=await sharp({create:{width:50,height:50,channels:3,background:'#174d36'}}).png().toBuffer();const png=await renderChannelPoster(input(rule),code);const meta=await sharp(png).metadata();expect(meta.format).toBe('png');expect(meta.width).toBe(900);expect(meta.height).toBeGreaterThan(1000)
 })
 it('summarizes the authoritative all-products scope without printing every name',()=>{
  const svg=buildChannelPosterSvg(input({...base,eligibleProductScope:'all'}),'demo')
  expect(svg).toContain('全部商品参与');expect(svg).toContain('生成时在售商品');expect(svg).not.toContain('指定鸡尾酒');expect(svg).not.toContain('仅限以下商品')
 })
 it('bounds long lists, exposes truncation and reserves space before the code',()=>{
  const ids=Array.from({length:500},(_,n)=>`product-${n}`),rule={...base,eligibleProductIds:ids,eligibleProductNames:ids.map((id,n)=>({id,name:`第${n}款`+'超长商品🧋'.repeat(30)}))}
  const svg=buildChannelPosterSvg(input(rule),'data:image/png;base64,demo');expect(svg).toContain('共 500 款');expect(svg).toContain('完整适用范围请微信扫码查看');expect(svg).toContain('…')
  const qrY=Number(svg.match(/<image x="280" y="(\d+)"/)![1]);const preceding=svg.split('<image')[0]!;const ys=[...preceding.matchAll(/<text x="75" y="(\d+)"/g)].map(x=>Number(x[1]));expect(Math.max(...ys)).toBeLessThan(qrY-30);expect(Number(svg.match(/height="(\d+)"/)![1])).toBeLessThan(1900)
  expect(wrapChannelPosterText('中'.repeat(90),56,6).truncated).toBe(false)
 })
 it('does not describe missing labels or unrelated snapshot entries as usable products',()=>{
  expect(()=>buildChannelPosterSvg(input({...base,eligibleProductNames:[]}), 'demo')).toThrow('名称未完整读取')
  const svg=buildChannelPosterSvg(input({...base,eligibleProductNames:[...base.eligibleProductNames!,{id:'unrelated',name:'全场通用'}]}),'demo');expect(svg).not.toContain('全场通用')
 })
 it('renders maximum reduction unambiguously and escapes markup',()=>{
  const svg=buildChannelPosterSvg(input({...base,title:'<script>安全测试</script>',offer:{kind:'discount',discountBps:10000,maximumMinor:12345}}),'demo');expect(svg).toContain('全额减免');expect(svg).toContain('¥123.45');expect(svg).not.toContain('<script>');expect(svg).toContain('&lt;script&gt;')
 })
})
