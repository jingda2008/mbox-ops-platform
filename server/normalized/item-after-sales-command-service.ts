import {NormalizedCommandExecutor,type JsonCodec,type JsonValue} from './command-executor.js'
import type {ScopedTransaction,StoreScope} from './transaction-runner.js'
import {assertEmployeeEffectivePermission} from './employee-table-access.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {lockQuantityOrder} from './item-quantity-lock.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemQuantityRefundRetryRepository} from './item-quantity-refund-retry-repository.js'
import {ItemQuantityRefundRepository} from './item-quantity-refund-repository.js'
import {ItemQuantityReceivableRepository} from './item-quantity-receivable-repository.js'
import {ItemUnitInventoryRepository} from './item-unit-inventory-repository.js'
import {ItemAfterSalesProgressRepository} from './item-after-sales-progress-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {assertUnpaidMadeStopPermission} from './item-unpaid-made-stop.js'

type Progress=Awaited<ReturnType<ItemAfterSalesProgressRepository['read']>>
interface Metadata {scope:Readonly<StoreScope>;employeeId:string;businessDate:string;idempotencyKey:string;reason:string}
/** Must persist KDS/delivery aggregates and station notifications in this same
 * transaction. Never call a printer or payment provider inside this callback. */
export interface QuantityOperatingEffects {
  apply(tx:ScopedTransaction,input:{caseId:string;employeeId:string;action:'request'|'approved'|'rejected'|'withdrawn'|'resume'|'physical'|'payment_resolved';eventKey:string;unitIds?:readonly string[];reason?:string}):Promise<void>
}

/** Coordinates quantity effects and receivables atomically. Production admits
 * new requests only through the rollout gate; committed work remains recoverable. */
export class ItemAfterSalesCommandService {
  constructor(private readonly commands:NormalizedCommandExecutor,private readonly effects:QuantityOperatingEffects,private readonly acceptNewRequests=true){}

  request(input:Metadata&{orderItemId:string;quantity:number}){
    return this.execute(input,'request',{orderItemId:input.orderItemId,quantity:input.quantity},tx=>this.createRequest(tx,input))
  }

  private async createRequest(tx:ScopedTransaction,input:Metadata&{orderItemId:string;quantity:number},preferredUnitIds?:readonly string[]){
      // The executor restores a committed original result before entering this
      // handler. A rollout pause blocks new work without stranding old commands.
      if(!this.acceptNewRequests)throw new ItemQuantityConflict('QUANTITY_BATCH_NOT_ENABLED','暂不新增单品售后；原申请可继续处理或恢复')
      await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.request')
      const {orderId}=await lockQuantityOrder(tx,{kind:'item',id:input.orderItemId},true)
      const scope=[tx.scope.tenantId,tx.scope.storeId]
      const facts=(await tx.query<{uncertain:boolean;captured:boolean;inactive:boolean;bundle:boolean}>(`SELECT
        EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('failed','closed','succeeded','partially_refunded','refunded')) AS uncertain,
        EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN ('succeeded','partially_refunded','refunded')) AS captured,
        original.status='cancelled' OR original.fulfillment_state IN ('awaiting_payment','released','cancelled') AS inactive,
        EXISTS(SELECT 1 FROM mbox.order_items WHERE tenant_id=$1 AND store_id=$2 AND parent_order_item_id=$4) AS bundle
        FROM mbox.orders original WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope,orderId,input.orderItemId])).rows[0]!
      // A bundle header must not pause only its accounting line. Individual
      // operational children may pause, with their amount remaining unknown.
      if(facts.inactive||facts.bundle)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','此单涉及待付款激活或套餐组成，请保留原处理入口，当前数量链路尚未接管')
      const kind=facts.uncertain?'payment_review':facts.captured?'paid_return':'unpaid_stop'
      // Normal unmade item stops belong to the all-staff after-sales entry.
      // Whole-order cancellation and made-goods exceptions keep their own permissions.
      const created=await new ItemQuantityRepository(tx).hold({orderItemId:input.orderItemId,quantity:input.quantity,kind,employeeId:input.employeeId,businessDate:input.businessDate,reason:input.reason,preferredUnitIds,allowMadeUnpaidHold:true})
      const pricedUnpaid=kind==='unpaid_stop'?(await tx.query<{quote:Record<string,unknown>|null}>('SELECT mbox.prepare_after_sales_price($1) AS quote',[created.caseId])).rows[0]?.quote:null
      if(pricedUnpaid){
        const units=await new ItemQuantityRepository(tx).readUnits(input.orderItemId)
        if(created.madeReview===0&&units.filter(unit=>created.unitIds.includes(unit.id)).every(unit=>unit.inventory_evidence_state!=='unresolved')){
          await tx.query(`UPDATE mbox.item_after_sales_cases SET status='approved',decided_by_employee_id=$4,decision_reason=$5,decided_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope,created.caseId,input.employeeId,'未付未制作，按已确认套餐单点规则停止'])
          await new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId:input.orderItemId,unitIds:created.unitIds,employeeId:input.employeeId,caseId:created.caseId})
        }
      }else if(kind==='unpaid_stop'&&created.amountMinor!==null&&created.madeReview===0){
        const units=await new ItemQuantityRepository(tx).readUnits(input.orderItemId)
        if(units.filter(unit=>created.unitIds.includes(unit.id)).every(unit=>unit.inventory_evidence_state!=='unresolved')){
          await new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId:input.orderItemId,unitIds:created.unitIds,employeeId:input.employeeId,caseId:created.caseId})
          await new ItemQuantityReceivableRepository(tx).recordUnpaidReduction({caseId:created.caseId,employeeId:input.employeeId,businessDate:input.businessDate})
        }
      }else if(kind==='paid_return')await new ItemQuantityRefundRepository(tx).prepare(created.caseId)
      return created.caseId
  }

  revise(input:Metadata&{caseId:string;quantity:number}){
    return this.execute(input,'revision',{caseId:input.caseId,quantity:input.quantity},async tx=>{
      if(!this.acceptNewRequests)throw new ItemQuantityConflict('QUANTITY_BATCH_NOT_ENABLED','暂不新增修改版本；原申请仍可继续处理或恢复')
      await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.request')
      await lockQuantityOrder(tx,{kind:'case',id:input.caseId},true)
      const current=await new ItemAfterSalesProgressRepository(tx).read(input.caseId)
      const original=(await tx.query<{requester:string;item_id:string}>(`SELECT target.requested_by_employee_id AS requester,min(unit.order_item_id::text) AS item_id
        FROM mbox.item_after_sales_cases target JOIN mbox.item_after_sales_case_units selected ON selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=target.id
        JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
        WHERE target.tenant_id=$1 AND target.store_id=$2 AND target.id=$3 GROUP BY target.id HAVING count(DISTINCT unit.order_item_id)=1`,[tx.scope.tenantId,tx.scope.storeId,input.caseId])).rows[0]
      if(!original||original.requester!==input.employeeId||current.status!=='requested'||current.heldQuantity!==current.selectedQuantity||current.refunds.some(refund=>refund.status!=='requested'))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','只能修改本人尚未审核执行、仍暂停的原申请；请读回原结果')
      const repository=new ItemQuantityRepository(tx),units=await repository.readUnits(original.item_id)
      const held=units.filter(unit=>unit.held_by_case_id===input.caseId&&!unit.operationally_stopped).sort((a,b)=>Number(a.production_state!=='unmade')-Number(b.production_state!=='unmade')||a.unit_index-b.unit_index)
      if(held.length!==current.selectedQuantity)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原商品已结束，不能修改为新的申请')
      if(!Number.isSafeInteger(input.quantity)||input.quantity<1||input.quantity>999)throw new ItemQuantityConflict('QUANTITY_INVALID','请选择修改后的实际份数')
      const transferred=held.slice(0,input.quantity).map(unit=>unit.id),remaining=held.slice(input.quantity).map(unit=>unit.id)
      const decision={caseId:input.caseId,employeeId:input.employeeId,decision:'withdrawn' as const,reason:'申请已修改，旧申请停止审核；原商品不自动恢复'}
      if(current.kind==='unpaid_stop')await repository.decide(decision)
      else await new ItemQuantityRefundRepository(tx).decide(decision)
      // Only the units retained by the new version change ownership, within this
      // transaction. Removed units remain held by the withdrawn original case.
      const released=await tx.query(`UPDATE mbox.order_item_quantity_units SET held_by_case_id=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND store_id=$2 AND held_by_case_id=$3 AND id=ANY($4::uuid[]) AND NOT operationally_stopped`,[tx.scope.tenantId,tx.scope.storeId,input.caseId,transferred])
      if(released.rowCount!==transferred.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原申请份数刚刚变化，请读取当前处理结果')
      const caseId=await this.createRequest(tx,{...input,orderItemId:original.item_id},transferred)
      await tx.query(`INSERT INTO mbox.item_after_sales_case_revisions(tenant_id,store_id,previous_case_id,replacement_case_id,employee_id) VALUES($1,$2,$3,$4,$5)`,[tx.scope.tenantId,tx.scope.storeId,input.caseId,caseId,input.employeeId])
      if(remaining.length)await this.effects.apply(tx,{caseId:input.caseId,employeeId:input.employeeId,action:'withdrawn',eventKey:input.idempotencyKey,unitIds:remaining,reason:'修改后未纳入新申请的份数仍暂停，等待明确继续'})
      return caseId
    })
  }

  decide(input:Metadata&{caseId:string;decision:'approved'|'rejected'|'withdrawn';funding?:readonly {paymentId:string;amountMinor:number}[]}){
    return this.execute(input,input.decision,{caseId:input.caseId,...(input.funding?{funding:[...input.funding].sort((a,b)=>a.paymentId.localeCompare(b.paymentId))}:{})},async tx=>{
      await lockQuantityOrder(tx,{kind:'case',id:input.caseId},true)
      let current=await new ItemAfterSalesProgressRepository(tx).read(input.caseId)
      if(input.decision==='approved'&&current.status==='requested'&&current.kind!=='unpaid_stop'){
        await new ItemQuantityRefundRepository(tx).prepare(input.caseId,input.funding)
        current=await new ItemAfterSalesProgressRepository(tx).read(input.caseId)
      }
      if(input.decision==='withdrawn')await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.request')
      else if(current.kind==='unpaid_stop')await assertUnpaidMadeStopPermission(tx,input.caseId,input.employeeId)
      else{
        await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.approve')
        // The limit applies to the complete case, not each split payment.
        const access=await new StaffAccessRepository(tx).resolve(input.employeeId)
        const limits=access.approvalLimits.filter(limit=>limit.code==='refund.approve'&&limit.currency==='CNY'&&limit.amountMinor!==null).map(limit=>limit.amountMinor!)
        if(input.decision==='approved'&&(!limits.length||current.amountMinor===null||current.amountMinor>Math.max(...limits)))throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','所选原成交金额尚未确认或超过当前审核额度')
      }
      if(current.kind==='unpaid_stop'){
        if(input.decision==='approved'){
          if(current.status!=='requested'||current.amountMinor===null||current.inventoryReviewQuantity>0)throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','请先核对所选原成交金额与库存记录，尚未免收')
          const unresolved=(await tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('failed','closed')) AS found`,[tx.scope.tenantId,tx.scope.storeId,current.orderId])).rows[0]!.found
          if(unresolved)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原付款已有资金事实或待确认结果，不按未付款免收')
          await tx.query(`UPDATE mbox.item_after_sales_cases SET status='approved',decided_by_employee_id=$4,decision_reason=$5,decided_at=clock_timestamp()
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[tx.scope.tenantId,tx.scope.storeId,input.caseId,input.employeeId,input.reason.trim()])
          const unmade=(await tx.query<{id:string;order_item_id:string}>(`SELECT id,order_item_id FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND held_by_case_id=$3 AND production_state='unmade' ORDER BY order_item_id,unit_index`,[tx.scope.tenantId,tx.scope.storeId,input.caseId])).rows
          for(const itemId of new Set(unmade.map(unit=>unit.order_item_id)))await new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId,unitIds:unmade.filter(unit=>unit.order_item_id===itemId).map(unit=>unit.id),employeeId:input.employeeId,caseId:input.caseId})
          const pricing=(await tx.query('SELECT 1 FROM mbox.item_after_sales_price_resolutions WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3',[tx.scope.tenantId,tx.scope.storeId,input.caseId])).rowCount
          if(!pricing)await new ItemQuantityReceivableRepository(tx).recordUnpaidReduction({caseId:input.caseId,employeeId:input.employeeId,businessDate:input.businessDate})
        }else await new ItemQuantityRepository(tx).decide(input)
      }else{
        if(input.decision==='approved'&&current.status==='requested')await new ItemQuantityRefundRepository(tx).prepare(input.caseId,input.funding)
        await new ItemQuantityRefundRepository(tx).decide(input)
      }
      return input.caseId
    })
  }

  resume(input:Metadata&{caseId:string}){
    return this.execute(input,'resume',{caseId:input.caseId},async tx=>{
      await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.request')
      await new ItemQuantityRepository(tx).resume(input)
      return input.caseId
    })
  }

  disposeMade(input:Metadata&{caseId:string;unitIds:readonly string[];disposition:'used_loss'|'returned_unopened';unopenedReceived:boolean}){
    const unitIds=[...input.unitIds].sort()
    if(!unitIds.length||unitIds.length>999||new Set(unitIds).size!==unitIds.length)throw new ItemQuantityConflict('QUANTITY_INVALID','请选择实际处理的份数')
    return this.execute(input,'physical',{caseId:input.caseId,unitIds,disposition:input.disposition,unopenedReceived:input.unopenedReceived},async tx=>{
      await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.request')
      await assertEmployeeEffectivePermission(tx,input.employeeId,input.disposition==='returned_unopened'?'inventory.receive':'inventory.waste')
      await lockQuantityOrder(tx,{kind:'case',id:input.caseId},true)
      const units=(await tx.query<{id:string;order_item_id:string}>(`SELECT unit.id,unit.order_item_id
        FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit
          ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
        WHERE selected.tenant_id=$1 AND selected.store_id=$2 AND selected.case_id=$3 AND unit.id=ANY($4::uuid[])
        ORDER BY unit.order_item_id,unit.unit_index`,[tx.scope.tenantId,tx.scope.storeId,input.caseId,unitIds])).rows
      if(units.length!==unitIds.length)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','所选商品不属于原售后申请')
      for(const itemId of new Set(units.map(unit=>unit.order_item_id)))await new ItemUnitInventoryRepository(tx).disposeMadeUnits({
        itemId,unitIds:units.filter(unit=>unit.order_item_id===itemId).map(unit=>unit.id),employeeId:input.employeeId,caseId:input.caseId,
        disposition:input.disposition,unopenedReceived:input.unopenedReceived,reason:input.reason,
      })
      return input.caseId
    },unitIds)
  }

  acknowledgeNotices(input:Metadata&{caseId:string;noticeIds:readonly string[]}){
    const noticeIds=[...input.noticeIds].sort()
    if(!noticeIds.length||noticeIds.length>100||new Set(noticeIds).size!==noticeIds.length)throw new ItemQuantityConflict('QUANTITY_INVALID','请选择已与岗位核实的通知')
    return this.execute(input,'notice_ack',{caseId:input.caseId,noticeIds},async tx=>{
      await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.request')
      await lockQuantityOrder(tx,{kind:'case',id:input.caseId})
      const notices=await tx.query(`SELECT id FROM mbox.item_after_sales_notices WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3 AND id=ANY($4::uuid[]) FOR UPDATE`,[tx.scope.tenantId,tx.scope.storeId,input.caseId,noticeIds])
      if(notices.rowCount!==noticeIds.length)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','所选通知不属于原商品申请，请重新读取')
      await tx.query(`UPDATE mbox.item_after_sales_notices SET acknowledged_by_employee_id=$5,acknowledged_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3 AND id=ANY($4::uuid[]) AND acknowledged_at IS NULL`,[tx.scope.tenantId,tx.scope.storeId,input.caseId,noticeIds,input.employeeId])
      // Acknowledges only the versions explicitly shown to the employee; a later
      // stop/resume notice is neither swallowed nor implicitly acknowledged.
      return input.caseId
    })
  }

  resolveUnpaid(input:Metadata&{caseId:string}){
    return this.execute(input,'payment_resolved',{caseId:input.caseId},async tx=>{
      await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.request')
      await lockQuantityOrder(tx,{kind:'case',id:input.caseId},true)
      const current=await new ItemAfterSalesProgressRepository(tx).read(input.caseId)
      if(current.status==='completed'&&current.kind==='unpaid_stop')return input.caseId
      const wholeCancelled=(await tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.order_cancellation_events event JOIN mbox.orders original
        ON original.tenant_id=event.tenant_id AND original.store_id=event.store_id AND original.id=event.order_id
        WHERE event.tenant_id=$1 AND event.store_id=$2 AND event.order_id=$3 AND original.status='cancelled') AS found`,[tx.scope.tenantId,tx.scope.storeId,current.orderId])).rows[0]!.found
      if(current.kind!=='payment_review'||current.status!=='requested'||current.madeQuantity>0||current.inventoryReviewQuantity>0||current.refunds.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','请核对原申请的付款、成交金额及实物情况，未自动取消应收')
      const unresolved=(await tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('failed','closed')) AS found`,[tx.scope.tenantId,tx.scope.storeId,current.orderId])).rows[0]!.found
      if(unresolved)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原付款仍有已收或未确认结果，请先查询原付款，不按未付停止')
      await tx.query(`UPDATE mbox.item_after_sales_cases SET resolved_kind='unpaid_stop' WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[tx.scope.tenantId,tx.scope.storeId,input.caseId])
      const pricing=wholeCancelled?null:(await tx.query<{quote:Record<string,unknown>|null}>('SELECT mbox.prepare_after_sales_price($1) AS quote',[input.caseId])).rows[0]?.quote
      if(!wholeCancelled&&!pricing&&current.amountMinor===null)throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','原套餐单价或逐套归属仍待核对，保留暂停申请')
      if(pricing)await tx.query(`UPDATE mbox.item_after_sales_cases SET status='approved',decided_by_employee_id=$4,decision_reason=$5,decided_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[tx.scope.tenantId,tx.scope.storeId,input.caseId,input.employeeId,'付款已关闭，按原单点规则停止未制作套餐商品'])
      const units=(await tx.query<{id:string;order_item_id:string}>(`SELECT id,order_item_id FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND held_by_case_id=$3 ORDER BY order_item_id,unit_index`,[tx.scope.tenantId,tx.scope.storeId,input.caseId])).rows
      for(const itemId of new Set(units.map(unit=>unit.order_item_id)))await new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId,unitIds:units.filter(unit=>unit.order_item_id===itemId).map(unit=>unit.id),caseId:input.caseId,employeeId:input.employeeId})
      if(wholeCancelled){
        const completed=(await tx.query<{done:boolean}>('SELECT mbox.complete_quantity_case_from_order_cancellation($1) AS done',[input.caseId])).rows[0]?.done
        if(!completed)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原整单取消或对应实物证据仍待核对，尚未结束原申请')
      }else if(!pricing)await new ItemQuantityReceivableRepository(tx).recordUnpaidReduction({caseId:input.caseId,employeeId:input.employeeId,businessDate:input.businessDate})
      return input.caseId
    })
  }

  retryRefund(input:Metadata&{caseId:string;refundId:string}){
    return this.execute(input,'refund_retry',{caseId:input.caseId,refundId:input.refundId},async tx=>{
      await assertEmployeeEffectivePermission(tx,input.employeeId,'refund.execute')
      await new ItemQuantityRefundRetryRepository(tx).retry(input)
      return input.caseId
    })
  }

  private execute(input:Metadata,action:'request'|'approved'|'rejected'|'withdrawn'|'resume'|'physical'|'notice_ack'|'payment_resolved'|'refund_retry'|'revision',selection:Record<string,JsonValue>,handler:(tx:ScopedTransaction)=>Promise<string>,unitIds?:readonly string[]){
    if(input.reason.trim().length<2||input.reason.length>1000)throw new ItemQuantityConflict('QUANTITY_INVALID','请填写简短的实际原因')
    return this.commands.execute({scope:input.scope,operationScope:`item.after-sales.${action}`,idempotencyKey:input.idempotencyKey,
      // Business date is assigned when the command first commits. A next-day
      // retry with the same action must read that result, never create a new case.
      requestFingerprint:JSON.stringify({employeeId:input.employeeId,action,...selection,reason:input.reason.trim()}),resultCodec:progressCodec},async tx=>{
      const caseId=await handler(tx)
      if(action!=='notice_ack'&&action!=='refund_retry')await this.effects.apply(tx,{caseId,employeeId:input.employeeId,action:action==='revision'?'request':action,eventKey:input.idempotencyKey,unitIds,reason:input.reason.trim()})
      const result=await new ItemAfterSalesProgressRepository(tx).synchronize(caseId)
      return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:input.employeeId},action:`item_after_sales.${action}`,objectType:'item_after_sales_case',objectId:caseId,businessDate:input.businessDate,reason:input.reason.trim(),metadata:{orderId:result.orderId,quantity:result.selectedQuantity,...(action==='refund_retry'?{previousRefundId:selection.refundId!}:action==='revision'?{previousCaseId:selection.caseId!}:{})}}],outboxMessages:[]}
    })
  }
}

const progressCodec:JsonCodec<Progress>={
  encode:value=>value,
  decode:value=>{
    if(!value||typeof value!=='object'||!('caseId' in value)||typeof value.caseId!=='string'||!('selectedQuantity' in value)||typeof value.selectedQuantity!=='number')throw new Error('Stored quantity command result is invalid')
    return value as Progress
  },
}
