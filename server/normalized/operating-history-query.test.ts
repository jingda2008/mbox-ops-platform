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
    expect(calls[0]?.values).toEqual(['tenant','store','2026-09-09','L01','张三',100,'2026-09-09'])
    expect(calls[1]?.values).toEqual(['tenant','store','2026-09-09','2026-09-09'])
    expect(calls.every(call=>!/(UPDATE|INSERT|DELETE)/.test(call.sql))).toBe(true)
  })
  it('applies the same date range to orders and ledger without applying employee filters to receipts',async()=>{
    const calls:unknown[][]=[]
    const tx={scope:{tenantId:'tenant',storeId:'store'},query:async(_sql:string,values:unknown[])=>{calls.push(values);return {rows:[]}}} as unknown as ScopedTransaction
    const result=await readOperatingHistory(tx,{businessDate:'2026-09-01',endDate:'2026-09-10',table:'W01',employee:'员工',page:0})
    expect(calls).toEqual([['tenant','store','2026-09-01','W01','员工',0,'2026-09-10'],['tenant','store','2026-09-01','2026-09-10']])
    expect(result.endDate).toBe('2026-09-10')
  })
})
