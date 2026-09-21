import type {KitchenCommand, KitchenCommandResult, ProductionStation} from '../../src/shared/kitchen-production.js'
import {CommerceKdsRequestError, type CommerceKdsRequestContext} from './commerce-kds-api.js'
import {readKitchenBatches, readKitchenHandoffPreview} from './kitchen-production-query.js'
import type {ScopedTransaction} from './transaction-runner.js'

const changed=():never=>{throw new CommerceKdsRequestError('KITCHEN_HANDOFF_CHANGED','接班范围或负责人已改变，请重新读取并核对全部实物',409)}
const canonical=(rows:readonly unknown[])=>JSON.stringify([...rows].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))

/** Parent order locks serialize against starts, portion mutations and table moves.
 * The complete connected scope is re-read only after acquiring those locks. */
export async function executeKitchenHandoff(tx:ScopedTransaction,context:CommerceKdsRequestContext,command:Extract<KitchenCommand,{action:'handoff'}>,operationKey:string,stationCode:ProductionStation):Promise<KitchenCommandResult>{
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const preview=await readKitchenHandoffPreview(tx,command.batchId,stationCode)
  if(!preview||canonical(preview.batches)!==canonical(command.expectedBatches)||canonical(preview.tasks)!==canonical(command.expectedTasks))changed()
  const taskIds=command.expectedTasks.map(task=>task.taskId).sort(),batchIds=command.expectedBatches.map(batch=>batch.batchId).sort()
  const targets=(await tx.query<{task_id:string;order_id:string;session_id:string}>(`SELECT task.id AS task_id,original.id AS order_id,original.table_session_id AS session_id
    FROM mbox.kds_tasks task JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(task.tenant_id,task.store_id,task.order_item_id)
    JOIN mbox.orders original ON (original.tenant_id,original.store_id,original.id)=(item.tenant_id,item.store_id,item.order_id)
    WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.station_code=$4 AND task.id=ANY($3::uuid[]) ORDER BY task.id`,[...scope,taskIds,stationCode])).rows
  if(targets.length!==taskIds.length)changed()
  const sessions=[...new Set(targets.map(row=>row.session_id))].sort(),orders=[...new Set(targets.map(row=>row.order_id))].sort()
  await tx.query('SELECT id FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE',[...scope,sessions])
  const locked=(await tx.query<{id:string;table_session_id:string}>('SELECT id,table_session_id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE',[...scope,orders])).rows
  if(locked.length!==orders.length||targets.some(row=>locked.find(order=>order.id===row.order_id)?.table_session_id!==row.session_id))changed()
  await tx.query('SELECT id FROM mbox.kitchen_production_batches WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE',[...scope,batchIds])
  await tx.query('SELECT id FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE',[...scope,taskIds])
  const current=await readKitchenHandoffPreview(tx,command.batchId,stationCode)
  if(!current||canonical(current.batches)!==canonical(command.expectedBatches)||canonical(current.tasks)!==canonical(command.expectedTasks))changed()
  const owners=new Set(command.expectedBatches.map(batch=>batch.expectedCurrentOwnerId)),owner=command.expectedBatches[0]!.expectedCurrentOwnerId
  if(owners.size!==1||owner===context.employeeId||command.expectedTasks.some(task=>task.expectedEmployeeId!==null&&task.expectedEmployeeId!==owner))changed()
  const ownershipVersions:Record<string,number>={}
  for(const batch of command.expectedBatches){
    const version=batch.expectedOwnershipVersion+1;ownershipVersions[batch.batchId]=version
    await tx.query(`INSERT INTO mbox.kitchen_production_handoffs
      (tenant_id,store_id,batch_id,ownership_version,from_employee_id,to_employee_id,actor_employee_id,operation_key,reason,physical_checked,affected_task_ids,affected_batch_ids)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,true,$9::uuid[],$10::uuid[])`,[...scope,batch.batchId,version,owner,context.employeeId,operationKey,command.reason,taskIds,batchIds])
  }
  // Closed/terminal tasks retain history; their still-occupied equipment can be
  // explicitly handed over and cleared without reopening preparation.
  const moved=(await tx.query<{id:string;status:string}>(`UPDATE mbox.kds_tasks task SET assigned_employee_id=$4,updated_at=clock_timestamp()
    FROM mbox.order_items item,mbox.orders original,mbox.table_sessions session
    WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=ANY($3::uuid[]) AND task.status IN ('pending','accepted','preparing','ready')
      AND (item.tenant_id,item.store_id,item.id)=(task.tenant_id,task.store_id,task.order_item_id)
      AND (original.tenant_id,original.store_id,original.id)=(item.tenant_id,item.store_id,item.order_id)
      AND (session.tenant_id,session.store_id,session.id)=(original.tenant_id,original.store_id,original.table_session_id)
      AND session.status IN ('open','closing') RETURNING task.id,task.status`,[...scope,taskIds,context.employeeId])).rows
  for(const task of moved)await tx.query(`INSERT INTO mbox.kds_task_events(tenant_id,store_id,kds_task_id,event_type,from_status,to_status,actor_employee_id,metadata,idempotency_key)
    VALUES($1,$2,$3,'production.handoff',$4,$4,$5,$6::jsonb,$7)`,[...scope,task.id,task.status,context.employeeId,JSON.stringify({fromEmployeeId:owner,toEmployeeId:context.employeeId,affectedBatchIds:batchIds,reason:command.reason}),`production-handoff:${operationKey}`])
  const anchor=(await readKitchenBatches(tx,command.batchId,stationCode))[0]!
  return {action:'handoff',batchId:command.batchId,quantity:0,released:anchor.releasedAt!==null,affectedBatchIds:batchIds,ownershipVersions}
}
