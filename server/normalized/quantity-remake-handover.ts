import {readPackagedReturnEligibility} from './packaged-return-evidence.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction,StoreScope} from './transaction-runner.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {assertEmployeeEffectivePermission} from './employee-table-access.js'
import {NormalizedCommandExecutor,type JsonCodec} from './command-executor.js'
import {QuantityRemakeRepository} from './quantity-remake-repository.js'
import {lockQuantityOrder} from './item-quantity-lock.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** Closed-visit physical work without a refund case. A held share remains in its
 * existing after-sales queue so two workspaces never dispose the same selection. */
export class QuantityRemakeHandoverQuery {
  constructor(private readonly transactions:ScopedPostgresTransactionRunner){}
  list(input:{scope:Readonly<StoreScope>;employeeId:string;cursor?:{id:string;createdAt:string};limit?:number}){
    const limit=input.limit??25
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError('每页数量须为1至100')
    if(input.cursor&&(!Number.isFinite(Date.parse(input.cursor.createdAt))||!/^[0-9a-f-]{36}$/i.test(input.cursor.id)))throw new TypeError('交接分页位置无效')
    return this.transactions.run(input.scope,async tx=>{
      const access=await new StaffAccessRepository(tx).resolve(input.employeeId),permissions=access.permissions
      if(!permissions.includes('refund.request'))throw new StaffAccessDeniedError('当前员工没有商品处理权限')
      const canReceive=permissions.includes('inventory.receive'),canRecordUsed=permissions.includes('inventory.waste')
      if(!canReceive&&!canRecordUsed)return {items:[],nextCursor:null}
      const rows=(await tx.query<{batchId:string;itemId:string;taskId:string;createdAt:string;tableCode:string;productName:string;orderPublicId:string;pendingQuantity:number;unitIds:string[]}>(`SELECT batch.id AS "batchId",batch.order_item_id AS "itemId",batch.kds_task_id AS "taskId",batch.created_at::text AS "createdAt",
        venue.code AS "tableCode",COALESCE(item.product_snapshot->>'name','原商品') AS "productName",original.public_id AS "orderPublicId",count(*)::integer AS "pendingQuantity",array_agg(part.id ORDER BY unit.unit_index) AS "unitIds"
        FROM mbox.quantity_remake_batches batch JOIN mbox.quantity_remake_units part ON part.tenant_id=batch.tenant_id AND part.store_id=batch.store_id AND part.batch_id=batch.id
        JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=part.tenant_id AND unit.store_id=part.store_id AND unit.id=part.unit_id
        JOIN mbox.order_items item ON item.tenant_id=batch.tenant_id AND item.store_id=batch.store_id AND item.id=batch.order_item_id
        JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
        JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
        JOIN mbox.tables venue ON venue.tenant_id=visit.tenant_id AND venue.store_id=visit.store_id AND venue.id=visit.table_id
        WHERE batch.tenant_id=$1 AND batch.store_id=$2 AND (visit.status='closed' OR original.status='cancelled')
          AND part.cancelled_at IS NULL AND part.production_state IN ('started','ready') AND unit.held_by_case_id IS NULL
          AND ($3::timestamptz IS NULL OR (batch.created_at,batch.id)>($3::timestamptz,$4::uuid))
        GROUP BY batch.id,item.id,original.id,venue.code ORDER BY batch.created_at,batch.id LIMIT $5`,[input.scope.tenantId,input.scope.storeId,input.cursor?.createdAt??null,input.cursor?.id??null,limit+1])).rows
      const page=rows.slice(0,limit),last=page.at(-1)
      const eligibility=await readPackagedReturnEligibility(tx,page.flatMap(row=>row.unitIds),true)
      return {items:page.map(row=>({...row,canReceive,canRecordUsed,returnEligibility:Object.fromEntries(row.unitIds.map(id=>[id,eligibility.get(id)!]))})),nextCursor:rows.length>limit&&last?{id:last.batchId,createdAt:last.createdAt}:null}
    },{isolation:'repeatable-read',readOnly:true})
  }
}

type Result={batchId:string;itemId:string;remainingQuantity:number}
const codec:JsonCodec<Result>={encode:value=>value,decode:value=>{
  if(!value||typeof value!=='object'||!('batchId' in value)||typeof value.batchId!=='string'||!('remainingQuantity' in value)||typeof value.remainingQuantity!=='number')throw new Error('Stored remake disposition result is invalid')
  return value as Result
}}
export class QuantityRemakeHandoverCommand {
  constructor(private readonly commands:NormalizedCommandExecutor){}
  dispose(input:{scope:Readonly<StoreScope>;employeeId:string;businessDate:string;idempotencyKey:string;batchId:string;unitIds:readonly string[];reason:string;disposition:'used_loss'|'returned_unopened';unopenedReceived:boolean}){
    const unitIds=[...input.unitIds].sort()
    if(!unitIds.length||unitIds.length>999||new Set(unitIds).size!==unitIds.length)throw new ItemQuantityConflict('QUANTITY_INVALID','请选择本批实际处理份数')
    return this.commands.execute({scope:input.scope,operationScope:'quantity.remake.handover',idempotencyKey:input.idempotencyKey,
      requestFingerprint:JSON.stringify({batchId:input.batchId,unitIds,employeeId:input.employeeId,reason:input.reason.trim(),disposition:input.disposition,unopenedReceived:input.unopenedReceived}),resultCodec:codec},async tx=>{
      await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.request')
      await assertEmployeeEffectivePermission(tx,input.employeeId,input.disposition==='returned_unopened'?'inventory.receive':'inventory.waste')
      const repository=new QuantityRemakeRepository(tx),target=await repository.read(input.batchId)
      await lockQuantityOrder(tx,{kind:'item',id:target.itemId})
      await requireEndedVisit(tx,target.itemId)
      const current=await repository.read(input.batchId),selected=current.units.filter(unit=>unitIds.includes(unit.id))
      if(selected.length!==unitIds.length||selected.some(unit=>unit.held||unit.cancelled_at||!['started','ready'].includes(unit.production_state)))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','所选实物已处理或已进入原售后申请，请读取对应记录')
      await repository.disposeMade({...input,unitIds})
      const after=await repository.read(input.batchId),result={batchId:input.batchId,itemId:target.itemId,remainingQuantity:after.units.filter(unit=>!unit.cancelled_at&&!unit.held&&['started','ready'].includes(unit.production_state)).length}
      return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:input.employeeId},action:'quantity_remake.after_visit_disposition',objectType:'kds_task',objectId:target.taskId,businessDate:input.businessDate,reason:input.reason.trim(),metadata:{batchId:input.batchId,unitIds,disposition:input.disposition,unopenedReceived:input.unopenedReceived}}],outboxMessages:[{aggregateType:'kds_task',aggregateId:target.taskId,aggregateVersion:after.units.filter(unit=>!!unit.cancelled_at).length,eventType:'kds.remake.disposition.v1',payload:result}]}
    })
  }
}
async function requireEndedVisit(tx:ScopedTransaction,itemId:string){
  const ended=(await tx.query<{ended:boolean}>(`SELECT visit.status='closed' OR original.status='cancelled' AS ended FROM mbox.order_items item
    JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
    JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
    WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3`,[tx.scope.tenantId,tx.scope.storeId,itemId])).rows[0]?.ended
  if(!ended)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','在桌商品请从原商品或制作任务处理，不能走离店交接')
}
