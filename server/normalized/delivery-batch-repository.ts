import type {ScopedTransaction} from './transaction-runner.js'
import {HardwareConflictError} from './hardware-repository.js'

export class DeliveryBatchRepository {
 constructor(private readonly tx:ScopedTransaction){}
 async create(employeeId:string,items:Array<{taskId:string;quantity:number}>){
  if(!items.length||items.length>50||new Set(items.map(item=>item.taskId)).size!==items.length||items.some(item=>!Number.isSafeInteger(item.quantity)||item.quantity<1))throw new HardwareConflictError('请选择1至50项菜品及有效数量，同项不能重复')
  const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
  const rows=(await this.tx.query<{id:string;quantity:number;station_code:string;table_session_id:string;status:string;item_status:string;order_status:string}>(`
   SELECT task.id,task.quantity,task.station_code,ordering.table_session_id,task.status,item.status AS item_status,ordering.status AS order_status
   FROM mbox.kds_tasks task JOIN mbox.order_items item ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
   JOIN mbox.orders ordering ON ordering.tenant_id=item.tenant_id AND ordering.store_id=item.store_id AND ordering.id=item.order_id
   WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=ANY($3::uuid[]) ORDER BY task.id FOR UPDATE OF task`,[...scope,items.map(item=>item.taskId)])).rows
  if(rows.length!==items.length||rows.some(row=>row.status!=='ready'||['cancelled','delivered'].includes(row.item_status)||row.order_status==='cancelled'))throw new HardwareConflictError('只能把已备齐、未送达且未取消的菜品加入配送批次')
  const first=rows[0]!
  if(new Set(rows.map(row=>row.table_session_id)).size!==1||new Set(rows.map(row=>row.station_code)).size!==1||!['bar','kitchen'].includes(first.station_code))throw new HardwareConflictError('一次配送只能选择同一桌次、同一工作站的菜品')
  for(const row of rows){
   const used=(await this.tx.query<{quantity:string;legacy:boolean}>(`SELECT COALESCE(sum(quantity),0)::text AS quantity,
    EXISTS(SELECT 1 FROM mbox.print_source_jobs WHERE tenant_id=$1 AND store_id=$2 AND aggregate_id=$3 AND ticket_kind='delivery') AS legacy
    FROM mbox.delivery_batch_items WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3`,[...scope,row.id])).rows[0]!
   if(used.legacy)throw new HardwareConflictError('该菜品已有旧版配送票，请核对原任务，不能再次合单出纸')
   if(Number(used.quantity)+items.find(item=>item.taskId===row.id)!.quantity>row.quantity)throw new HardwareConflictError('本批数量超过尚未加入配送批次的数量')
  }
  const batch=(await this.tx.query<{id:string}>(`INSERT INTO mbox.delivery_batches(tenant_id,store_id,table_session_id,station_code,created_by_employee_id) VALUES($1,$2,$3,$4,$5) RETURNING id`,[...scope,first.table_session_id,first.station_code,employeeId])).rows[0]!
  for(const item of items)await this.tx.query('INSERT INTO mbox.delivery_batch_items(tenant_id,store_id,batch_id,kds_task_id,quantity) VALUES($1,$2,$3,$4,$5)',[...scope,batch.id,item.taskId,item.quantity])
  return {id:batch.id,tableSessionId:first.table_session_id,stationCode:first.station_code,items}
 }
}
