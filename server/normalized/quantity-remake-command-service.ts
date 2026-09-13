import {randomUUID} from 'node:crypto'
import {appendOutboxMessage,type JsonCodec,type NormalizedCommandExecutor} from './command-executor.js'
import type {CommerceKdsRequestContext} from './commerce-kds-api.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {NormalizedKdsAuthorization} from './kds-authorization-policy.js'
import {lockQuantityTaskOrders} from './quantity-task-lock.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {QuantityRemakeRepository} from './quantity-remake-repository.js'

type Result={batchId:string;taskId:string;itemId:string;quantity:number}
const codec:JsonCodec<Result>={encode:value=>value,decode:value=>{
  if(!value||typeof value!=='object'||!('batchId' in value)||typeof value.batchId!=='string'||!('quantity' in value)||typeof value.quantity!=='number')throw new Error('Stored remake result is invalid')
  return value as Result
}}
/** An explicit source task identifies the physical generation. The same command
 * recovers its committed result even if new quantity work is later disabled. */
export class QuantityRemakeCommandService {
  constructor(private readonly commands:Pick<NormalizedCommandExecutor,'execute'>,private readonly enabled:boolean){}
  create(input:CommerceKdsRequestContext&{taskId:string;quantity:number;originalGoodsLost:boolean;reason:string;idempotencyKey:string}){
    return this.commands.execute({scope:input.scope,operationScope:'quantity.remake.create',idempotencyKey:input.idempotencyKey,
      requestFingerprint:JSON.stringify({taskId:input.taskId,quantity:input.quantity,originalGoodsLost:input.originalGoodsLost,reason:input.reason.trim(),employeeId:input.employeeId}),resultCodec:codec},async tx=>{
      if(!this.enabled)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','暂不新增数量重做批次，已有操作可恢复原结果')
      await lockQuantityTaskOrders(tx,[input.taskId])
      const target=(await tx.query<{order_item_id:string;station_code:string;table_id:string;remake_of_task_id:string|null;quantity_remake_batch_id:string|null;status:string}>(`SELECT task.order_item_id,task.station_code,visit.table_id,task.remake_of_task_id,task.quantity_remake_batch_id,task.status
        FROM mbox.kds_tasks task JOIN mbox.order_items item ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
        JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
        JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
        WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=$3 FOR UPDATE OF task`,[tx.scope.tenantId,tx.scope.storeId,input.taskId])).rows[0]
      if(!target)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原制作任务不存在，请读回商品')
      // Same station and device as production, plus the existing exception
      // capability. This physical-only batch never cancels the original sale,
      // refunds money or grants the broader manager/table exception authority.
      await new NormalizedKdsAuthorization().assertCanActOnTask({transaction:tx,...input,action:'quantity_remake',stationCode:target.station_code,tableId:target.table_id})
      if(target.remake_of_task_id&&!target.quantity_remake_batch_id)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','旧整单重做请继续原处理记录，不能猜测其逐份材料')
      // The existing failed-task workflow owns its exception and inventory
      // reconciliation. Quantity admission must not silently resolve that case.
      if(target.status==='failed')throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','制作失败异常请先核对原异常的材料记录，再处理实际份数')
      const batch=await new QuantityRemakeRepository(tx).create({itemId:target.order_item_id,employeeId:input.employeeId,quantity:input.quantity,originalGoodsLost:input.originalGoodsLost,
        reason:input.reason,eventKey:input.idempotencyKey,previousBatchId:target.quantity_remake_batch_id??undefined})
      const result={batchId:batch.id,taskId:batch.taskId,itemId:batch.itemId,quantity:batch.units.length}
      await recordRemakeNotice(tx,{...input,...result,stationCode:target.station_code})
      return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:input.employeeId},action:'quantity_remake.created',objectType:'kds_task',objectId:batch.taskId,businessDate:input.businessDate,reason:input.reason,
        metadata:{sourceTaskId:input.taskId,previousBatchId:target.quantity_remake_batch_id,remakeBatchId:batch.id,originalGoodsLost:true,quantity:batch.units.length,originalUnitIds:batch.units.map(unit=>unit.unit_id),newPhysicalUnitIds:batch.units.map(unit=>unit.id)}}],
        outboxMessages:[{aggregateType:'kds_task',aggregateId:batch.taskId,aggregateVersion:1,eventType:'kds.quantity_remake.created.v1',payload:result}]}
    })
  }
}
async function recordRemakeNotice(tx:ScopedTransaction,input:Result&{employeeId:string;stationCode:string;reason:string}){
  const context=(await tx.query<{table_code:string;guest_count:number;public_id:string;business_date:string;issued_at:string;name:string;category_code:string|null;operator_name:string}>(`SELECT venue.code AS table_code,visit.guest_count,original.public_id,
    mbox.current_operating_business_date($1,$2)::text AS business_date,clock_timestamp()::text AS issued_at,COALESCE(item.product_snapshot->>'name','原商品') AS name,
    COALESCE(item.product_snapshot->>'categoryCode',item.product_snapshot->>'category_code') AS category_code,employee.display_name AS operator_name
    FROM mbox.order_items item JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
    JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
    JOIN mbox.tables venue ON venue.tenant_id=visit.tenant_id AND venue.store_id=visit.store_id AND venue.id=visit.table_id
    JOIN mbox.employees employee ON employee.tenant_id=item.tenant_id AND employee.store_id=item.store_id AND employee.id=$4
    WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3`,[tx.scope.tenantId,tx.scope.storeId,input.itemId,input.employeeId])).rows[0]!
  const eventId=randomUUID(),source=await appendOutboxMessage(tx,{eventId,aggregateType:'item_after_sales_notice',aggregateId:eventId,aggregateVersion:1,eventType:'item.after_sales.production_notice.v1',occurredAt:context.issued_at,
    payload:{remakeBatchId:input.batchId,stationCode:input.stationCode,categoryCode:context.category_code,ticket:{schemaVersion:1,kind:'production_notice',title:'重做通知',subtitle:'仅制作本批数量 · 原单金额不变',test:false,
      issuedAt:context.issued_at,businessDate:context.business_date,ticketReference:context.public_id,tableCode:context.table_code,guestCount:context.guest_count,operatorLabel:context.operator_name,
      lines:[{name:`重做：${context.name}`.slice(0,120),quantity:input.quantity,unitAmountMinor:null,totalAmountMinor:null,note:`本批 ${input.batchId}；按原商品规格制作。`}],payment:null,totalAmountMinor:null,currency:'CNY',note:input.reason.slice(0,300)}}})
  await tx.query("INSERT INTO mbox.print_source_jobs(tenant_id,store_id,source_outbox_message_id,aggregate_id,ticket_kind) VALUES($1,$2,$3,$4,'production_notice')",[tx.scope.tenantId,tx.scope.storeId,source,eventId])
}
