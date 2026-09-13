import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import type {ScopedPostgresTransactionRunner,StoreScope} from './transaction-runner.js'
import {ItemAfterSalesProgressRepository} from './item-after-sales-progress-repository.js'

/** Old pending money and rejected-but-still-paused goods stay visible across
 * business-day changes. Page size bounds reads, never the complete work queue. */
export class ItemAfterSalesHandoverQuery {
  constructor(private readonly transactions:ScopedPostgresTransactionRunner){}
  list(input:{scope:Readonly<StoreScope>;employeeId:string;limit?:number;cursor?:{createdAt:string;id:string}}){
    const limit=input.limit??25
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError('每页数量须为1至100')
    if(input.cursor&&(!Number.isFinite(Date.parse(input.cursor.createdAt))||!/^[0-9a-f-]{36}$/i.test(input.cursor.id)))throw new TypeError('售后分页位置无效')
    return this.transactions.run(input.scope,async tx=>{
      const access=await new StaffAccessRepository(tx).resolve(input.employeeId)
      const all=access.permissions.some(code=>['refund.approve','refund.execute','reconciliation.manage'].includes(code))
      const canHandlePhysical=access.permissions.includes('refund.request')&&access.permissions.some(code=>['inventory.receive','inventory.waste'].includes(code))
      if(!all&&!access.permissions.includes('refund.request'))throw new StaffAccessDeniedError('当前员工没有商品售后权限')
      const rows=(await tx.query<{id:string;created_at:string;table_code:string;order_public_id:string;order_business_date:string;requester_name:string;order_item_id:string;product_name:string;physical_only:boolean}>(`SELECT target.id,target.created_at::text,venue.code AS table_code,
        NOT $4::boolean AND target.requested_by_employee_id<>$3 AND session.status='closed' AS physical_only,
        original.public_id AS order_public_id,original.business_date::text AS order_business_date,requester.display_name AS requester_name,
        (SELECT unit.order_item_id::text FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id WHERE selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=target.id ORDER BY unit.unit_index LIMIT 1) AS order_item_id,
        (SELECT item.product_snapshot->>'name' FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id JOIN mbox.order_items item ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id WHERE selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=target.id ORDER BY unit.unit_index LIMIT 1) AS product_name
        FROM mbox.item_after_sales_cases target JOIN mbox.orders original ON original.tenant_id=target.tenant_id AND original.store_id=target.store_id AND original.id=target.order_id
        JOIN mbox.table_sessions session ON session.tenant_id=original.tenant_id AND session.store_id=original.store_id AND session.id=original.table_session_id
        JOIN mbox.tables venue ON venue.tenant_id=session.tenant_id AND venue.store_id=session.store_id AND venue.id=session.table_id
        JOIN mbox.employees requester ON requester.tenant_id=target.tenant_id AND requester.store_id=target.store_id AND requester.id=target.requested_by_employee_id
        WHERE target.tenant_id=$1 AND target.store_id=$2 AND (target.status IN ('requested','approved') OR EXISTS(
          SELECT 1 FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=target.tenant_id AND unit.store_id=target.store_id AND unit.held_by_case_id=target.id)
          OR EXISTS(SELECT 1 FROM mbox.item_after_sales_notices notice WHERE notice.tenant_id=target.tenant_id AND notice.store_id=target.store_id AND notice.case_id=target.id AND notice.acknowledged_at IS NULL))
        AND ($4::boolean OR target.requested_by_employee_id=$3
          OR $8::boolean AND session.status='closed' AND target.status IN ('approved','rejected','withdrawn') AND EXISTS(
            SELECT 1 FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=target.tenant_id AND unit.store_id=target.store_id AND unit.held_by_case_id=target.id)
          OR EXISTS(SELECT 1 FROM mbox.item_after_sales_events event WHERE event.tenant_id=target.tenant_id AND event.store_id=target.store_id
            AND event.case_id=target.id AND event.employee_id=$3 AND event.event_type='quantity.made_disposed') AND EXISTS(
            SELECT 1 FROM mbox.item_after_sales_notices notice WHERE notice.tenant_id=target.tenant_id AND notice.store_id=target.store_id AND notice.case_id=target.id AND notice.acknowledged_at IS NULL)
          OR session.status IN ('open','closing') AND EXISTS(
          SELECT 1 FROM mbox.table_assignments assignment WHERE assignment.tenant_id=session.tenant_id AND assignment.store_id=session.store_id AND assignment.table_id=session.table_id
          AND assignment.employee_id=$3 AND assignment.assignment_type IN ('primary','backup') AND assignment.starts_at<=clock_timestamp() AND (assignment.ends_at IS NULL OR assignment.ends_at>clock_timestamp())))
        AND ($5::timestamptz IS NULL OR (target.created_at,target.id)>($5::timestamptz,$6::uuid))
        ORDER BY target.created_at,target.id LIMIT $7`,[input.scope.tenantId,input.scope.storeId,input.employeeId,all,input.cursor?.createdAt??null,input.cursor?.id??null,limit+1,canHandlePhysical])).rows
      const page=rows.slice(0,limit),facts=await new ItemAfterSalesProgressRepository(tx).readMany(page.map(row=>row.id))
      const byId=new Map(facts.map(fact=>[fact.caseId,fact]))
      const last=page.at(-1)
      return {items:page.map(row=>({...byId.get(row.id)!,orderItemId:row.order_item_id,productName:row.product_name??'原商品',tableCode:row.table_code,orderPublicId:row.order_public_id,orderBusinessDate:row.order_business_date,requesterName:row.requester_name,createdAt:row.created_at,physicalOnly:row.physical_only})),
        nextCursor:rows.length>limit&&last?{createdAt:last.created_at,id:last.id}:null}
    },{isolation:'repeatable-read',readOnly:true})
  }
}
