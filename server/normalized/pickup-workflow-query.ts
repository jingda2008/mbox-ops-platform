import {createHash} from 'node:crypto'
import type {PickupBoardData,PickupDevice,PickupReceipt,PickupUnit} from '../../src/shared/pickup-workflow.js'
import type {CommerceKdsRequestContext} from './commerce-kds-api.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {hasActiveKdsSession} from './kds-authorization-policy.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {lockQuantityTaskOrders} from './quantity-task-lock.js'

export class PickupWorkflowError extends Error {
  constructor(public readonly code:string,message:string,public readonly statusCode=409){super(message);this.name='PickupWorkflowError'}
}
export interface PickupAccess {commandScope:string;device:PickupDevice|null;deviceKeyHash:string;canConfigure:boolean;canDeliver:boolean;actionSessionValid:boolean}
export function pickupCommandScope(context:Pick<CommerceKdsRequestContext,'scope'|'employeeId'|'staffSessionId'>,deviceKeyHash:string){
  return createHash('sha256').update(JSON.stringify([context.scope.tenantId,context.scope.storeId,context.employeeId,context.staffSessionId,deviceKeyHash])).digest('hex')
}
export async function readPickupAccess(tx:ScopedTransaction,context:CommerceKdsRequestContext,lock:boolean|'configure'=false):Promise<PickupAccess>{
  const access=await new StaffAccessRepository(tx).resolve(context.employeeId).catch(error=>{
    if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError)throw new PickupWorkflowError('PICKUP_FORBIDDEN','当前员工已停用或没有访问权限',403)
    throw error
  })
  const valid=await hasActiveKdsSession({transaction:tx,...context},lock!==false)
  if(!valid)throw new PickupWorkflowError('PICKUP_SESSION_INVALID','登录已过期，请重新登录后核对原操作',403)
  const lease=(await tx.query<{device_key_hash:string}>(`SELECT device_key_hash FROM mbox.store_device_access_leases WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[tx.scope.tenantId,tx.scope.storeId,context.deviceAccessLeaseId])).rows[0]!
  const row=(await tx.query<{id:string;label:string;enabled:boolean}>(`SELECT id,label,enabled FROM mbox.pickup_devices WHERE tenant_id=$1 AND store_id=$2 AND device_key_hash=$3 ${lock==='configure'?'FOR UPDATE':lock?'FOR SHARE':''}`,[tx.scope.tenantId,tx.scope.storeId,lease.device_key_hash])).rows[0]
  // Configuration does not change this scope; a lost setup acknowledgement can be recovered.
  const commandScope=pickupCommandScope(context,lease.device_key_hash)
  return {commandScope,device:row?.enabled?{id:row.id,label:row.label,mode:'shared_pickup'}:null,deviceKeyHash:lease.device_key_hash,
    canConfigure:access.permissions.includes('staff.access.configure'),canDeliver:access.permissions.includes('kds.deliver'),actionSessionValid:true}
}
export function requirePickupDevice(access:PickupAccess){
  if(!access.canDeliver)throw new PickupWorkflowError('PICKUP_FORBIDDEN','当前登录没有取餐权限',403)
  if(!access.device)throw new PickupWorkflowError('PICKUP_DEVICE_REQUIRED','请由管理员将这台设备设为共用取餐屏',403)
  return access.device
}
export interface PhysicalPickupRow {unit:PickupUnit;state:string;currentReceiptId:string|null;available:boolean;currentPhysical:boolean;pickupBusinessDate:string|null;takenAt:string|null}
export async function readPhysicalPickupUnits(tx:ScopedTransaction,options:{includeTakenBusinessDate?:string;station?:'bar'|'kitchen';units?:ReadonlyArray<Pick<PickupUnit,'kind'|'unitId'>>}={}):Promise<PhysicalPickupRow[]>{
  const rows=await tx.query<{value:PhysicalPickupRow}>(`WITH eligible_items AS MATERIALIZED (
    SELECT item.id FROM mbox.table_sessions visit
    JOIN LATERAL (SELECT original.id,original.status FROM mbox.orders original
      WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.table_session_id=visit.id OFFSET 0) original ON true
    JOIN LATERAL (SELECT item.id FROM mbox.order_items item
      WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.order_id=original.id OFFSET 0) item ON true
    WHERE visit.tenant_id=$1 AND visit.store_id=$2 AND (visit.status IN ('open','closing') AND original.status<>'cancelled'
      OR $3::date IS NOT NULL AND EXISTS(SELECT 1 FROM mbox.pickup_receipts receipt
        WHERE receipt.tenant_id=$1 AND receipt.store_id=$2 AND receipt.table_session_id=visit.id AND receipt.business_date=$3::date))
  ), physical AS MATERIALIZED (
    SELECT 'original'::text AS kind,unit.id,unit.id AS root_id,unit.order_item_id,unit.production_state,unit.current_pickup_receipt_id,unit.fulfillment_revision,
      task.id AS task_id,task.station_code,task.ready_at
    FROM mbox.order_item_quantity_units unit JOIN mbox.kds_tasks task
      ON (task.tenant_id,task.store_id,task.order_item_id)=(unit.tenant_id,unit.store_id,unit.order_item_id) AND task.remake_of_task_id IS NULL
    WHERE unit.tenant_id=$1 AND unit.store_id=$2 AND task.station_code IN ('bar','kitchen') AND unit.production_state IN ('ready','delivered')
      AND ($4::text IS NULL OR task.station_code=$4) AND ($5::uuid[] IS NULL OR unit.id=ANY($5::uuid[])) AND unit.order_item_id IN (SELECT id FROM eligible_items)
    UNION ALL
    SELECT 'remake',part.id,part.unit_id,batch.order_item_id,part.production_state,part.current_pickup_receipt_id,part.fulfillment_revision,task.id,task.station_code,task.ready_at
    FROM mbox.quantity_remake_units part JOIN mbox.quantity_remake_batches batch ON (batch.tenant_id,batch.store_id,batch.id)=(part.tenant_id,part.store_id,part.batch_id)
    JOIN mbox.kds_tasks task ON (task.tenant_id,task.store_id,task.id)=(batch.tenant_id,batch.store_id,batch.kds_task_id)
    WHERE part.tenant_id=$1 AND part.store_id=$2 AND task.station_code IN ('bar','kitchen') AND part.production_state IN ('ready','delivered')
      AND ($4::text IS NULL OR task.station_code=$4) AND ($6::uuid[] IS NULL OR part.id=ANY($6::uuid[])) AND batch.order_item_id IN (SELECT id FROM eligible_items)
  ) SELECT jsonb_build_object('unit',jsonb_build_object('kind',physical.kind,'unitId',physical.id,'originalUnitId',physical.root_id,
    'taskId',physical.task_id,'itemId',item.id,'orderId',original.id,'version',physical.fulfillment_revision,
    'tableId',venue.id,'tableCode',venue.code,'tableSessionId',visit.id,'locationVersion',visit.location_version,
    'productName',COALESCE(item.product_snapshot->>'name',product.name),'specification',COALESCE(NULLIF(item.product_snapshot->>'specification',''),item.product_snapshot->'source'->>'specification',''),
    'itemNote',COALESCE(item.note,''),'orderNote',COALESCE(original.note,''),'station',physical.station_code,
    'pickupLocation',CASE physical.station_code WHEN 'bar' THEN '酒水吧台' ELSE '后厨取餐口' END,'readyAt',COALESCE(ready_event.ready_at,physical.ready_at)),
    'state',physical.production_state,'currentReceiptId',physical.current_pickup_receipt_id,'pickupBusinessDate',pickup.business_date,'takenAt',pickup.taken_at,
    'currentPhysical',CASE WHEN physical.kind='original' THEN NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units newer WHERE newer.tenant_id=$1 AND newer.store_id=$2 AND newer.unit_id=physical.root_id)
      ELSE NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units newer JOIN mbox.quantity_remake_units current_part ON (current_part.tenant_id,current_part.store_id,current_part.unit_id)=(newer.tenant_id,newer.store_id,newer.unit_id)
        WHERE current_part.tenant_id=$1 AND current_part.store_id=$2 AND current_part.id=physical.id AND newer.generation>current_part.generation) END,
    'available',mbox.pickup_physical_available($1,$2,physical.kind,physical.id)) AS value
  FROM physical
  -- RLS estimates can otherwise reorder these one-row lookups into a repeated cross join.
  JOIN LATERAL (SELECT item.* FROM mbox.order_items item WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=physical.order_item_id OFFSET 0) item ON true
  JOIN LATERAL (SELECT original.* FROM mbox.orders original WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.id=item.order_id OFFSET 0) original ON true
  JOIN LATERAL (SELECT visit.* FROM mbox.table_sessions visit WHERE visit.tenant_id=$1 AND visit.store_id=$2 AND visit.id=original.table_session_id OFFSET 0) visit ON true
  JOIN LATERAL (SELECT venue.* FROM mbox.tables venue WHERE venue.tenant_id=$1 AND venue.store_id=$2 AND venue.id=visit.table_id OFFSET 0) venue ON true
  JOIN LATERAL (SELECT product.* FROM mbox.products product WHERE product.tenant_id=$1 AND product.store_id=$2 AND product.id=item.product_id OFFSET 0) product ON true
  LEFT JOIN mbox.pickup_receipts pickup ON pickup.tenant_id=$1 AND pickup.store_id=$2 AND pickup.id=physical.current_pickup_receipt_id
  LEFT JOIN LATERAL (SELECT min(event.occurred_at) AS ready_at FROM mbox.kds_task_events event
    WHERE event.tenant_id=$1 AND event.store_id=$2 AND event.kds_task_id=physical.task_id
      AND (physical.kind='original' AND event.event_type='quantity.ready' AND event.metadata->'unitIds' ? physical.id::text
        OR physical.kind='remake' AND event.event_type='task.remake_complete' AND event.metadata->'remakeUnitIds' ? physical.id::text)) ready_event ON true
  WHERE (visit.status IN ('open','closing') AND original.status<>'cancelled' OR pickup.business_date=$3::date)
    AND ($4::text IS NULL OR physical.station_code=$4)
  ORDER BY physical.ready_at NULLS LAST,original.created_at,physical.kind,physical.id`,[tx.scope.tenantId,tx.scope.storeId,options.includeTakenBusinessDate??null,options.station??null,options.units?.filter(unit=>unit.kind==='original').map(unit=>unit.unitId)??null,options.units?.filter(unit=>unit.kind==='remake').map(unit=>unit.unitId)??null])
  return rows.rows.map(({value})=>({...value,takenAt:isoOrNull(value.takenAt),unit:{...value.unit,readyAt:isoOrNull(value.unit.readyAt)}}))
}
interface ReceiptRow extends Record<string,unknown>{snapshot:PickupReceipt;undo_id:string|null;undone_at:string|null}
export async function readPickupReceipt(tx:ScopedTransaction,id:string,physical?:PhysicalPickupRow[]):Promise<PickupReceipt|null>{
  const row=(await tx.query<ReceiptRow>(`SELECT receipt.snapshot,undo.id AS undo_id,undo.undone_at::text
    FROM mbox.pickup_receipts receipt LEFT JOIN mbox.pickup_undos undo ON (undo.tenant_id,undo.store_id,undo.receipt_id)=(receipt.tenant_id,receipt.store_id,receipt.id)
    WHERE receipt.tenant_id=$1 AND receipt.store_id=$2 AND receipt.id=$3`,[tx.scope.tenantId,tx.scope.storeId,id])).rows[0]
  if(!row)return null
  return projectReceipt(row,physical??await readPhysicalPickupUnits(tx,{units:row.snapshot.units}))
}
function projectReceipt(row:ReceiptRow,current:PhysicalPickupRow[]):PickupReceipt {
  const id=row.snapshot.receiptId,byId=new Map(current.map(part=>[`${part.unit.kind}:${part.unit.unitId}`,part]))
  const valid=!row.undo_id&&row.snapshot.units.every(part=>{const state=byId.get(`${part.kind}:${part.unitId}`);return state?.available&&state.state==='delivered'&&state.currentReceiptId===id&&state.unit.version===part.version+1&&state.unit.tableSessionId===row.snapshot.tableSessionId&&state.unit.tableId===part.tableId&&state.unit.locationVersion===part.locationVersion})
  const takenAt=new Date(row.snapshot.takenAt).toISOString()
  return {...row.snapshot,takenAt,deliveryConfirmedAt:takenAt,units:row.snapshot.units.map(unit=>({...unit,readyAt:isoOrNull(unit.readyAt)})),revision:row.undo_id?2:1,undo:row.undo_id?{undoId:row.undo_id,undoneAt:new Date(row.undone_at!).toISOString()}:null,canUndo:valid,undoBlockedReason:valid?null:row.undo_id?'这次领取已撤回':'原出品或桌次已有后续变化，不能撤回这次领取'}
}
export async function readPickupBoard(tx:ScopedTransaction,context:CommerceKdsRequestContext,enabled:boolean):Promise<PickupBoardData>{
  const access=await readPickupAccess(tx,context)
  // DB transaction start is a safe integer microsecond token ordering repeatable-read snapshots.
  const stamp=(await tx.query<{revision:string;generated_at:string}>('SELECT floor(extract(epoch FROM transaction_timestamp())*1000000)::bigint::text AS revision,transaction_timestamp()::text AS generated_at')).rows[0]!
  const board:PickupBoardData={revision:Number(stamp.revision),generatedAt:new Date(stamp.generated_at).toISOString(),commandScope:access.commandScope,device:access.device,recoveryAvailable:access.canDeliver&&!!access.device,
    setup:{enabled,configured:access.device!==null,canConfigure:enabled&&access.canConfigure},actor:{actionSessionValid:true,canPickup:access.canDeliver&&!!access.device,canUndo:access.canDeliver&&!!access.device,canConfigure:access.canConfigure},tables:[],history:[],attention:[]}
  if(!access.device||!access.canDeliver)return board
  const physical=await readPhysicalPickupUnits(tx),tables=new Map<string,PickupBoardData['tables'][number]>()
  for(const {unit,state,available} of physical){if(state!=='ready'||!available)continue
    let table=tables.get(unit.tableSessionId);if(!table){table={tableId:unit.tableId,tableCode:unit.tableCode,tableSessionId:unit.tableSessionId,locationVersion:unit.locationVersion,units:[]};tables.set(unit.tableSessionId,table)}table.units.push(unit)}
  board.tables=[...tables.values()]
  const receipts=await tx.query<ReceiptRow>(`SELECT receipt.snapshot,undo.id AS undo_id,undo.undone_at::text FROM mbox.pickup_receipts receipt
    LEFT JOIN mbox.pickup_undos undo ON (undo.tenant_id,undo.store_id,undo.receipt_id)=(receipt.tenant_id,receipt.store_id,receipt.id)
    WHERE receipt.tenant_id=$1 AND receipt.store_id=$2 ORDER BY receipt.taken_at DESC,receipt.id DESC LIMIT 100`,[tx.scope.tenantId,tx.scope.storeId])
  board.history=receipts.rows.map(row=>{const receipt=projectReceipt(row,physical);return {...receipt,canUndo:board.actor.canUndo&&receipt.canUndo}})
  const legacy=await tx.query<{id:string}>(`SELECT task.id FROM mbox.kds_tasks task JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(task.tenant_id,task.store_id,task.order_item_id)
    JOIN mbox.orders original ON (original.tenant_id,original.store_id,original.id)=(item.tenant_id,item.store_id,item.order_id)
    JOIN mbox.table_sessions visit ON (visit.tenant_id,visit.store_id,visit.id)=(original.tenant_id,original.store_id,original.table_session_id)
    WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.station_code IN ('bar','kitchen') AND task.status='ready' AND item.status<>'delivered'
      AND visit.status IN ('open','closing') AND NOT EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit WHERE (unit.tenant_id,unit.store_id,unit.order_item_id)=(item.tenant_id,item.store_id,item.id))`,[tx.scope.tenantId,tx.scope.storeId])
  board.attention=legacy.rows.map(row=>({taskId:row.id,message:'旧出品有退库、异常或拆份待核对，请从原任务继续处理；尚未标记取走',href:`/staff/fulfillment?factId=${encodeURIComponent(row.id)}`}))
  return board
}
function isoOrNull(value:string|null){return value===null?null:new Date(value).toISOString()}

/** Bounded one-time legacy adoption, only after trusted-device authorization. No completion or consumption is inferred. */
export async function initializeLegacyPickupUnits(tx:ScopedTransaction,context:CommerceKdsRequestContext){
  const access=await readPickupAccess(tx,context,true)
  if(!access.device||!access.canDeliver)return
  const rows=await tx.query<{task_id:string;item_id:string}>(`SELECT task.id AS task_id,item.id AS item_id FROM mbox.kds_tasks task
    JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(task.tenant_id,task.store_id,task.order_item_id)
    JOIN mbox.orders original ON (original.tenant_id,original.store_id,original.id)=(item.tenant_id,item.store_id,item.order_id)
    JOIN mbox.table_sessions visit ON (visit.tenant_id,visit.store_id,visit.id)=(original.tenant_id,original.store_id,original.table_session_id)
    WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.station_code IN ('bar','kitchen') AND task.status='ready' AND task.remake_of_task_id IS NULL
      AND item.status NOT IN ('delivered','cancelled') AND original.status<>'cancelled' AND visit.status IN ('open','closing')
      AND NOT EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit WHERE (unit.tenant_id,unit.store_id,unit.order_item_id)=(item.tenant_id,item.store_id,item.id))
      AND NOT EXISTS(SELECT 1 FROM mbox.kds_tasks abnormal WHERE (abnormal.tenant_id,abnormal.store_id,abnormal.order_item_id)=(item.tenant_id,item.store_id,item.id) AND (abnormal.status='failed' OR abnormal.remake_of_task_id IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM mbox.order_stock_returns returned WHERE (returned.tenant_id,returned.store_id,returned.order_item_id)=(item.tenant_id,item.store_id,item.id))
    ORDER BY visit.id,original.id,task.id LIMIT 25`,[tx.scope.tenantId,tx.scope.storeId])
  if(!rows.rowCount)return
  await lockQuantityTaskOrders(tx,rows.rows.map(row=>row.task_id))
  for(const row of rows.rows){try{await new ItemQuantityRepository(tx).initialize(row.item_id)}catch(error){if(!(error instanceof ItemQuantityConflict))throw error}}
}
