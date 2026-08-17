import { LoyaltyAccrualRepository } from './loyalty-accrual-repository.js'
import { LoyaltyOperationalControlRepository } from './loyalty-operational-control-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

interface DeferredRow extends Record<string,unknown> {
  id:string
  order_id:string
  payment_id:string
  payment_succeeded_at:string
}

export interface LoyaltyAccrualDeferredBatch {
  workerId:string
  claimed:number
  applied:string[]
  notApplicable:string[]
  reviewRequired:string[]
  paused:boolean
}

export class LoyaltyAccrualDeferredWorker {
  constructor(private readonly transactions: Pick<ScopedPostgresTransactionRunner,'run'>) {}

  async runBatch(scope: Readonly<StoreScope>, workerId:string, batchSize=50):Promise<LoyaltyAccrualDeferredBatch> {
    validate(workerId,batchSize)
    const claimed = await this.transactions.run(scope, async (transaction) => {
      const control = await new LoyaltyOperationalControlRepository(transaction).state('points_accrual',true)
      if (control.state==='paused') return []
      const result = await transaction.query<DeferredRow>(`
        WITH candidates AS (
          SELECT id FROM mbox.loyalty_accrual_deferred_orders
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
            AND (status='pending'
              OR (status='review_required' AND updated_at<clock_timestamp()-interval '10 minutes')
              OR (status='processing' AND claimed_at<clock_timestamp()-interval '10 minutes'))
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $4
        )
        UPDATE mbox.loyalty_accrual_deferred_orders deferred
        SET status='processing',worker_id=$3,claimed_at=clock_timestamp(),
          resolved_at=NULL,resolution_code=NULL,updated_at=clock_timestamp()
        FROM candidates
        WHERE deferred.tenant_id=$1::uuid AND deferred.store_id=$2::uuid
          AND deferred.id=candidates.id
        RETURNING deferred.id,deferred.order_id,deferred.payment_id,
          deferred.payment_succeeded_at::text
      `,[scope.tenantId,scope.storeId,workerId,batchSize])
      return result.rows
    })
    const result:LoyaltyAccrualDeferredBatch = {
      workerId,claimed:claimed.length,applied:[],notApplicable:[],reviewRequired:[],paused:claimed.length===0
        ? await this.transactions.run(scope, async (transaction) => (
          (await new LoyaltyOperationalControlRepository(transaction).state('points_accrual')).state==='paused'
        ), { readOnly:true }) : false,
    }
    for (const row of claimed) {
      try {
        const resolution = await this.transactions.run(scope, async (transaction) => {
          const control = await new LoyaltyOperationalControlRepository(transaction).state('points_accrual',true)
          if (control.state==='paused') {
            await resetPending(transaction,row.id,workerId)
            return 'paused' as const
          }
          const before = await awardExists(transaction,row.order_id)
          await new LoyaltyAccrualRepository(transaction).recordPaidOrder({
            orderId:row.order_id,paymentId:row.payment_id,occurredAt:row.payment_succeeded_at,
          })
          const after = await awardExists(transaction,row.order_id)
          const status = after ? 'applied' : 'not_applicable'
          const code = after ? (before ? 'already_awarded' : 'award_applied') : 'not_loyalty_eligible'
          await transaction.query(`
            UPDATE mbox.loyalty_accrual_deferred_orders
            SET status=$5,resolution_code=$6,resolved_at=clock_timestamp(),
              worker_id=NULL,claimed_at=NULL,updated_at=clock_timestamp()
            WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
              AND status='processing' AND worker_id=$4
          `,[scope.tenantId,scope.storeId,row.id,workerId,status,code])
          return status
        })
        if (resolution==='applied') result.applied.push(row.id)
        else if (resolution==='not_applicable') result.notApplicable.push(row.id)
        else result.paused=true
      } catch {
        await this.transactions.run(scope,(transaction) => transaction.query(`
          UPDATE mbox.loyalty_accrual_deferred_orders
          SET status='review_required',resolution_code='processing_failed',
            resolved_at=clock_timestamp(),worker_id=NULL,claimed_at=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
            AND status='processing' AND worker_id=$4
        `,[scope.tenantId,scope.storeId,row.id,workerId]))
        result.reviewRequired.push(row.id)
      }
    }
    return result
  }
}

async function awardExists(transaction: ScopedTransaction,orderId:string):Promise<boolean> {
  const result = await transaction.query(`
    SELECT 1 FROM mbox.loyalty_order_awards
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
  `,[transaction.scope.tenantId,transaction.scope.storeId,orderId])
  return result.rowCount===1
}
async function resetPending(transaction: ScopedTransaction,id:string,workerId:string) {
  await transaction.query(`
    UPDATE mbox.loyalty_accrual_deferred_orders
    SET status='pending',worker_id=NULL,claimed_at=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status='processing' AND worker_id=$4
  `,[transaction.scope.tenantId,transaction.scope.storeId,id,workerId])
}
function validate(workerId:string,batchSize:number) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
  if (!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>100) throw new TypeError('batchSize is invalid')
}
