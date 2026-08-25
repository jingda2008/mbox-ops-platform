import {describe,expect,it,vi} from 'vitest'
import {closeAwaitingBusinessDays} from './business-day-closure.js'
import type {ScopedTransaction} from './transaction-runner.js'

const scope={tenantId:'11111111-1111-4111-8111-111111111111',storeId:'22222222-2222-4222-8222-222222222222'}
const dayId='33333333-3333-4333-8333-333333333333'
const safeSessionId='44444444-4444-4444-8444-444444444444'
const blockedSessionId='55555555-5555-4555-8555-555555555555'

const zeroCounts={order_unsettled:'0',order_item_unresolved:'0',kds_active:'0',payment_pending:'0',
  inventory_reserved:'0',refund_pending:'0',service_active:'0',pricing_reserved:'0',song_active:'0',
  benefit_reserved:'0',experience_active:'0',redemption_pending:'0',checkout_offer_active:'0',
  outstanding_order_count:'0',outstanding_amount_minor:'0'}

describe('closeAwaitingBusinessDays',()=>{
  it('closes safe tables but keeps a prior day pending with explicit blockers',async()=>{
    const transaction:ScopedTransaction={scope,query:vi.fn(async(sql:string,values?:readonly unknown[])=>{
      if(sql.includes('mbox.employee_has_effective_permission')) return {rows:[{allowed:true}],rowCount:1}
      if(sql.includes("FROM mbox.business_days") && sql.includes("status='awaiting_close'")){
        return {rows:[{id:dayId,business_date:'2026-08-20'}],rowCount:1}
      }
      if(sql.includes('FOR UPDATE OF session')) return {rows:[
        {id:safeSessionId,table_code:'L01',status:'open'},
        {id:blockedSessionId,table_code:'VIP1',status:'closing'},
      ],rowCount:2}
      if(sql.includes("'payment'::text AS entity_type")) return {rows:[{
        entity_type:'payment',entity_id:'77777777-7777-4777-8777-777777777777',
        reference:'PAYMENT-VIP1-0001',title:'付款结果待确认',status:'pending',amount_minor:'6800',
        quantity_text:null,order_id:'88888888-8888-4888-8888-888888888888',
        order_public_id:'ORDER-VIP1-0001',responsible_employee_name:'李艳',
      }],rowCount:1}
      if(sql.includes('WITH scoped_orders AS')) return {
        rows:[values?.[2]===blockedSessionId ? {...zeroCounts,payment_pending:'2'}:zeroCounts],rowCount:1,
      }
      if(sql.includes('UPDATE mbox.table_sessions')) return {
        rows:[{id:safeSessionId,closed_at:'2026-08-21T02:00:00.000Z'}],rowCount:1,
      }
      throw new Error(`unexpected query: ${sql}`)
    })}
    const outcome=await closeAwaitingBusinessDays(transaction,{type:'employee',employeeId:'66666666-6666-4666-8666-666666666666'},'manual_pending_business_day_close')
    expect(outcome.result).toMatchObject({closedBusinessDayCount:0,closedTableSessionCount:1,
      blockedTableSessionCount:1,businessDays:[{businessDate:'2026-08-20',status:'awaiting_close',
        closedTableSessions:[{tableCode:'L01'}],blockers:[{tableCode:'VIP1',code:'PAYMENT_PENDING',count:2}]}]})
    expect(outcome.auditEvents).toHaveLength(1)
    expect(outcome.outboxMessages).toHaveLength(1)
    expect(transaction.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE mbox.business_days'),expect.anything())
  })

  it('closes an awaiting day when no active table remains',async()=>{
    const transaction:ScopedTransaction={scope,query:vi.fn(async(sql:string)=>{
      if(sql.includes("FROM mbox.business_days") && sql.includes("status='awaiting_close'")){
        return {rows:[{id:dayId,business_date:'2026-08-20'}],rowCount:1}
      }
      if(sql.includes('FOR UPDATE OF session')) return {rows:[],rowCount:0}
      if(sql.includes('UPDATE mbox.business_days')) return {
        rows:[{closed_at:'2026-08-21T02:00:00.000Z'}],rowCount:1,
      }
      throw new Error(`unexpected query: ${sql}`)
    })}
    const outcome=await closeAwaitingBusinessDays(transaction,{type:'system',ref:'worker:business-day'},'automatic_business_day_rollover')
    expect(outcome.result).toMatchObject({closedBusinessDayCount:1,closedTableSessionCount:0,
      blockedTableSessionCount:0,businessDays:[{status:'closed'}]})
    expect(outcome.auditEvents[0]).toMatchObject({action:'business_day.closed',actor:{type:'system'}})
    expect(outcome.outboxMessages[0]).toMatchObject({eventType:'business_day.closed.v1'})
  })
})
