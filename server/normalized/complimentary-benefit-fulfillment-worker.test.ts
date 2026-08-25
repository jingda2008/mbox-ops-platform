import { describe,expect,it,vi } from 'vitest'
import { ComplimentaryBenefitFulfillmentWorker } from './complimentary-benefit-fulfillment-worker.js'

const scope={
  tenantId:'91000000-0000-4000-8000-000000000001',
  storeId:'91000000-0000-4000-8000-000000000002',
}
const intentId='91000000-0000-4000-8000-000000000003'
const orderId='91000000-0000-4000-8000-000000000004'
const benefitId='91000000-0000-4000-8000-000000000005'
const orderItemId='91000000-0000-4000-8000-000000000006'
const taskId='91000000-0000-4000-8000-000000000007'

describe('ComplimentaryBenefitFulfillmentWorker',() => {
  it('dispatches an already-idempotent KDS task and records durable outbox facts',async () => {
    const query=vi.fn(async (sql:string) => {
      if (sql.includes('SELECT id\n        FROM mbox.complimentary')) return result([{ id:intentId }])
      if (sql.includes('SELECT id,order_id,benefit_id')) return result([{
        id:intentId,order_id:orderId,benefit_id:benefitId,attempt_count:0,
      }])
      if (sql.includes('FROM mbox.order_items AS item')&&sql.includes('JOIN mbox.orders AS order_row')) return result([{
        order_item_id:orderItemId,station_code:'bar',quantity:1,
        fulfillment_priority:100,fulfillment_due_at:null,
      }])
      if (sql.includes('FROM mbox.kds_tasks')) return result([{
        id:taskId,order_item_id:orderItemId,station_code:'bar',status:'pending',
        priority:100,quantity:1,assigned_employee_id:null,due_at:null,
        next_action_at:'2026-08-25T00:00:00.000Z',accepted_at:null,ready_at:null,cancelled_at:null,
      }])
      if (sql.includes("SET status='dispatched'")) return result([],1)
      if (sql.includes('INSERT INTO mbox.outbox_messages')) return result([{
        id:'91000000-0000-4000-8000-000000000008',
      }])
      if (sql.includes('FROM mbox.orders AS ordering')) return result([{
        order_id:orderId,order_public_id:'benefit-gift-test',order_note:null,
        total_amount_minor:'0',currency:'CNY',payment_status:'paid',table_code:'T01',guest_count:2,
        business_date:'2026-08-25',submitted_at:'2026-08-25T00:00:00.000Z',
      }])
      if (sql.includes('FROM mbox.order_items AS item')) return result([{
        item_id:orderItemId,parent_order_item_id:null,quantity:1,total_amount_minor:'0',
        fulfillment_station:'bar',product_snapshot:{ name:'会员礼赠',categoryCode:'gift',productKind:'single' },note:null,
      }])
      if (sql.includes('FROM mbox.printer_routes AS route')) return result([])
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const transactions={ run:vi.fn(async (_scope,operation) => operation({ scope,query })) }
    const worker=new ComplimentaryBenefitFulfillmentWorker(
      transactions as never,()=> '2026-08-25T00:00:00.000Z',
    )

    await expect(worker.runBatch(scope,'worker:complimentary-benefit')).resolves.toMatchObject({
      examined:1,dispatched:1,retrying:0,failed:0,dispatchedIntentIds:[intentId],
    })
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE SKIP LOCKED'))).toBe(true)
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO mbox.outbox_messages'))).toHaveLength(2)
  })

  it('keeps a visible retry fact when KDS creation fails after redemption committed',async () => {
    let transactionNumber=0
    const transactions={ run:vi.fn(async (_scope,operation) => {
      transactionNumber+=1
      const query=vi.fn(async (sql:string) => {
        if (transactionNumber===1) return result([{ id:intentId }])
        if (transactionNumber===2 && sql.includes('SELECT id,order_id,benefit_id')) return result([{
          id:intentId,order_id:orderId,benefit_id:benefitId,attempt_count:0,
        }])
        if (transactionNumber===2 && sql.includes('FROM mbox.order_items AS item')) return result([{
          order_item_id:orderItemId,station_code:'bar',quantity:1,
          fulfillment_priority:100,fulfillment_due_at:null,
        }])
        if (transactionNumber===2 && sql.includes('FROM mbox.kds_tasks')) return result([])
        if (transactionNumber===2 && sql.includes('INSERT INTO mbox.kds_tasks')) throw new Error('KDS temporarily unavailable')
        if (transactionNumber===3 && sql.includes('UPDATE mbox.complimentary_fulfillment_intents')) {
          return result([{ status:'retry' }])
        }
        throw new Error(`unexpected SQL in transaction ${transactionNumber}: ${sql}`)
      })
      return operation({ scope,query })
    }) }
    const worker=new ComplimentaryBenefitFulfillmentWorker(
      transactions as never,()=> '2026-08-25T00:00:00.000Z',
    )

    await expect(worker.runBatch(scope,'worker:complimentary-benefit')).resolves.toMatchObject({
      examined:1,dispatched:0,retrying:1,failed:0,retryIntentIds:[intentId],
    })
    expect(transactions.run).toHaveBeenCalledTimes(3)
  })

  it('does not report dispatch when an invalid order has no physical fulfillment line',async () => {
    let transactionNumber=0
    const transactions={ run:vi.fn(async (_scope,operation) => {
      transactionNumber+=1
      const query=vi.fn(async (sql:string) => {
        if (transactionNumber===1) return result([{ id:intentId }])
        if (transactionNumber===2 && sql.includes('SELECT id,order_id,benefit_id')) return result([{
          id:intentId,order_id:orderId,benefit_id:benefitId,attempt_count:0,
        }])
        if (transactionNumber===2 && sql.includes('FROM mbox.order_items AS item')) return result([])
        if (transactionNumber===3 && sql.includes('UPDATE mbox.complimentary_fulfillment_intents')) {
          return result([{ status:'retry' }])
        }
        throw new Error(`unexpected SQL in transaction ${transactionNumber}: ${sql}`)
      })
      return operation({ scope,query })
    }) }
    const worker=new ComplimentaryBenefitFulfillmentWorker(
      transactions as never,()=> '2026-08-25T00:00:00.000Z',
    )

    await expect(worker.runBatch(scope,'worker:complimentary-benefit')).resolves.toMatchObject({
      dispatched:0,retrying:1,failed:0,retryIntentIds:[intentId],
    })
  })
})

function result(rows:Record<string,unknown>[],rowCount=rows.length) {
  return { rows,rowCount }
}
