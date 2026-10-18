import type { ScopedTransaction } from './transaction-runner.js'
import type { ServiceTable, ServiceSession, ServiceChange, ServiceActivity, ServiceDetail, ServiceOptions } from '../../src/shared/table-service.js'
export class TableServiceNotFound extends Error {}
export class TableServiceConflict extends Error {}
const sessionColumns=`s.id,s.table_id AS "tableId",t.code AS "tableCode",s.opened_at::text AS "openedAt",s.closed_at::text AS "closedAt",s.status,
 opener.display_name AS "openedBy",s.primary_service_employee_id AS "primaryId",e.display_name AS "primaryName",e.employee_code AS "primaryCode",e.status AS "primaryStatus",s.service_revision AS revision`
const sessionJoins=`FROM mbox.table_sessions s JOIN mbox.tables t ON (t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id)
 LEFT JOIN mbox.employees e ON (e.tenant_id,e.store_id,e.id)=(s.tenant_id,s.store_id,s.primary_service_employee_id)
 LEFT JOIN mbox.employees opener ON (opener.tenant_id,opener.store_id,opener.id)=(s.tenant_id,s.store_id,s.opened_by_employee_id)`
export class TableServiceRepository {
 constructor(private readonly tx:ScopedTransaction) {}
 private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
 async tables():Promise<ServiceTable[]> {
  return (await this.tx.query<ServiceTable & Record<string,unknown>>(`SELECT t.id,t.code,t.display_name AS name,a.name AS area,
   s.id AS "sessionId",e.display_name AS "primaryName" FROM mbox.tables t
   JOIN mbox.areas a ON (a.tenant_id,a.store_id,a.id)=(t.tenant_id,t.store_id,t.area_id)
   LEFT JOIN mbox.table_sessions s ON (s.tenant_id,s.store_id,s.table_id)=(t.tenant_id,t.store_id,t.id) AND s.status IN ('open','closing')
   LEFT JOIN mbox.employees e ON (e.tenant_id,e.store_id,e.id)=(s.tenant_id,s.store_id,s.primary_service_employee_id)
   WHERE t.tenant_id=$1 AND t.store_id=$2 ORDER BY a.sort_order,t.code`,this.scope)).rows
 }
 async options(tableId:string):Promise<ServiceOptions> {
  const table=await this.tx.query(`SELECT id FROM mbox.tables WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,tableId])
  if(!table.rowCount)throw new TableServiceNotFound('桌台不存在')
  const employees=(await this.tx.query<{id:string;name:string;code:string}>(`SELECT id,display_name AS name,employee_code AS code FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND status='active' ORDER BY display_name,id`,this.scope)).rows
  const primary=(await this.tx.query<{id:string}>(`SELECT DISTINCT a.employee_id AS id FROM mbox.table_assignments a
   JOIN mbox.employees e ON (e.tenant_id,e.store_id,e.id)=(a.tenant_id,a.store_id,a.employee_id)
   WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.table_id=$3 AND a.assignment_type='primary' AND a.cancelled_at IS NULL
    AND a.starts_at<=clock_timestamp() AND (a.ends_at IS NULL OR a.ends_at>clock_timestamp()) AND e.status='active'`,[...this.scope,tableId])).rows
  return {employees,suggestedPrimaryId:primary.length===1?primary[0]!.id:null}
 }
 async sessions(tableId:string,page:number) {
  const rows=(await this.tx.query<ServiceSession & Record<string,unknown>>(`SELECT ${sessionColumns} ${sessionJoins}
   WHERE s.tenant_id=$1 AND s.store_id=$2 AND (s.table_id=$3 OR EXISTS(SELECT 1 FROM mbox.table_customer_movement_events m WHERE m.tenant_id=s.tenant_id AND m.store_id=s.store_id AND m.movement_kind='whole_table_transfer' AND m.source_table_session_id=s.id AND (m.source_table_id=$3 OR m.target_table_id=$3))) ORDER BY s.opened_at DESC,s.id DESC LIMIT 21 OFFSET $4`,[...this.scope,tableId,page*20])).rows
  return {sessions:rows.slice(0,20),hasMore:rows.length>20}
 }
 async detail(sessionId:string,changesPage=0,activitiesPage=0):Promise<ServiceDetail> {
  const session=(await this.tx.query<ServiceSession & Record<string,unknown>>(`SELECT ${sessionColumns} ${sessionJoins}
   WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3`,[...this.scope,sessionId])).rows[0]
  if(!session)throw new TableServiceNotFound('桌次不存在或不属于本门店')
  const changes=(await this.tx.query<ServiceChange & Record<string,unknown>>(`SELECT c.id,c.revision,c.from_name AS "fromName",c.to_name AS "toName",c.actor_name AS "actorName",c.reason,c.occurred_at::text AS "occurredAt",f.employee_code AS "fromCode",t.employee_code AS "toCode",a.employee_code AS "actorCode"
   FROM mbox.table_session_service_changes c LEFT JOIN mbox.employees f ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.from_employee_id) JOIN mbox.employees t ON (t.tenant_id,t.store_id,t.id)=(c.tenant_id,c.store_id,c.to_employee_id) JOIN mbox.employees a ON (a.tenant_id,a.store_id,a.id)=(c.tenant_id,c.store_id,c.actor_employee_id) WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.table_session_id=$3 ORDER BY c.revision DESC LIMIT 51 OFFSET $4`,[...this.scope,sessionId,changesPage*50])).rows
  const helpers=session.status==='open'||session.status==='closing'?(await this.tx.query<{id:string;name:string;type:string}>(`SELECT DISTINCT e.id,e.display_name AS name,a.assignment_type AS type FROM mbox.table_assignments a
   JOIN mbox.employees e ON (e.tenant_id,e.store_id,e.id)=(a.tenant_id,a.store_id,a.employee_id)
   WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.table_id=$3 AND a.assignment_type IN ('backup','temporary')
    AND a.cancelled_at IS NULL AND a.starts_at<=clock_timestamp() AND (a.ends_at IS NULL OR a.ends_at>clock_timestamp()) AND e.status='active' ORDER BY name,id,type`,[...this.scope,session.tableId])).rows:[]
  // Only allow-listed operational facts are projected. Notes, customer identities,
  // prices, payment details and arbitrary audit metadata are never exposed here.
  const activities=(await this.tx.query<ServiceActivity & Record<string,unknown>>(`WITH facts AS (
   SELECT 'service:'||ev.id AS id,'service'::text AS kind,task.task_type AS title,ev.actor_employee_id AS actor_id,ev.occurred_at,ev.event_type AS event
   FROM mbox.service_task_events ev JOIN mbox.service_tasks task ON (task.tenant_id,task.store_id,task.id)=(ev.tenant_id,ev.store_id,ev.service_task_id)
   WHERE ev.tenant_id=$1 AND ev.store_id=$2 AND task.table_session_id=$3
   UNION ALL
   SELECT 'kds:'||ev.id,'production',COALESCE(item.product_snapshot->>'name','出品'),ev.actor_employee_id,ev.occurred_at,ev.event_type
   FROM mbox.kds_task_events ev JOIN mbox.kds_tasks task ON (task.tenant_id,task.store_id,task.id)=(ev.tenant_id,ev.store_id,ev.kds_task_id)
   JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(task.tenant_id,task.store_id,task.order_item_id)
   JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(item.tenant_id,item.store_id,item.order_id)
   WHERE ev.tenant_id=$1 AND ev.store_id=$2 AND o.table_session_id=$3
   UNION ALL
   SELECT 'delivery:'||a.id,'delivery','送达确认',a.actor_employee_id,a.occurred_at,a.action
   FROM mbox.audit_events a JOIN mbox.kds_tasks task ON task.tenant_id=a.tenant_id AND task.store_id=a.store_id AND task.id::text=a.object_id
   JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(task.tenant_id,task.store_id,task.order_item_id)
   JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(item.tenant_id,item.store_id,item.order_id)
   WHERE a.tenant_id=$1 AND a.store_id=$2 AND o.table_session_id=$3 AND a.object_type='kds_task' AND a.action IN ('kds.deliver','kds.completeAndDeliver')
    AND NOT COALESCE(a.after_snapshot ? 'affectedUnitIds',false)
   UNION ALL
   SELECT 'pickup:'||r.id,'pickup','取餐确认（授权账号）',r.authorized_employee_id,r.taken_at,'pickup.taken'
   FROM mbox.pickup_receipts r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.table_session_id=$3
   UNION ALL
   SELECT 'undo:'||u.id,'pickup','撤销取餐（授权账号）',u.authorized_employee_id,u.undone_at,'pickup.undone'
   FROM mbox.pickup_undos u JOIN mbox.pickup_receipts r ON (r.tenant_id,r.store_id,r.id)=(u.tenant_id,u.store_id,u.receipt_id)
   WHERE u.tenant_id=$1 AND u.store_id=$2 AND r.table_session_id=$3
  ) SELECT f.id,f.kind,f.title,f.actor_id AS "actorId",e.display_name AS "actorName",e.employee_code AS "actorCode",f.occurred_at::text AS "occurredAt",f.event
   FROM facts f LEFT JOIN mbox.employees e ON e.tenant_id=$1 AND e.store_id=$2 AND e.id=f.actor_id
   ORDER BY f.occurred_at DESC,f.id DESC LIMIT 51 OFFSET $4`,[...this.scope,sessionId,activitiesPage*50])).rows
  return {session,helpers,changes:changes.slice(0,50),changesHasMore:changes.length>50,activities:activities.slice(0,50),activitiesHasMore:activities.length>50}
 }
 async handover(sessionId:string,employeeId:string,actorId:string,expectedRevision:number,reason:string) {
  const s=(await this.tx.query<{primary_service_employee_id:string|null;service_revision:number;status:string}>(`SELECT primary_service_employee_id,service_revision,status FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,sessionId])).rows[0]
  if(!s)throw new TableServiceNotFound('桌次不存在')
  if(s.status!=='open'||s.service_revision!==expectedRevision||s.primary_service_employee_id===employeeId)throw new TableServiceConflict('桌次或负责人已变化，请刷新后重新交接')
  const row=(await this.tx.query<{id:string;revision:number}>(`INSERT INTO mbox.table_session_service_changes(tenant_id,store_id,table_session_id,revision,from_employee_id,to_employee_id,actor_employee_id,from_name,to_name,actor_name,reason)
   VALUES($1,$2,$3,$4,$5,$6,$7,NULL,'','',$8) RETURNING id,revision`,[...this.scope,sessionId,expectedRevision+1,s.primary_service_employee_id,employeeId,actorId,reason])).rows[0]!
  return {id:row.id,sessionId,revision:row.revision,primaryServiceEmployeeId:employeeId}
 }
}
