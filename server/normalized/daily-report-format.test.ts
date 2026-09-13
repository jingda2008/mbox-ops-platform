import { describe, expect, it } from 'vitest'
import { buildDailyReportLines } from './daily-report-format.js'
import type { OperatingHistory } from '../../src/shared/operating-history.js'
const snapshot = (): OperatingHistory => ({businessDate:'2026-09-12',generatedAt:'2026-09-13T00:00:00Z',page:0,hasMore:false,
  summary:{orderCount:200,orderAmountMinor:'20000',unsettledCount:0,outstandingMinor:'0',pendingPaymentCount:0,pendingRefundCount:0},
  receipts:[{provider:'cash',receivedMinor:20000,refundedMinor:1000,netMinor:19000}],
  orders:Array.from({length:200},(_,i)=>({id:`o${i}`,publicId:`order-${i}`,tableCode:'B05',employeeName:null,submittedAt:'2026-09-12T12:00:00Z',status:'completed',paymentStatus:'paid',totalMinor:100,
    items:[{id:`item${i}`,productId:'water',name:'水',quantity:1,unitPriceMinor:100,totalMinor:100,status:'delivered',note:null}]}))})
describe('daily report content modes',()=>{
  it('keeps the default compact for a busy night and preserves complete financial totals',()=>{
    const data=snapshot(),lines=buildDailyReportLines(data,data.businessDate,data.businessDate)
    expect(lines.length).toBeLessThan(12)
    expect(lines.find(line=>line.name==='销售合计')?.note).toBe('¥200.00')
    expect(lines.find(line=>line.name==='实际退款')?.note).toBe('¥10.00')
    expect(lines.find(line=>line.name==='净收')?.note).toBe('¥190.00')
    expect(lines.some(line=>line.name.includes('order-'))).toBe(false)
    const detailed=buildDailyReportLines(data,data.businessDate,data.businessDate,{mode:'details',grouping:'none'})
    expect(detailed.filter(line=>line.name.includes('order-'))).toHaveLength(200)
  })
  it('preserves bundle child quantities without counting their prices again',()=>{
    const data=snapshot();data.orders=data.orders.slice(0,1)
    data.orders[0]!.items.push({id:'child',name:'套餐内水',quantity:2,unitPriceMinor:100,totalMinor:200,includedInBundle:true,bundleParentId:'item0',status:'delivered',note:null})
    const lines=buildDailyReportLines(data,data.businessDate,data.businessDate,{mode:'summary',grouping:'bundles'})
    expect(lines.find(line=>line.name==='套餐内水')).toMatchObject({quantity:2,note:expect.stringContaining('不重复计费')})
    expect(lines.find(line=>line.name==='套餐内水')?.totalAmountMinor).toBeUndefined()
    expect(lines.find(line=>line.name==='水')?.totalAmountMinor).toBe(100)
  })
  it('does not silently print zero when summary evidence is missing',()=>{
    const data=snapshot();delete data.summary
    expect(()=>buildDailyReportLines(data,data.businessDate,data.businessDate)).toThrow('金额字段缺失')
  })
  it('keeps different or unknown units apart in category quantities',()=>{
    const data=snapshot();data.orders=data.orders.slice(0,2)
    data.orders[0]!.items[0]!.unitLabel='瓶';data.orders[1]!.items[0]!.unitLabel='ml'
    const lines=buildDailyReportLines(data,data.businessDate,data.businessDate,{mode:'summary',grouping:'categories'})
    const grouped=lines.filter(line=>line.name==='历史分类未留存')
    expect(grouped).toHaveLength(2);expect(grouped.map(line=>line.quantity)).toEqual([1,1])
  })
})
