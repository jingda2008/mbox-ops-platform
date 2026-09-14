import {readPackagedReturnEligibility} from './packaged-return-evidence.js'
import {hasActiveKdsSession} from './kds-authorization-policy.js'
import {resolveFulfillmentAllowedStations} from './fulfillment-query-service.js'
import {assertEmployeeTableSessionReadAccess,EmployeeTableAccessDeniedError} from './employee-table-access.js'
import {refundReservesAmountSql} from './refund-attempt-sql.js'
import type {ScopedPostgresTransactionRunner,StoreScope} from './transaction-runner.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {ItemAfterSalesProgressRepository} from './item-after-sales-progress-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** A single product workspace: all original facts, current holds and separate
 * money/physical outcomes. Reading never initializes stock or quantity ledgers. */
export class ItemAfterSalesQuery {
  constructor(private readonly transactions:ScopedPostgresTransactionRunner,private readonly acceptNewRequests=true){}
  item(input:{scope:Readonly<StoreScope>;employeeId:string;itemId:string;staffSessionId?:string;deviceAccessLeaseId?:string}){
    return this.transactions.run(input.scope,async tx=>{
      const scope=[input.scope.tenantId,input.scope.storeId]
      const access=await new StaffAccessRepository(tx).resolve(input.employeeId)
      const permissions=access.permissions
      if(!permissions.some(code=>['refund.request','refund.approve','refund.execute'].includes(code)))throw new StaffAccessDeniedError('当前员工没有商品售后权限')
      const item=(await tx.query<{id:string;order_id:string;name:string;quantity:number;original_amount:string;unit_price:string;status:string;order_public_id:string;table_code:string;table_session_id:string;guest_count:number;session_status:string;fulfillment_active:boolean;has_order_cancellation:boolean;bundle:boolean;bundle_header:boolean;included_in_bundle:boolean}>(`SELECT item.id,item.order_id,
        COALESCE(item.product_snapshot->>'name',product.name) AS name,item.quantity,item.total_amount_minor::text AS original_amount,item.unit_price_minor::text AS unit_price,item.status,
        original.public_id AS order_public_id,venue.code AS table_code,session.status AS session_status,session.id AS table_session_id,session.guest_count,
        original.status<>'cancelled' AND original.fulfillment_state NOT IN ('awaiting_payment','released','cancelled') AND item.status<>'cancelled' AS fulfillment_active,
        original.status='cancelled' AND EXISTS(SELECT 1 FROM mbox.order_cancellation_events event WHERE event.tenant_id=original.tenant_id AND event.store_id=original.store_id AND event.order_id=original.id) AS has_order_cancellation,
        item.parent_order_item_id IS NOT NULL AS included_in_bundle,
        EXISTS(SELECT 1 FROM mbox.order_items child WHERE child.tenant_id=item.tenant_id AND child.store_id=item.store_id AND child.parent_order_item_id=item.id) AS bundle_header,
        item.parent_order_item_id IS NOT NULL OR EXISTS(SELECT 1 FROM mbox.order_items child WHERE child.tenant_id=item.tenant_id AND child.store_id=item.store_id AND child.parent_order_item_id=item.id) AS bundle
        FROM mbox.order_items item JOIN mbox.products product ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id AND product.id=item.product_id
        JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
        JOIN mbox.table_sessions session ON session.tenant_id=original.tenant_id AND session.store_id=original.store_id AND session.id=original.table_session_id
        JOIN mbox.tables venue ON venue.tenant_id=session.tenant_id AND venue.store_id=session.store_id AND venue.id=session.table_id
        WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3`,[...scope,input.itemId])).rows[0]
      if(!item)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原订单商品不存在')
      const units=(await tx.query<{id:string;index:number;productionState:string;heldByCaseId:string|null;stoppedByCaseId:string|null;operationallyStopped:boolean;inventoryEvidence:string}>(`SELECT id,unit_index AS index,production_state AS "productionState",held_by_case_id AS "heldByCaseId",stopped_by_case_id AS "stoppedByCaseId",operationally_stopped AS "operationallyStopped",inventory_evidence_state AS "inventoryEvidence"
        FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY unit_index`,[...scope,input.itemId])).rows
      const cases=(await tx.query<{id:string;requester:string;reason:string;created_at:string;delivered:boolean;pricing:import('../../src/shared/item-after-sales.js').ItemAfterSalesPricing|null}>(`SELECT DISTINCT target.id,target.requested_by_employee_id AS requester,target.reason,target.created_at::text,COALESCE((SELECT snapshot FROM mbox.item_after_sales_price_resolutions price WHERE price.tenant_id=target.tenant_id AND price.store_id=target.store_id AND price.case_id=target.id),mbox.quote_after_sales_price(target.id)) AS pricing,
        EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units part WHERE part.tenant_id=target.tenant_id AND part.store_id=target.store_id AND part.case_id=target.id AND mbox.quantity_unit_has_delivery(part.tenant_id,part.store_id,part.unit_id)) AS delivered
        FROM mbox.item_after_sales_cases target JOIN mbox.item_after_sales_case_units selected ON selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=target.id
        JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
        WHERE target.tenant_id=$1 AND target.store_id=$2 AND unit.order_item_id=$3 ORDER BY target.created_at::text,target.id`,[...scope,input.itemId])).rows
      const progress=[]
      for(let offset=0;offset<cases.length;offset+=100)progress.push(...await new ItemAfterSalesProgressRepository(tx).readMany(cases.slice(offset,offset+100).map(value=>value.id)))
      const payments=(await tx.query<{id:string;provider:string;amount:string;available:string}>(`SELECT payment.id,payment.provider,payment.amount_minor::text AS amount,
        GREATEST(0,payment.amount_minor-COALESCE((SELECT sum(refund.amount_minor) FROM mbox.order_refund_facts refund WHERE refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id AND refund.order_id=payment.order_id AND refund.payment_id=payment.id AND ${refundReservesAmountSql('refund')}),0))::text AS available
        FROM mbox.order_payment_facts payment WHERE payment.tenant_id=$1 AND payment.store_id=$2 AND payment.order_id=$3 AND payment.status IN ('succeeded','partially_refunded','refunded') ORDER BY payment.id`,[...scope,item.order_id])).rows
      const fundingFacts=(await tx.query<{settled:boolean;no_money:boolean}>(`SELECT COALESCE((SELECT sum(amount_minor) FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN ('succeeded','partially_refunded','refunded')),0)>=mbox.order_receivable_amount($1,$2,$3)
        AND NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('succeeded','partially_refunded','refunded','failed','closed')) AS settled,NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('failed','closed')) AS no_money`,[...scope,item.order_id])).rows[0]!
      const fundingState=fundingFacts.settled
      const limits=access.approvalLimits.filter(limit=>limit.code==='refund.approve'&&limit.currency==='CNY'&&limit.amountMinor!==null).map(limit=>limit.amountMinor!)
      const notices=(await tx.query<{id:string;case_id:string;station_code:string;instruction:string;phase:string|null;created_at:string;source_status:string|null;printed:boolean;print_failed:boolean}>(`SELECT notice.id,notice.case_id,notice.station_code,notice.instruction,message.payload->>'phase' AS phase,notice.created_at::text,source.status AS source_status,
        EXISTS(SELECT 1 FROM mbox.print_jobs job WHERE job.tenant_id=notice.tenant_id AND job.store_id=notice.store_id AND job.source_outbox_message_id=notice.source_outbox_message_id AND job.status='printed') AS printed,
        EXISTS(SELECT 1 FROM mbox.print_jobs job WHERE job.tenant_id=notice.tenant_id AND job.store_id=notice.store_id AND job.source_outbox_message_id=notice.source_outbox_message_id AND job.status IN ('failed','dead','cancelled')) AS print_failed
        FROM mbox.item_after_sales_notices notice LEFT JOIN mbox.outbox_messages message ON message.tenant_id=notice.tenant_id AND message.store_id=notice.store_id AND message.id=notice.source_outbox_message_id LEFT JOIN mbox.print_source_jobs source ON source.tenant_id=notice.tenant_id AND source.store_id=notice.store_id AND source.source_outbox_message_id=notice.source_outbox_message_id
        WHERE notice.tenant_id=$1 AND notice.store_id=$2 AND notice.case_id=ANY($3::uuid[]) AND notice.acknowledged_at IS NULL
        ORDER BY notice.created_at,notice.id LIMIT 100`,[...scope,cases.map(value=>value.id)])).rows
      const redeliveries=(await tx.query<{id:string;taskId:string;status:string;reason:string;pendingQuantity:number;pausedQuantity:number;deliveredQuantity:number;cancelledQuantity:number;selectedQuantity:number}>(`SELECT parent.id,parent.service_task_id AS "taskId",task.status,parent.reason,
        count(*) FILTER(WHERE part.outcome IS NULL)::int AS "pendingQuantity",
        count(*) FILTER(WHERE part.outcome IS NULL AND unit.held_by_case_id IS NOT NULL)::int AS "pausedQuantity",
        count(*) FILTER(WHERE part.outcome='delivered')::int AS "deliveredQuantity",
        count(*) FILTER(WHERE part.outcome='cancelled')::int AS "cancelledQuantity",count(*)::int AS "selectedQuantity"
        FROM mbox.quantity_redeliveries parent JOIN mbox.service_tasks task ON task.tenant_id=parent.tenant_id AND task.store_id=parent.store_id AND task.id=parent.service_task_id
        JOIN mbox.quantity_redelivery_units part ON part.tenant_id=parent.tenant_id AND part.store_id=parent.store_id AND part.redelivery_id=parent.id
        JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=part.tenant_id AND unit.store_id=part.store_id AND unit.id=part.unit_id
        WHERE parent.tenant_id=$1 AND parent.store_id=$2 AND parent.order_item_id=$3 GROUP BY parent.id,task.id ORDER BY parent.created_at,parent.id`,[...scope,input.itemId])).rows
      const pendingRedeliveryIds=(await tx.query<{unit_id:string}>(`SELECT part.unit_id FROM mbox.quantity_redelivery_units part JOIN mbox.order_item_quantity_units unit
        ON unit.tenant_id=part.tenant_id AND unit.store_id=part.store_id AND unit.id=part.unit_id
        WHERE part.tenant_id=$1 AND part.store_id=$2 AND unit.order_item_id=$3 AND part.outcome IS NULL`,[...scope,input.itemId])).rows.map(row=>row.unit_id)
      const latestPhysical=(await tx.query<{id:string;batch_id:string;unit_id:string;production_state:string;cancelled:boolean}>(`SELECT DISTINCT ON(part.unit_id) part.id,part.batch_id,part.unit_id,part.production_state,part.cancelled_at IS NOT NULL AS cancelled
        FROM mbox.quantity_remake_units part JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=part.tenant_id AND unit.store_id=part.store_id AND unit.id=part.unit_id
        WHERE part.tenant_id=$1 AND part.store_id=$2 AND unit.order_item_id=$3 ORDER BY part.unit_id,part.generation DESC`,[...scope,input.itemId])).rows
      const redeliveryAvailableQuantity=units.length?units.filter(unit=>(latestPhysical.find(value=>value.unit_id===unit.id)?.production_state??unit.productionState)==='delivered'&&latestPhysical.find(value=>value.unit_id===unit.id)?.cancelled!==true&&!unit.heldByCaseId&&!unit.operationallyStopped&&!pendingRedeliveryIds.includes(unit.id)).length:item.status==='delivered'?item.quantity:0
      let canConfirmRedelivery=false
      if(permissions.includes('kds.deliver')&&item.fulfillment_active&&['open','closing'].includes(item.session_status)){
        try{await assertEmployeeTableSessionReadAccess(tx,{employeeId:input.employeeId,tableSessionId:item.table_session_id,allTablePermissionCodes:['fulfillment.view_all','kds.deliver'],requiredPermissionCodes:['kds.deliver']});canConfirmRedelivery=true}
        catch(error){if(!(error instanceof EmployeeTableAccessDeniedError))throw error}
      }
      let canCancelRedelivery=false
      if(permissions.includes('service.execute')&&item.fulfillment_active&&['open','closing'].includes(item.session_status)){
        try{await assertEmployeeTableSessionReadAccess(tx,{employeeId:input.employeeId,tableSessionId:item.table_session_id,allTablePermissionCodes:['fulfillment.view_all','kds.deliver'],requiredPermissionCodes:['service.execute']});canCancelRedelivery=true}
        catch(error){if(!(error instanceof EmployeeTableAccessDeniedError))throw error}
      }
      const remakeTasks=(await tx.query<{id:string;station_code:string;status:string;remake_of_task_id:string|null;quantity_remake_batch_id:string|null}>('SELECT id,station_code,status,remake_of_task_id,quantity_remake_batch_id FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY created_at,id',[...scope,input.itemId])).rows
      const rootTask=remakeTasks.find(task=>!task.remake_of_task_id)
      const quantityEntryUnavailableReason=!units.length&&remakeTasks.some(task=>task.status==='failed'||task.remake_of_task_id&&!task.quantity_remake_batch_id)?'本行有原制作失败或旧重做记录，请从出品异常继续处理；尚未拆分数量，原异常入口保留。':null
      const materialReady=(unit:typeof units[number])=>unit.inventoryEvidence!=='unresolved'&&!unit.heldByCaseId&&!unit.operationallyStopped&&!pendingRedeliveryIds.includes(unit.id)
      const firstRemakeAvailableQuantity=units.length?units.filter(unit=>materialReady(unit)&&unit.productionState!=='unmade'&&!latestPhysical.some(part=>part.unit_id===unit.id)).length:rootTask&&(['preparing','ready'].includes(rootTask.status)||item.status==='delivered')?item.quantity:0
      let canManageRemake=false
      if(this.acceptNewRequests&&rootTask&&rootTask.status!=='failed'&&!item.bundle_header&&item.fulfillment_active&&['open','closing'].includes(item.session_status)&&permissions.includes('kds.exception.manage')&&resolveFulfillmentAllowedStations(access.dataScopes).includes(rootTask.station_code as 'bar'|'kitchen')&&input.staffSessionId&&input.deviceAccessLeaseId){
        const valid=await hasActiveKdsSession({transaction:tx,employeeId:input.employeeId,staffSessionId:input.staffSessionId,deviceAccessLeaseId:input.deviceAccessLeaseId})
        canManageRemake=valid
      }
      const remakes=(await tx.query<{id:string;taskId:string;reason:string;createdAt:string;total:number;unmade:number;started:number;ready:number;delivered:number;cancelled:number;held:number}>(`SELECT batch.id,batch.kds_task_id AS "taskId",batch.reason,batch.created_at::text AS "createdAt",count(*)::int AS total,
        count(*) FILTER(WHERE part.cancelled_at IS NULL AND part.production_state='unmade')::int AS unmade,
        count(*) FILTER(WHERE part.cancelled_at IS NULL AND part.production_state='started')::int AS started,
        count(*) FILTER(WHERE part.cancelled_at IS NULL AND part.production_state='ready')::int AS ready,
        count(*) FILTER(WHERE part.cancelled_at IS NULL AND part.production_state='delivered')::int AS delivered,
        count(*) FILTER(WHERE part.cancelled_at IS NOT NULL)::int AS cancelled,
        count(*) FILTER(WHERE part.cancelled_at IS NULL AND unit.held_by_case_id IS NOT NULL)::int AS held
        FROM mbox.quantity_remake_batches batch JOIN mbox.quantity_remake_units part ON part.tenant_id=batch.tenant_id AND part.store_id=batch.store_id AND part.batch_id=batch.id
        JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=part.tenant_id AND unit.store_id=part.store_id AND unit.id=part.unit_id
        WHERE batch.tenant_id=$1 AND batch.store_id=$2 AND batch.order_item_id=$3 GROUP BY batch.id ORDER BY batch.created_at,batch.id`,[...scope,input.itemId])).rows.map(batch=>({...batch,
          successorAvailableQuantity:latestPhysical.filter(part=>part.batch_id===batch.id&&(part.cancelled||part.production_state!=='unmade')&&units.some(unit=>unit.id===part.unit_id&&materialReady(unit))).length}))
      const originalReturn=await readPackagedReturnEligibility(tx,units.filter(unit=>!latestPhysical.some(part=>part.unit_id===unit.id)).map(unit=>unit.id))
      const remakeReturn=await readPackagedReturnEligibility(tx,latestPhysical.map(part=>part.id),true)
      const unitsWithReturn=units.map(unit=>{const latest=latestPhysical.find(part=>part.unit_id===unit.id)
        return {...unit,returnEligibility:latest&&latest.production_state==='unmade'?{canReturn:true,releaseOnly:true,reason:'新批仍未制作，仅停止新批并释放其预留，不增加实物回库流水。'}:latest?remakeReturn.get(latest.id):originalReturn.get(unit.id)}})
      return {quantityEntryUnavailableReason,redeliveries,redeliveryAvailableQuantity,canConfirmRedelivery,canCancelRedelivery,
        remakes,canManageRemake,firstRemakeAvailableQuantity,originalKdsTaskId:rootTask?.id??null,

        canRequestRedelivery:this.acceptNewRequests&&permissions.includes('refund.request')&&!item.bundle_header&&item.fulfillment_active&&['open','closing'].includes(item.session_status)&&redeliveryAvailableQuantity>0,
        item:{id:item.id,orderId:item.order_id,name:item.name,quantity:item.quantity,originalAmountMinor:Number(item.original_amount),unitPriceMinor:Number(item.unit_price),status:item.status,orderPublicId:item.order_public_id,tableCode:item.table_code,tableSessionId:item.table_session_id,guestCount:item.guest_count,bundle:item.bundle,includedInBundle:item.included_in_bundle},
        fundingSources:payments.map(payment=>({paymentId:payment.id,provider:payment.provider,originalOrderAmountMinor:Number(payment.amount),availableMinor:Number(payment.available)})),
        canRequest:!quantityEntryUnavailableReason&&this.acceptNewRequests&&permissions.includes('refund.request')&&!item.bundle_header&&item.fulfillment_active&&['open','closing'].includes(item.session_status),
        canExecuteRefund:permissions.includes('refund.execute'),canAcknowledgeNotices:permissions.includes('refund.request'),
        canReceive:permissions.includes('refund.request')&&permissions.includes('inventory.receive'),canRecordUsed:permissions.includes('refund.request')&&permissions.includes('inventory.waste'),
        units:unitsWithReturn,cases:progress.map(record=>{const original=cases.find(value=>value.id===record.caseId)!
          const current={...record,amountMinor:original.pricing?.refundAmountMinor??record.amountMinor}
          const unpaidMadeDecision=current.kind==='unpaid_stop'&&current.madeQuantity>0&&permissions.includes(original.delivered?'order.settle_exception':'order.cancel_unpaid')
          const requiresFundingChoice=current.kind!=='unpaid_stop'&&current.refunds.length===0&&current.amountMinor!==null&&current.amountMinor>0&&(fundingState||Boolean(original.pricing))&&payments.length>1&&payments.reduce((sum,value)=>sum+Number(value.available),0)>=current.amountMinor
          const canPrepareSinglePayment=current.kind!=='unpaid_stop'&&current.refunds.length===0&&current.amountMinor!==null&&current.amountMinor>0&&(fundingState||Boolean(original.pricing))&&payments.length===1&&Number(payments[0]!.available)>=current.amountMinor
          return {...current,pricing:original.pricing??undefined,unpaidPaymentChanged:current.kind==='unpaid_stop'&&current.status==='requested'&&!current.moneyComplete&&!fundingFacts.no_money,refunds:current.refunds.map(refund=>({...refund,canRetry:refund.canRetry&&permissions.includes('refund.execute')})),canResolveUnpaid:current.kind==='payment_review'&&current.status==='requested'&&(current.amountMinor!==null||item.has_order_cancellation)&&current.madeQuantity===0&&current.inventoryReviewQuantity===0&&current.refunds.length===0&&fundingFacts.no_money&&permissions.includes('refund.request'),notices:notices.filter(notice=>notice.case_id===current.caseId).map(notice=>({id:notice.id,stationCode:notice.station_code,instruction:notice.instruction,phase:notice.phase,createdAt:notice.created_at,
              printState:notice.print_failed||['dead','skipped'].includes(notice.source_status??'')?'attention':notice.printed?'printed':'pending'})),requiresFundingChoice,paymentAllocationReview:current.kind!=='unpaid_stop'&&current.amountMinor!==null&&current.amountMinor>0&&current.refunds.length===0,reason:original.reason,createdAt:original.created_at,
            canApprove:current.status==='requested'&&unpaidMadeDecision&&current.amountMinor!==null&&current.inventoryReviewQuantity===0&&(!item.bundle||Boolean(original.pricing))&&fundingFacts.no_money||current.status==='requested'&&current.kind!=='unpaid_stop'&&!(current.kind==='payment_review'&&fundingFacts.no_money)&&original.requester!==input.employeeId&&permissions.includes('refund.approve')&&current.amountMinor!==null&&(current.amountMinor===0||current.refunds.length>0||requiresFundingChoice||canPrepareSinglePayment)&&limits.length>0&&current.amountMinor<=Math.max(...limits),
            canReject:current.status==='requested'&&(unpaidMadeDecision||current.kind!=='unpaid_stop'&&!(current.kind==='payment_review'&&fundingFacts.no_money)&&original.requester!==input.employeeId&&permissions.includes('refund.approve')),
            canWithdraw:current.status==='requested'&&original.requester===input.employeeId&&permissions.includes('refund.request'),
            canReplace:this.acceptNewRequests&&item.session_status==='open'&&permissions.includes('order.create')&&permissions.includes('refund.request')&&(!current.replacementOrder||current.replacementOrder.status==='cancelled')&&!current.revisedByCaseId&&['requested','approved','completed'].includes(current.status)&&current.heldQuantity+current.stoppedQuantity>0,
            canRevise:this.acceptNewRequests&&current.status==='requested'&&original.requester===input.employeeId&&permissions.includes('refund.request')&&item.fulfillment_active&&current.heldQuantity===current.selectedQuantity&&current.refunds.every(refund=>refund.status==='requested'),
            canResume:['rejected','withdrawn'].includes(current.status)&&current.heldQuantity>0&&permissions.includes('refund.request')&&item.fulfillment_active&&['open','closing'].includes(item.session_status),
            canDisposeMade:current.status==='approved'||(['rejected','withdrawn'].includes(current.status)&&(item.session_status==='closed'||item.has_order_cancellation)),
            canDisposeHeldUnmade:['rejected','withdrawn'].includes(current.status)&&(item.session_status==='closed'||item.has_order_cancellation),
            resumeUnavailableReason:['rejected','withdrawn'].includes(current.status)&&current.heldQuantity>0&&(!item.fulfillment_active||!['open','closing'].includes(item.session_status))?'原桌次或商品已结束，不能继续原商品；原售后记录仍可核对。':null,
          }
        })}
    },{isolation:'repeatable-read',readOnly:true})
  }
}
