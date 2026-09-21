import {describe,it,expect} from 'vitest'
import {readOperatingHistory} from './operating-history-query.js'
import type {ScopedTransaction} from './transaction-runner.js'
describe('operating history',()=>{
  it('exports beyond one page from the same read and refuses oversized exports without partial data',async()=>{
    const rows=Array.from({length:52},(_,i)=>({id:String(i),business_date:'2026-09-10',public_id:String(i),table_code:'W01',employee_name:null,submitted_at:'2026-09-10T01:00:00Z',status:'completed',payment_status:'paid',total_amount_minor:'100'}))
    const calls:unknown[][]=[]
    const tx={scope:{tenantId:'tenant',storeId:'store'},query:async(sql:string,values:unknown[])=>{calls.push(values);return{rows:sql.includes('FROM mbox.orders ordering')?rows:[]}}} as unknown as ScopedTransaction
    const result=await readOperatingHistory(tx,{businessDate:'2026-09-10',table:'',employee:'',page:2,exportAll:true})
    expect(result.orders).toHaveLength(52)
    expect(result.hasMore).toBe(false)
    expect(calls[0]?.[5]).toBe(0)
    rows.push(...Array.from({length:4949},()=>rows[0]!))
    await expect(readOperatingHistory(tx,{businessDate:'2026-09-10',table:'',employee:'',page:0,exportAll:true})).rejects.toThrow('不会只导出部分数据')
  })
  it('uses posted ledger receipts and keeps negative net days instead of inventing income',async()=>{
    const calls:Array<{sql:string;values:unknown[]|undefined}>=[]
    const tx={scope:{tenantId:'tenant',storeId:'store'},query:async(sql:string,values?:unknown[])=>{
      calls.push({sql,values})
      return {rows:sql.includes('reconciliation_entries')?[{provider:'cash',received:'1000',refunded:'1800',net:'-800'}]:[]}
    }} as unknown as ScopedTransaction
    const result=await readOperatingHistory(tx,{businessDate:'2026-09-09',table:'L01',employee:'张三',page:2})
    expect(result.receipts).toEqual([{provider:'cash',receivedMinor:1000,refundedMinor:1800,netMinor:-800}])
    expect(result.orders).toEqual([])
    expect(calls[0]?.values).toEqual(['tenant','store','2026-09-09','L01','张三',100,'2026-09-09',null,'','','',null,null,null])
    expect(calls[1]?.values).toEqual(['tenant','store','2026-09-09','2026-09-09'])
    expect(calls.every(call=>!/(UPDATE|INSERT|DELETE)/.test(call.sql))).toBe(true)
  })
  it('applies the same date range to orders and ledger without applying employee filters to receipts',async()=>{
    const calls:unknown[][]=[]
    const tx={scope:{tenantId:'tenant',storeId:'store'},query:async(sql:string,values:unknown[])=>{calls.push(values);return {rows:sql.includes('operating_day_summary')?[
      {summary:{orderCount:1,orderAmountMinor:'2000',unsettledCount:1,outstandingMinor:'500',pendingPaymentCount:0,pendingRefundCount:1}},
      {summary:{orderCount:2,orderAmountMinor:'3000',unsettledCount:0,outstandingMinor:'0',pendingPaymentCount:0,pendingRefundCount:2}},
    ]:[]}}} as unknown as ScopedTransaction
    const result=await readOperatingHistory(tx,{businessDate:'2026-09-01',endDate:'2026-09-10',table:'W01',employee:'员工',page:0})
    expect(calls).toEqual([['tenant','store','2026-09-01','W01','员工',0,'2026-09-10',null,'','','',null,null,null],['tenant','store','2026-09-01','2026-09-10'],['tenant','store','2026-09-01','2026-09-10']])
    expect(result.endDate).toBe('2026-09-10')
    expect(result.summary).toEqual({orderCount:3,orderAmountMinor:'5000',unsettledCount:1,outstandingMinor:'500',pendingPaymentCount:0,pendingRefundCount:3})
  })
  it('never fills missing range money with zero and does not reveal summaries to non-financial roles',async()=>{
    let summaryReads=0
    const tx={scope:{tenantId:'tenant',storeId:'store'},query:async(sql:string)=>{
      if(sql.includes('operating_day_summary')){summaryReads++;return {rows:[{summary:{orderCount:1}}]}}
      return {rows:[]}
    }} as unknown as ScopedTransaction
    const filter={businessDate:'2026-09-01',endDate:'2026-09-10',table:'',employee:'',page:0}
    await expect(readOperatingHistory(tx,filter)).rejects.toThrow('营业汇总字段缺失')
    const restricted=await readOperatingHistory(tx,{...filter,allowFinancialSummary:false})
    expect(restricted.summary).toBeUndefined()
    expect(restricted.receipts).toEqual([])
    expect(summaryReads).toBe(1)
  })
  it('keeps long historical exports available without unbounded per-day summary work',async()=>{
    const reads:string[]=[]
    const tx={scope:{tenantId:'tenant',storeId:'store'},query:async(sql:string)=>{reads.push(sql);return {rows:[]}}} as unknown as ScopedTransaction
    const result=await readOperatingHistory(tx,{businessDate:'2020-01-01',endDate:'2030-01-01',table:'',employee:'',page:0,exportAll:true})
    expect(result.summary).toBeUndefined()
    expect(reads.some(sql=>sql.includes('operating_day_summary'))).toBe(false)
    expect(reads.some(sql=>sql.includes('reconciliation_entries'))).toBe(true)
  })
  it('paginates shared facts independently and never reads them without an explicit authorized delivery scope',async()=>{
    const calls:Array<{sql:string;values:unknown[]|undefined}>=[]
    const rows=Array.from({length:51},(_,index)=>({id:`receipt-${index}`,business_date:'2026-09-21',table_session_id:'visit',table_code:'A2',pickup_table_code:'A1',taken_at:'2026-09-21T01:23:45Z',units:[]}))
    const tx={scope:{tenantId:'tenant',storeId:'store'},query:async(sql:string,values?:unknown[])=>{calls.push({sql,values});return {rows:sql.includes('FROM mbox.pickup_receipts receipt')?rows:[]}}} as unknown as ScopedTransaction
    const filter={businessDate:'2026-09-21',table:'A',employee:'',page:2,allowFinancialSummary:false,workKind:'delivered' as const,workEmployeeId:'reader'}
    expect((await readOperatingHistory(tx,filter)).sharedDeliveries).toBeUndefined()
    expect(calls.some(call=>call.sql.includes('FROM mbox.pickup_receipts receipt'))).toBe(false)
    const result=await readOperatingHistory(tx,{...filter,sharedDeliveryScope:{employeeId:'reader',canViewAllTables:false}})
    expect(result.orders).toEqual([]);expect(result.hasMore).toBe(true);expect(result.sharedDeliveries).toHaveLength(50)
    expect(result.sharedDeliveries![0]).toMatchObject({source:'shared_pickup_device',tableCode:'A2',pickupTableCode:'A1',deliveredAt:'2026-09-21T01:23:45.000Z'})
    expect(calls.find(call=>call.sql.includes('FROM mbox.pickup_receipts receipt'))?.values).toEqual(['tenant','store','2026-09-21','2026-09-21',null,'A',false,'reader',100])
  })
})
