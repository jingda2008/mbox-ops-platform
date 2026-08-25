import { appendOutboxMessage } from './command-executor.js'
import { KdsRepository, type KdsStation, type KdsTask } from './kds-repository.js'
import { PrintTicketSourceRepository } from './print-ticket-source.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

interface IntentRow extends Record<string, unknown> {
  id: string
  order_id: string
  benefit_id: string
  attempt_count: number
}

interface FulfillmentItemRow extends Record<string, unknown> {
  order_item_id: string
  station_code: KdsStation
  quantity: number
  fulfillment_priority: number
  fulfillment_due_at: string | null
}

interface ExistingTaskRow extends Record<string, unknown> {
  id: string
  order_item_id: string
  station_code: KdsStation
  status: KdsTask['status']
  priority: number
  quantity: number
  assigned_employee_id: string | null
  due_at: string | null
  next_action_at: string
  accepted_at: string | null
  ready_at: string | null
  cancelled_at: string | null
}

export interface ComplimentaryBenefitFulfillmentBatch {
  workerId: string
  evaluatedAt: string
  examined: number
  dispatched: number
  retrying: number
  failed: number
  dispatchedIntentIds: readonly string[]
  retryIntentIds: readonly string[]
  failedIntentIds: readonly string[]
}

/**
 * Turns a durable complimentary-order intent into KDS work only after the
 * benefit redemption transaction has committed. Each intent is locked and all
 * of its station tasks are created atomically. A transient failure therefore
 * leaves a visible retry state instead of rolling back the customer's claim.
 */
export class ComplimentaryBenefitFulfillmentWorker {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 100,
  ): Promise<ComplimentaryBenefitFulfillmentBatch> {
    validateWorker(workerId,batchSize)
    const evaluatedAt=this.now()
    if (!Number.isFinite(Date.parse(evaluatedAt))) throw new TypeError('worker time is invalid')
    const intentIds=await this.transactions.run(scope,async (transaction) => {
      const due=await transaction.query<{ id:string }>(`
        SELECT id
        FROM mbox.complimentary_fulfillment_intents
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND status IN ('pending','retry') AND next_attempt_at<=$3::timestamptz
        ORDER BY next_attempt_at,created_at,id
        LIMIT $4
      `,[transaction.scope.tenantId,transaction.scope.storeId,evaluatedAt,batchSize])
      return due.rows.map((row) => row.id)
    },{ readOnly:true })
    const dispatchedIntentIds:string[]=[]
    const retryIntentIds:string[]=[]
    const failedIntentIds:string[]=[]
    for (const intentId of intentIds) {
      try {
        const dispatched=await this.transactions.run(scope,(transaction) => (
          dispatchIntent(transaction,intentId,evaluatedAt)
        ))
        if (dispatched) dispatchedIntentIds.push(intentId)
      } catch (error) {
        const outcome=await this.transactions.run(scope,(transaction) => (
          recordFailure(transaction,intentId,evaluatedAt,error)
        ))
        if (outcome==='retry') retryIntentIds.push(intentId)
        if (outcome==='failed') failedIntentIds.push(intentId)
      }
    }
    return {
      workerId,evaluatedAt,examined:intentIds.length,
      dispatched:dispatchedIntentIds.length,retrying:retryIntentIds.length,
      failed:failedIntentIds.length,dispatchedIntentIds,retryIntentIds,failedIntentIds,
    }
  }
}

async function dispatchIntent(
  transaction: ScopedTransaction,
  intentId: string,
  evaluatedAt: string,
): Promise<boolean> {
  const locked=await transaction.query<IntentRow>(`
    SELECT id,order_id,benefit_id,attempt_count
    FROM mbox.complimentary_fulfillment_intents
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status IN ('pending','retry') AND next_attempt_at<=$4::timestamptz
    FOR UPDATE SKIP LOCKED
  `,[transaction.scope.tenantId,transaction.scope.storeId,intentId,evaluatedAt])
  const intent=locked.rows[0]
  if (!intent) return false
  const items=await transaction.query<FulfillmentItemRow>(`
    SELECT item.id AS order_item_id,item.fulfillment_station AS station_code,item.quantity,
      item.fulfillment_priority,item.fulfillment_due_at::text
    FROM mbox.order_items AS item
    JOIN mbox.orders AS order_row
      ON order_row.tenant_id=item.tenant_id AND order_row.store_id=item.store_id
     AND order_row.id=item.order_id
    WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid
      AND item.order_id=$3::uuid AND item.fulfillment_station<>'none'
      AND item.status<>'cancelled' AND order_row.fulfillment_state='active'
      AND order_row.payment_status='paid' AND order_row.total_amount_minor=0
    ORDER BY item.created_at,item.id
    FOR KEY SHARE OF item,order_row
  `,[transaction.scope.tenantId,transaction.scope.storeId,intent.order_id])
  if (items.rows.length===0) {
    throw new Error(`Complimentary order has no active physical fulfillment lines: ${intent.order_id}`)
  }
  const tasks:KdsTask[]=[]
  for (const item of items.rows) tasks.push(await getOrCreateTask(transaction,item))
  const updated=await transaction.query(`
    UPDATE mbox.complimentary_fulfillment_intents
    SET status='dispatched',attempt_count=attempt_count+1,dispatched_at=$4::timestamptz,
      last_error_code=NULL,last_error_at=NULL
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status IN ('pending','retry')
  `,[transaction.scope.tenantId,transaction.scope.storeId,intent.id,evaluatedAt])
  if (updated.rowCount!==1) throw new Error(`Complimentary intent lost dispatch transition: ${intent.id}`)
  for (const task of tasks) await appendOutboxMessage(transaction,{
    businessEventKey:`benefit-gift-kds-created:${task.id}`,
    aggregateType:'kds_task',aggregateId:task.id,aggregateVersion:1,
    eventType:'kds.task.created.v1',
    payload:{ taskId:task.id,orderId:intent.order_id,orderItemId:task.orderItemId,
      stationCode:task.stationCode,status:task.status,source:'benefit_gift' },
  })
  const sourceOutboxMessageId=await appendOutboxMessage(transaction,{
    businessEventKey:`benefit-gift-fulfillment-dispatched:${intent.id}`,
    aggregateType:'order',aggregateId:intent.order_id,aggregateVersion:1,
    eventType:'benefit.gift.fulfillment-dispatched.v1',
    payload:{ intentId:intent.id,orderId:intent.order_id,benefitId:intent.benefit_id,
      kdsTaskIds:tasks.map((task) => task.id) },
  })
  await new PrintTicketSourceRepository(transaction)
    .materializeOrderProduction(sourceOutboxMessageId,intent.order_id)
  return true
}

async function getOrCreateTask(
  transaction: ScopedTransaction,
  item: FulfillmentItemRow,
): Promise<KdsTask> {
  const existing=await transaction.query<ExistingTaskRow>(`
    SELECT id,order_item_id,station_code,status,priority,quantity,assigned_employee_id,
      due_at::text,next_action_at::text,accepted_at::text,ready_at::text,cancelled_at::text
    FROM mbox.kds_tasks
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      AND order_item_id=$3::uuid AND station_code=$4
    FOR KEY SHARE
  `,[transaction.scope.tenantId,transaction.scope.storeId,item.order_item_id,item.station_code])
  const row=existing.rows[0]
  if (row) return mapExistingTask(row)
  return new KdsRepository(transaction).create({
    orderItemId:item.order_item_id,stationCode:item.station_code,quantity:Number(item.quantity),
    priority:Number(item.fulfillment_priority),dueAt:item.fulfillment_due_at,
    eventIdempotencyKey:`benefit-fulfillment:${item.order_item_id}:${item.station_code}`,
  })
}

async function recordFailure(
  transaction: ScopedTransaction,
  intentId: string,
  evaluatedAt: string,
  error: unknown,
): Promise<'retry'|'failed'|null> {
  const result=await transaction.query<{ status:'retry'|'failed' }>(`
    UPDATE mbox.complimentary_fulfillment_intents
    SET attempt_count=attempt_count+1,
      status=CASE WHEN attempt_count+1>=10 THEN 'failed' ELSE 'retry' END,
      next_attempt_at=$4::timestamptz
        + make_interval(secs=>LEAST(300,5*power(2,LEAST(attempt_count,6)))::integer),
      last_error_code=$5,last_error_at=$4::timestamptz
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status IN ('pending','retry')
    RETURNING status
  `,[transaction.scope.tenantId,transaction.scope.storeId,intentId,evaluatedAt,safeErrorCode(error)])
  return result.rows[0]?.status ?? null
}

function mapExistingTask(row: ExistingTaskRow): KdsTask {
  return {
    id:row.id,orderItemId:row.order_item_id,stationCode:row.station_code,status:row.status,
    remakeOfTaskId:null,
    priority:Number(row.priority),quantity:Number(row.quantity),
    assignedEmployeeId:row.assigned_employee_id,dueAt:row.due_at,nextActionAt:row.next_action_at,
    acceptedAt:row.accepted_at,readyAt:row.ready_at,cancelledAt:row.cancelled_at,
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Complimentary order has no active physical')) {
    return 'physical_fulfillment_lines_missing'
  }
  if (error instanceof Error && error.message.startsWith('Fulfillment plan is missing')) {
    return 'fulfillment_plan_missing'
  }
  const name=error instanceof Error ? error.name : 'unknown'
  const safeName=name.replaceAll(/[^A-Za-z0-9_.-]/g,'_').slice(0,48) || 'unknown'
  return `kds_dispatch_failed:${safeName}`
}

function validateWorker(workerId:string,batchSize:number):void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,159}$/.test(workerId)) throw new TypeError('workerId is invalid')
  if (!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>500) throw new TypeError('batchSize is invalid')
}
