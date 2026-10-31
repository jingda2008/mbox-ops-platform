import type {ScopedTransaction} from './transaction-runner.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {TablePrepaymentRepository,TablePrepaymentError} from './table-prepayment-repository.js'

export class TableMinimumExceptionsRepository {
 constructor(private readonly tx:ScopedTransaction){}
 private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
 async assertAccess(employeeId:string,sessionId:string,adjust=false){
  const access=adjust?await new StaffAccessRepository(this.tx).assertPermission(employeeId,'table.minimum_spend.adjust'):await new StaffAccessRepository(this.tx).resolve(employeeId)
  if(!access.permissions.includes('table.view_all')&&!(!adjust&&access.permissions.includes('reconciliation.view'))){
   if(adjust||!access.permissions.includes('order.create'))throw new StaffAccessDeniedError('无权查看或调整本桌低消')
   const allowed=await this.tx.query(`SELECT 1 FROM mbox.table_sessions s JOIN mbox.table_assignments a ON(a.tenant_id,a.store_id,a.table_id)=(s.tenant_id,s.store_id,s.table_id)
    WHERE(s.tenant_id,s.store_id,s.id) = ($1,$2,$3) AND a.employee_id=$4 AND a.assignment_type IN('primary','backup') AND a.starts_at<=clock_timestamp() AND(a.ends_at IS NULL OR a.ends_at>clock_timestamp())`,[...this.scope,sessionId,employeeId])
   if(!allowed.rowCount)throw new StaffAccessDeniedError('当前员工未负责该桌台')
  }
 }
 async snapshot(sessionId:string){
  const row=(await this.tx.query<{minimum:string;waiver:string;mode:string;status:string;consumed:string}>(`SELECT minimum_spend_minor::text minimum,minimum_spend_waiver_minor::text waiver,minimum_spend_mode mode,status,mbox.table_qualifying_goods(tenant_id,store_id,id)::text consumed FROM mbox.table_sessions WHERE(tenant_id,store_id,id)=($1,$2,$3)`,[...this.scope,sessionId])).rows[0]
  if(!row)throw new TablePrepaymentError('TABLE_MINIMUM_SESSION_NOT_FOUND','桌次不存在')
  const history=(await this.tx.query(`SELECT w.id,'adjust' AS kind,w.employee_id AS "employeeId",COALESCE(w.employee_name,e.display_name) AS "employeeName",w.reason,w.created_at::text AS "createdAt",w.amount_minor::text AS "amountMinor",w.before_minimum_minor::text AS "beforeMinor",w.after_minimum_minor::text AS "afterMinor",NULL::text AS "orderPublicId",NULL::text AS "shortfallMinor"
    FROM mbox.table_minimum_spend_waivers w JOIN mbox.employees e ON(e.tenant_id,e.store_id,e.id)=(w.tenant_id,w.store_id,w.employee_id) WHERE(w.tenant_id,w.store_id,w.table_session_id)=($1,$2,$3)
    UNION ALL SELECT r.id,'release',r.employee_id,COALESCE(r.employee_name,e.display_name),r.reason,r.created_at::text,NULL,r.minimum_minor::text,r.minimum_minor::text,o.public_id,r.shortfall_minor::text
    FROM mbox.order_minimum_spend_releases r JOIN mbox.employees e ON(e.tenant_id,e.store_id,e.id)=(r.tenant_id,r.store_id,r.employee_id) JOIN mbox.orders o ON(o.tenant_id,o.store_id,o.id)=(r.tenant_id,r.store_id,r.order_id) WHERE(r.tenant_id,r.store_id,r.table_session_id)=($1,$2,$3) ORDER BY "createdAt" DESC,id`,[...this.scope,sessionId])).rows
  const originalMinimumMinor=Number(row.minimum),effectiveMinimumMinor=originalMinimumMinor-Number(row.waiver),consumedMinor=Number(row.consumed)
  return{originalMinimumMinor,effectiveMinimumMinor,consumedMinor,shortfallMinor:Math.max(0,effectiveMinimumMinor-consumedMinor),mode:row.mode,status:row.status,differenceChargingEnabled:false,history}
 }
 async adjust(input:{sessionId:string;employeeId:string;expectedMinimumMinor:number;targetMinimumMinor:number;reason:string}){
  await this.assertAccess(input.employeeId,input.sessionId,true)
  if(!Number.isSafeInteger(input.expectedMinimumMinor)||!Number.isSafeInteger(input.targetMinimumMinor)||input.targetMinimumMinor<0||input.reason.trim().length<2||input.reason.length>500)throw new TablePrepaymentError('TABLE_MINIMUM_ADJUST_INVALID','请填写有效金额及 2 至 500 字原因')
  const repo=new TablePrepaymentRepository(this.tx),session=await repo.lock(input.sessionId,true)
  const current=Number(session.minimum_spend_minor)-Number(session.minimum_spend_waiver_minor)
  if(current!==input.expectedMinimumMinor)throw new TablePrepaymentError('TABLE_MINIMUM_CHANGED','本桌低消已被其他人调整，请刷新核对后重试')
  if(input.targetMinimumMinor>=current)throw new TablePrepaymentError('TABLE_MINIMUM_ADJUST_INVALID','仅支持降低或取消当前低消')
  if(session.status!=='open'&&!(await this.tx.query('SELECT 1 FROM mbox.table_prepayment_turnovers WHERE(tenant_id,store_id,table_session_id)=($1,$2,$3)',[...this.scope,input.sessionId])).rowCount)throw new TablePrepaymentError('TABLE_MINIMUM_SESSION_CLOSED','本桌已结清，不能更改历史低消')
  const before=await this.snapshot(input.sessionId)
  await repo.waive(input.sessionId,input.employeeId,current-input.targetMinimumMinor,input.reason)
  return{before,after:await this.snapshot(input.sessionId)}
 }
}
