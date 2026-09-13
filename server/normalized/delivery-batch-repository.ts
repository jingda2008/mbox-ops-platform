import {lockQuantityTaskOrders} from './quantity-task-lock.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {HardwareConflictError} from './hardware-repository.js'

export class DeliveryBatchRepository {
 constructor(private readonly tx:ScopedTransaction){}
 async create(employeeId:string,items:Array<{taskId:string;quantity:number;unitIds?:readonly string[];remakeUnitIds?:readonly string[]}>){
  if(!items.length||items.length>50||new Set(items.map(item=>item.taskId)).size!==items.length||items.some(item=>!Number.isSafeInteger(item.quantity)||item.quantity<1))throw new HardwareConflictError('请选择1至50项菜品及有效数量，同项不能重复')
  if(items.some(item=>item.unitIds&&(item.unitIds.length!==item.quantity||new Set(item.unitIds).size!==item.quantity)))throw new HardwareConflictError('配送批次必须对应本次完成的原份数')
  if(items.some(item=>item.remakeUnitIds&&(!!item.unitIds||item.remakeUnitIds.length!==item.quantity||new Set(item.remakeUnitIds).size!==item.quantity)))throw new HardwareConflictError('重做配送须对应独立的新批实物份数')
  const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
  await lockQuantityTaskOrders(this.tx,items.map(item=>item.taskId))
  const unitsByTask=new Map<string,string[]>(),remakeUnitsByTask=new Map<string,string[]>()
  const rows=(await this.tx.query<{id:string;quantity:number;station_code:string;table_session_id:string;status:string;item_status:string;order_status:string;quantity_managed:boolean;quantity_remake:boolean;order_item_id:string;session_status:string}>(`
   SELECT task.id,task.order_item_id,EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=task.tenant_id AND unit.store_id=task.store_id AND unit.order_item_id=task.order_item_id) AS quantity_managed,EXISTS(SELECT 1 FROM mbox.quantity_remake_batches batch WHERE batch.tenant_id=task.tenant_id AND batch.store_id=task.store_id AND batch.kds_task_id=task.id) AS quantity_remake,task.quantity,task.station_code,ordering.table_session_id,task.status,item.status AS item_status,ordering.status AS order_status,visit.status AS session_status
   FROM mbox.kds_tasks task JOIN mbox.order_items item ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
   JOIN mbox.orders ordering ON ordering.tenant_id=item.tenant_id AND ordering.store_id=item.store_id AND ordering.id=item.order_id
   JOIN mbox.table_sessions visit ON visit.tenant_id=ordering.tenant_id AND visit.store_id=ordering.store_id AND visit.id=ordering.table_session_id
   WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=ANY($3::uuid[]) ORDER BY task.id FOR UPDATE OF task`,[...scope,items.map(item=>item.taskId)])).rows
  if(rows.length!==items.length||rows.some(row=>(row.quantity_managed?!['pending','accepted','preparing','ready'].includes(row.status):row.status!=='ready')||(row.item_status==='cancelled'||row.item_status==='delivered'&&!row.quantity_remake)||row.order_status==='cancelled'||row.quantity_remake&&!['open','closing'].includes(row.session_status)))throw new HardwareConflictError('只能把已备齐、未送达且未取消的菜品加入配送批次')
  const first=rows[0]!
  if(new Set(rows.map(row=>row.table_session_id)).size!==1||new Set(rows.map(row=>row.station_code)).size!==1||!['bar','kitchen'].includes(first.station_code))throw new HardwareConflictError('一次配送只能选择同一桌次、同一工作站的菜品')
  for(const row of rows){
   const used=(await this.tx.query<{quantity:string;legacy:boolean}>(`SELECT COALESCE(sum(quantity),0)::text AS quantity,
    EXISTS(SELECT 1 FROM mbox.print_source_jobs WHERE tenant_id=$1 AND store_id=$2 AND aggregate_id=$3 AND ticket_kind='delivery') AS legacy
    FROM mbox.delivery_batch_items WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3`,[...scope,row.id])).rows[0]!
   if(used.legacy)throw new HardwareConflictError('该菜品已有旧版配送票，请核对原任务，不能再次合单出纸')
   const selection=items.find(item=>item.taskId===row.id)!,requested=selection.quantity
   if(row.quantity_remake){
    if(selection.unitIds)throw new HardwareConflictError('重做配送不能使用旧实物的份数编号')
    const assigned=(await this.tx.query<{quantity:number}>('SELECT count(*)::int AS quantity FROM mbox.delivery_batch_remake_units WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3',[...scope,row.id])).rows[0]!.quantity
    if(Number(used.quantity)!==assigned)throw new HardwareConflictError('该重做任务已有未关联实物的配送票，请核对原批次')
    const available=(await this.tx.query<{id:string}>(`SELECT part.id FROM mbox.quantity_remake_units part JOIN mbox.quantity_remake_batches batch ON batch.tenant_id=part.tenant_id AND batch.store_id=part.store_id AND batch.id=part.batch_id
      JOIN mbox.order_item_quantity_units original ON original.tenant_id=part.tenant_id AND original.store_id=part.store_id AND original.id=part.unit_id
      WHERE part.tenant_id=$1 AND part.store_id=$2 AND batch.kds_task_id=$3 AND part.production_state='ready' AND part.cancelled_at IS NULL
        AND original.held_by_case_id IS NULL AND NOT original.operationally_stopped AND ($5::uuid[] IS NULL OR part.id=ANY($5::uuid[]))
        AND NOT EXISTS(SELECT 1 FROM mbox.delivery_batch_remake_units assigned WHERE assigned.tenant_id=part.tenant_id AND assigned.store_id=part.store_id AND assigned.remake_unit_id=part.id)
      ORDER BY original.unit_index LIMIT $4 FOR UPDATE OF part`,[...scope,row.id,requested,selection.remakeUnitIds??null])).rows.map(unit=>unit.id)
    if(available.length!==requested)throw new HardwareConflictError('本批数量超过新实物已备齐且尚未安排配送的份数')
    remakeUnitsByTask.set(row.id,available)
   }else if(selection.remakeUnitIds)throw new HardwareConflictError('原商品不能使用其他重做批次的实物编号')
   else if(row.quantity_managed){
    const assigned=(await this.tx.query<{quantity:number}>('SELECT count(*)::int AS quantity FROM mbox.delivery_batch_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3',[...scope,row.id])).rows[0]!.quantity
    if(Number(used.quantity)!==assigned)throw new HardwareConflictError('该商品已有旧配送批次，请沿用原票确认送达，不能重复生成配送票')
    const available=(await this.tx.query<{id:string}>(`SELECT unit.id FROM mbox.order_item_quantity_units unit
      WHERE unit.tenant_id=$1 AND unit.store_id=$2 AND unit.order_item_id=$3 AND unit.production_state='ready'
        AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped
        AND ($5::uuid[] IS NULL OR unit.id=ANY($5::uuid[]))
        AND NOT EXISTS(SELECT 1 FROM mbox.delivery_batch_quantity_units assigned WHERE assigned.tenant_id=unit.tenant_id AND assigned.store_id=unit.store_id AND assigned.unit_id=unit.id)
      ORDER BY unit.unit_index LIMIT $4 FOR UPDATE OF unit`,[...scope,row.order_item_id,requested,selection.unitIds??null])).rows.map(unit=>unit.id)
    if(available.length!==requested)throw new HardwareConflictError('本批数量超过尚未安排配送、未暂停的已备齐数量')
    unitsByTask.set(row.id,available)
   }else if(selection.unitIds||Number(used.quantity)+requested>row.quantity)throw new HardwareConflictError('本批数量超过尚未加入配送批次的数量或原份数未建立')
  }
  const batch=(await this.tx.query<{id:string}>(`INSERT INTO mbox.delivery_batches(tenant_id,store_id,table_session_id,station_code,created_by_employee_id) VALUES($1,$2,$3,$4,$5) RETURNING id`,[...scope,first.table_session_id,first.station_code,employeeId])).rows[0]!
  for(const item of items){
   await this.tx.query('INSERT INTO mbox.delivery_batch_items(tenant_id,store_id,batch_id,kds_task_id,quantity) VALUES($1,$2,$3,$4,$5)',[...scope,batch.id,item.taskId,item.quantity])
   const remakeUnits=remakeUnitsByTask.get(item.taskId)
   if(remakeUnits)await this.tx.query('INSERT INTO mbox.delivery_batch_remake_units(tenant_id,store_id,batch_id,kds_task_id,remake_unit_id) SELECT $1,$2,$3,$4,unnest($5::uuid[])',[...scope,batch.id,item.taskId,remakeUnits])
   const units=unitsByTask.get(item.taskId)
   if(units)await this.tx.query('INSERT INTO mbox.delivery_batch_quantity_units(tenant_id,store_id,batch_id,kds_task_id,unit_id) SELECT $1,$2,$3,$4,unnest($5::uuid[])',[...scope,batch.id,item.taskId,units])
  }
  return {id:batch.id,tableSessionId:first.table_session_id,stationCode:first.station_code,items:items.map(({taskId,quantity})=>({taskId,quantity}))}
 }

 async originalForUnits(taskId:string,unitIds:readonly string[],kind:'original'|'remake'='original'){
  const relation=kind==='remake'?'delivery_batch_remake_units':'delivery_batch_quantity_units',column=kind==='remake'?'remake_unit_id':'unit_id'
  const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
  const bindings=(await this.tx.query<{batch_id:string}>(`SELECT batch_id FROM mbox.${relation} WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3 AND ${column}=ANY($4::uuid[])`,[...scope,taskId,unitIds])).rows
  if(!unitIds.length||bindings.length!==unitIds.length||new Set(bindings.map(row=>row.batch_id)).size!==1)throw new HardwareConflictError('原完成记录的配送批次不完整，请核对原票，不重复生成')
  const batch=(await this.tx.query<{id:string;table_session_id:string;station_code:string}>(`SELECT id,table_session_id,station_code FROM mbox.delivery_batches WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope,bindings[0]!.batch_id])).rows[0]!
  const items=(await this.tx.query<{taskId:string;quantity:number}>(`SELECT kds_task_id AS "taskId",quantity FROM mbox.delivery_batch_items WHERE tenant_id=$1 AND store_id=$2 AND batch_id=$3 ORDER BY kds_task_id`,[...scope,batch.id])).rows
  if(items.find(item=>item.taskId===taskId)?.quantity!==unitIds.length)throw new HardwareConflictError('原票份数与本次完成记录不一致，请核对原批次')
  return {id:batch.id,tableSessionId:batch.table_session_id,stationCode:batch.station_code,items}
 }
}
