import {randomUUID} from 'node:crypto'
import {MAX_PICKUP_TASKS} from '../../src/shared/pickup-workflow.js'
import type {PickupBoardData,PickupCommand,PickupCommandResult,PickupDeviceCommand,PickupReceipt,PickupRecoveryCommand} from '../../src/shared/pickup-workflow.js'
import type {CommerceKdsRequestContext} from './commerce-kds-api.js'
import type {CommandOutcome,JsonObject,JsonValue} from './command-executor.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {lockQuantityTaskOrders} from './quantity-task-lock.js'
import {synchronizeQuantityItem,synchronizePickupUndoItem} from './item-quantity-projection.js'
import {PickupWorkflowError,readPhysicalPickupUnits,readPickupAccess,readPickupBoard,readPickupReceipt,requirePickupDevice,pickupCommandScope,type PickupAccess} from './pickup-workflow-query.js'

const scopeOf=(tx:ScopedTransaction)=>[tx.scope.tenantId,tx.scope.storeId]
const changed=(message='出品刚有变化，请核对最新待取数量',code='PICKUP_STALE'):never=>{throw new PickupWorkflowError(code,message)}
async function previous<T>(tx:ScopedTransaction,scope:string,key:string,body:unknown):Promise<T|null>{
  const row=(await tx.query<{same:boolean;result:T}>(`SELECT request_body=$5::jsonb AS same,result FROM mbox.pickup_command_receipts WHERE tenant_id=$1 AND store_id=$2 AND command_scope=$3 AND operation_key=$4`,[...scopeOf(tx),scope,key,JSON.stringify(body)])).rows[0]
  if(!row)return null;if(!row.same)changed('这张操作凭据已经用于另一项操作，请保留原记录','IDEMPOTENCY_CONFLICT');return row.result
}
async function persist(tx:ScopedTransaction,scope:string,key:string,body:unknown,result:unknown){
  await tx.query('INSERT INTO mbox.pickup_command_receipts(tenant_id,store_id,command_scope,operation_key,request_body,result) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',[...scopeOf(tx),scope,key,JSON.stringify(body),JSON.stringify(result)])
}
export async function executePickupCommand(tx:ScopedTransaction,context:CommerceKdsRequestContext,command:PickupCommand,key:string,requestId:string,_enabled:boolean,recovery?:PickupRecoveryCommand):Promise<CommandOutcome<PickupCommandResult>>{
  const access=await readPickupAccess(tx,context,true),device=requirePickupDevice(access)
  const commandScope=recovery?await authorizePickupRecovery(tx,context,recovery):access.commandScope
  const old=await previous<PickupCommandResult>(tx,commandScope,key,command)
  if(old)return {result:{...old,replayed:true},auditEvents:[],outboxMessages:[]}
  let receipt:PickupReceipt
  if(command.action==='take'){
    // Feature admission can pause; an already trusted device must still hand off ready goods.
    // Purpose revocation is enforced above, independently of this rollout switch.
    // Lookup only identifies parent locks; all facts are re-read after locking.
    let physical=await readPhysicalPickupUnits(tx,{units:command.units})
    const keys=new Set(command.units.map(unit=>`${unit.kind}:${unit.unitId}`))
    let selected=physical.filter(part=>keys.has(`${part.unit.kind}:${part.unit.unitId}`))
    if(selected.length!==keys.size)changed()
    if(new Set(selected.map(part=>part.unit.taskId)).size>MAX_PICKUP_TASKS)throw new PickupWorkflowError('PICKUP_INVALID','这桌品项较多，每次最多取50项，请分批选择',400)
    await lockQuantityTaskOrders(tx,[...new Set(selected.map(part=>part.unit.taskId))])
    physical=await readPhysicalPickupUnits(tx,{units:command.units});selected=physical.filter(part=>keys.has(`${part.unit.kind}:${part.unit.unitId}`))
    if(selected.length!==keys.size)changed()
    for(const part of selected){
      const expected=command.units.find(unit=>unit.kind===part.unit.kind&&unit.unitId===part.unit.unitId)!
      if(part.unit.tableId!==command.tableId||part.unit.tableSessionId!==command.tableSessionId||part.unit.locationVersion!==command.locationVersion)changed('订单已转桌，请核对新桌号再取','PICKUP_TABLE_MOVED')
      if(!part.available||part.state!=='ready'||part.currentReceiptId||part.unit.version!==expected.version)changed()
    }
    const id=randomUUID(),takenAt=await databaseTime(tx)
    receipt={receiptId:id,revision:1,tableId:command.tableId,tableCode:selected[0]!.unit.tableCode,tableSessionId:command.tableSessionId,takenAt,
      deliveryConfirmedAt:takenAt,deliverySource:'pickup',source:{kind:'shared_pickup_device',deviceId:device.id,label:device.label},pickerEmployeeId:null,
      units:selected.map(part=>part.unit),quantity:selected.length,undo:null,canUndo:true,undoBlockedReason:null}
    await tx.query(`INSERT INTO mbox.pickup_receipts(id,tenant_id,store_id,table_session_id,table_id,location_version,device_id,authorized_employee_id,staff_session_id,device_access_lease_id,business_date,taken_at,snapshot)
      VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,[...scopeOf(tx),id,command.tableSessionId,command.tableId,command.locationVersion,device.id,context.employeeId,context.staffSessionId,context.deviceAccessLeaseId,context.businessDate,takenAt,JSON.stringify(receipt)])
    for(const {unit} of selected){
      await tx.query(`INSERT INTO mbox.pickup_receipt_parts(tenant_id,store_id,receipt_id,unit_id,remake_unit_id,original_unit_id,kds_task_id,expected_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[...scopeOf(tx),id,unit.kind==='original'?unit.unitId:null,unit.kind==='remake'?unit.unitId:null,unit.originalUnitId,unit.taskId,unit.version])
      const table=unit.kind==='original'?'order_item_quantity_units':'quantity_remake_units'
      const updated=await tx.query(`UPDATE mbox.${table} SET production_state='delivered',current_pickup_receipt_id=$4,fulfillment_revision=fulfillment_revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND production_state='ready' AND fulfillment_revision=$5 AND current_pickup_receipt_id IS NULL`,[...scopeOf(tx),unit.unitId,id,unit.version])
      if(updated.rowCount!==1)changed()
    }
    for(const itemId of new Set(selected.map(part=>part.unit.itemId)))await synchronizeQuantityItem(tx,itemId)
  }else{
    const initial=await readPickupReceipt(tx,command.receiptId)
    if(!initial)throw new PickupWorkflowError('PICKUP_RECEIPT_NOT_FOUND','未找到这次领取记录',404)
    await lockQuantityTaskOrders(tx,[...new Set(initial.units.map(unit=>unit.taskId))])
    // Receipt facts are immutable and runtime deliberately has no UPDATE grant.
    // The sorted parent order locks serialize every mutation of these same physical portions.
    const current=await readPickupReceipt(tx,command.receiptId)
    if(!current?.canUndo||current.revision!==command.expectedRevision)changed(current?.undoBlockedReason??'这次领取已有后续变化，不能撤回','PICKUP_UNDO_UNAVAILABLE')
    const undoId=randomUUID(),undoneAt=await databaseTime(tx)
    await tx.query(`INSERT INTO mbox.pickup_undos(id,tenant_id,store_id,receipt_id,device_id,authorized_employee_id,staff_session_id,device_access_lease_id,undone_at,physical_still_at_pickup_point)
      VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,true)`,[...scopeOf(tx),undoId,current!.receiptId,device.id,context.employeeId,context.staffSessionId,context.deviceAccessLeaseId,undoneAt])
    for(const unit of current!.units){const table=unit.kind==='original'?'order_item_quantity_units':'quantity_remake_units'
      const updated=await tx.query(`UPDATE mbox.${table} SET production_state='ready',current_pickup_receipt_id=NULL,fulfillment_revision=fulfillment_revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND production_state='delivered' AND current_pickup_receipt_id=$4 AND fulfillment_revision=$5`,[...scopeOf(tx),unit.unitId,current!.receiptId,unit.version+1])
      if(updated.rowCount!==1)changed('原领取已有后续变化，本次没有撤回任何出品','PICKUP_UNDO_UNAVAILABLE')
    }
    for(const itemId of new Set(current!.units.map(unit=>unit.itemId)))await synchronizePickupUndoItem(tx,itemId,current!.receiptId)
    receipt={...current!,revision:2,undo:{undoId,undoneAt},canUndo:false,undoBlockedReason:'这次领取已撤回'}
  }
  const revision=Number((await tx.query<{value:string}>('SELECT floor(extract(epoch FROM transaction_timestamp())*1000000)::bigint::text AS value')).rows[0]!.value)
  const result:PickupCommandResult={receipt,revision,replayed:false}
  await persist(tx,commandScope,key,command,result)
  return {result,auditEvents:[{actor:{type:'employee',employeeId:context.employeeId},action:`fulfillment.pickup.${command.action}`,objectType:'pickup_receipt',objectId:receipt.receiptId,businessDate:context.businessDate,requestId,
    afterData:{receipt:receipt as unknown as JsonValue,operatorKind:'shared_pickup_device',pickerEmployeeId:null},metadata:{deviceId:device.id,staffSessionId:context.staffSessionId,deviceAccessLeaseId:context.deviceAccessLeaseId}}],
    outboxMessages:[{businessEventKey:`pickup:${receipt.receiptId}:${receipt.revision}`,aggregateType:'pickup_receipt',aggregateId:receipt.receiptId,aggregateVersion:receipt.revision,eventType:`fulfillment.pickup.${command.action==='take'?'taken':'undone'}.v1`,payload:{receipt:receipt as unknown as JsonValue},occurredAt:receipt.undo?.undoneAt??receipt.takenAt}]}
}
export async function configurePickupDevice(tx:ScopedTransaction,context:CommerceKdsRequestContext,command:PickupDeviceCommand,key:string,requestId:string,enabled:boolean,recovery?:PickupRecoveryCommand):Promise<CommandOutcome<PickupBoardData>>{
  // Lock the lease before the purpose row; the opaque command scope remains stable across configuration.
  const access=await readPickupAccess(tx,context,'configure')
  if(!access.canConfigure)throw new PickupWorkflowError('PICKUP_FORBIDDEN','请由设备管理员设置取餐屏',403)
  const originalScope=recovery?await authorizePickupRecovery(tx,context,recovery):access.commandScope
  const commandScope=`device:${originalScope}`,old=await previous<PickupBoardData>(tx,commandScope,key,command)
  if(old)return {result:old,auditEvents:[],outboxMessages:[]}
  if(!enabled&&command.enabled)changed('新设备设置已暂停；现有取餐屏仍可取餐和撤回','PICKUP_ADMISSION_PAUSED')
  const device=(await tx.query<{id:string}>(`INSERT INTO mbox.pickup_devices(tenant_id,store_id,device_key_hash,label,enabled,configured_by_employee_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,store_id,device_key_hash) DO UPDATE SET enabled=EXCLUDED.enabled,label=CASE WHEN $7 THEN EXCLUDED.label ELSE mbox.pickup_devices.label END,configured_by_employee_id=EXCLUDED.configured_by_employee_id,updated_at=clock_timestamp() RETURNING id`,[...scopeOf(tx),access.deviceKeyHash,command.label??'吧台取餐屏',command.enabled,context.employeeId,command.label!==undefined])).rows[0]!
  const result=await readPickupBoard(tx,context,enabled)
  await persist(tx,commandScope,key,command,result)
  return {result,auditEvents:[{actor:{type:'employee',employeeId:context.employeeId},action:'fulfillment.pickup.device.configure',objectType:'pickup_device',objectId:device.id,businessDate:context.businessDate,requestId,afterData:command as unknown as JsonObject}],outboxMessages:[]}
}
export async function authorizePickup(tx:ScopedTransaction,context:CommerceKdsRequestContext,configure=false):Promise<PickupAccess>{
  const access=await readPickupAccess(tx,context,configure?'configure':true)
  if(configure){if(!access.canConfigure)throw new PickupWorkflowError('PICKUP_FORBIDDEN','请由设备管理员设置取餐屏',403)}else requirePickupDevice(access)
  return access
}
/** Explicit recovery proves the previous authorization boundary belongs to this real device. */
export async function authorizePickupRecovery(tx:ScopedTransaction,context:CommerceKdsRequestContext,recovery:PickupRecoveryCommand){
  const access=await authorizePickup(tx,context,recovery.request.kind==='device')
  const old=(await tx.query<{employee_id:string;device_key_hash:string}>(`SELECT session.employee_id,lease.device_key_hash FROM mbox.staff_sessions session
    JOIN mbox.store_device_access_leases lease ON (lease.tenant_id,lease.store_id,lease.id)=(session.tenant_id,session.store_id,session.device_access_lease_id)
    WHERE session.tenant_id=$1 AND session.store_id=$2 AND session.id=$3`,[...scopeOf(tx),recovery.staffSessionId])).rows[0]
  if(!old||old.device_key_hash!==access.deviceKeyHash||pickupCommandScope({...context,employeeId:old.employee_id,staffSessionId:recovery.staffSessionId},old.device_key_hash)!==recovery.commandScope)
    throw new PickupWorkflowError('PICKUP_FORBIDDEN','这不是本设备的原操作，请回原取餐屏核对',403)
  return recovery.commandScope
}
async function databaseTime(tx:ScopedTransaction){return new Date((await tx.query<{at:string}>('SELECT clock_timestamp()::text AS at')).rows[0]!.at).toISOString()}
