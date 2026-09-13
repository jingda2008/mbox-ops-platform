import {priceBrokenBundle,pricePlainItemStop} from './item-after-sales-price-policy.js'
import {refundReservesAmountSql} from './refund-attempt-sql.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {lockQuantityOrder} from './item-quantity-lock.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {ItemUnitInventoryRepository} from './item-unit-inventory-repository.js'
import {RefundRepository} from './refund-repository.js'

/** Internal financial part of the quantity coordinator. Its public caller must
 * apply existing request/approval permissions and append the command audit.
 * Multi-payment choices require their original allocation; no channel order is invented. */
export class ItemQuantityRefundRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}

  async prepare(caseId:string,funding?:readonly {paymentId:string;amountMinor:number}[]){
    const {orderId}=await lockQuantityOrder(this.tx,{kind:'case',id:caseId},true)
    const pricing=(await this.tx.query<{quote:Record<string,unknown>|null}>('SELECT mbox.prepare_after_sales_price($1) AS quote',[caseId])).rows[0]?.quote??null
    if(pricing){
      const paid={paidMinor:Number(pricing.availablePaidMinor),succeededRefundMinor:0,reservedRefundMinor:0}
      const expected=pricing.policy==='broken_bundle'?priceBrokenBundle({...paid,components:pricing.components as Array<{originalSinglePriceMinor:number|null;retainedQuantity:number}>,otherEffectiveChargesMinor:Number(pricing.otherEffectiveChargesMinor)}).refundAmountMinor
        :pricePlainItemStop({...paid,selectedOriginalMinor:Number(pricing.selectedOriginalMinor)}).refundAmountMinor
      if(expected!==Number(pricing.refundAmountMinor))throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','原计价结果不一致，请保留暂停商品并核对')
    }
    const target=await this.case(caseId)
    const linked=await this.linked(caseId)
    if(linked.length){
      if(funding){
        const assigned=(await this.tx.query<{paymentId:string;amountMinor:string}>(`SELECT refund.payment_id AS "paymentId",refund.amount_minor::text AS "amountMinor" FROM mbox.item_after_sales_case_refunds link JOIN mbox.refunds refund ON refund.tenant_id=link.tenant_id AND refund.store_id=link.store_id AND refund.id=link.refund_id WHERE link.tenant_id=$1 AND link.store_id=$2 AND link.case_id=$3 AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries retry WHERE retry.tenant_id=link.tenant_id AND retry.store_id=link.store_id AND retry.previous_refund_id=link.refund_id) ORDER BY refund.payment_id`,[...this.scope,caseId])).rows
        if(JSON.stringify(assigned.map(value=>({paymentId:value.paymentId,amountMinor:Number(value.amountMinor)})))!==JSON.stringify([...funding].sort((a,b)=>a.paymentId.localeCompare(b.paymentId))))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原申请已绑定付款分摊，不能替换原退款来源')
      }
      return {status:'prepared' as const,refundIds:linked.map(refund=>refund.id),replayed:true}
    }
    if(target.status!=='requested'||target.kind==='unpaid_stop')throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','此申请不需要新建退款或已经处理')
    if(target.amount_minor===null)return {status:'price_review' as const,refundIds:[],replayed:false}
    if(Number(target.amount_minor)===0)return {status:'no_money_due' as const,refundIds:[],replayed:false}
    const items=(await this.tx.query<{id:string;known:number;selected:number;amount:string|null;original_quantity:number;original_amount:string;bundle:boolean}>(`SELECT unit.order_item_id AS id,count(unit.original_amount_minor)::int AS known,count(*)::int AS selected,sum(unit.original_amount_minor)::text AS amount,
      item.quantity AS original_quantity,item.total_amount_minor::text AS original_amount,
      item.parent_order_item_id IS NOT NULL OR EXISTS(SELECT 1 FROM mbox.order_items child WHERE child.tenant_id=item.tenant_id AND child.store_id=item.store_id AND child.parent_order_item_id=item.id) AS bundle
      FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
      JOIN mbox.order_items item ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
      WHERE selected.tenant_id=$1 AND selected.store_id=$2 AND selected.case_id=$3 GROUP BY unit.order_item_id,item.id`,[...this.scope,caseId])).rows
    if(items.length!==1)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原申请商品归属尚未核对')
    const source=items[0]!
    if(source.bundle&&!pricing)return {status:'price_review' as const,refundIds:[],replayed:false}
    const originalAmount=source.known===source.selected?source.amount:source.selected===source.original_quantity?source.original_amount:null
    if(originalAmount===null&&!pricing)return {status:'price_review' as const,refundIds:[],replayed:false}
    if(!pricing&&BigInt(originalAmount!)!==BigInt(target.amount_minor))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','申请金额与所选份数原成交事实不符')
    const unresolved=(await this.tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('succeeded','partially_refunded','refunded','failed','closed')) AS found`,[...this.scope,orderId])).rows[0]?.found
    if(unresolved)return {status:'payment_review' as const,refundIds:[],replayed:false}
    const fullyCollected=(await this.tx.query<{settled:boolean}>(`SELECT COALESCE((SELECT sum(amount_minor) FROM mbox.order_payment_facts
      WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN ('succeeded','partially_refunded','refunded')),0)>=mbox.order_receivable_amount($1,$2,$3) AS settled`,[...this.scope,orderId])).rows[0]?.settled
    // Cancelling a partly paid order needs the store's choice of offset vs refund.
    // Pausing remains available, but this path must not silently choose that policy.
    if(!fullyCollected&&!pricing)return {status:'payment_review' as const,refundIds:[],replayed:false}
    const payments=(await this.tx.query<{id:string;payable_kind:string;amount_minor:string;reserved:string}>(`SELECT payment.id,payment.payable_kind,payment.amount_minor::text,
      COALESCE((SELECT sum(refund.amount_minor) FROM mbox.order_refund_facts refund WHERE refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
        AND refund.payment_id=payment.id AND refund.order_id=payment.order_id AND ${refundReservesAmountSql('refund')}),0)::text AS reserved
      FROM mbox.order_payment_facts payment WHERE payment.tenant_id=$1 AND payment.store_id=$2 AND payment.order_id=$3
        AND payment.status IN ('succeeded','partially_refunded','refunded') ORDER BY payment.id`,[...this.scope,orderId])).rows
    // order_payment_facts already carries this original order's persisted share
    // of a combined payment. Never use the combined payment's whole amount.
    const selections=funding?[...funding].sort((a,b)=>a.paymentId.localeCompare(b.paymentId)):payments.length===1?[{paymentId:payments[0]!.id,amountMinor:Number(target.amount_minor)}]:null
    if(!selections)return {status:'payment_review' as const,refundIds:[],replayed:false}
    if(!selections.length||selections.length>50||new Set(selections.map(value=>value.paymentId)).size!==selections.length||selections.some(value=>!Number.isSafeInteger(value.amountMinor)||value.amountMinor<=0)||selections.reduce((sum,value)=>sum+BigInt(value.amountMinor),0n)!==BigInt(target.amount_minor))throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','各原付款退回金额合计必须等于本次原成交金额')
    if(selections.some(value=>{const source=payments.find(payment=>payment.id===value.paymentId);return !source||!['order','order_batch'].includes(source.payable_kind)||BigInt(source.amount_minor)-BigInt(source.reserved)<BigInt(value.amountMinor)})){
      if(!funding)return {status:'payment_review' as const,refundIds:[],replayed:false}
      throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','退款超出该原付款的本单可退余额，尚未创建新的退款')
    }
    const refundIds:string[]=[]
    for(const selected of selections){
      const refund=await new RefundRepository(this.tx).request({paymentId:selected.paymentId,publicId:`QR-${caseId.replaceAll('-','')}-${selected.paymentId.replaceAll('-','')}`,reason:target.reason,
        requestedByEmployeeId:target.requested_by_employee_id,purpose:'return_goods',allocations:[{orderItemId:pricing?String(pricing.refundOrderItemId):items[0]!.id,amountMinor:selected.amountMinor}],requestEvidence:{quantityCaseId:caseId,...(pricing?{pricingPolicy:String(pricing.policy),priceResolutionCaseId:caseId}:{}),source:funding?'reviewed_original_payment_allocation':'original_quantity_case'}})
      await this.tx.query(`INSERT INTO mbox.item_after_sales_case_refunds(tenant_id,store_id,case_id,refund_id) VALUES($1,$2,$3,$4)`,[...this.scope,caseId,refund.id])
      refundIds.push(refund.id)
    }
    return {status:'prepared' as const,refundIds,replayed:false}
  }

  async decide(input:{caseId:string;employeeId:string;decision:'approved'|'rejected'|'withdrawn';reason:string}){
    await lockQuantityOrder(this.tx,{kind:'case',id:input.caseId},true)
    const target=await this.case(input.caseId),linked=await this.linked(input.caseId)
    if(input.decision==='approved'&&(target.amount_minor===null||Number(target.amount_minor)>0&&(!linked.length||linked.reduce((sum,refund)=>sum+Number(refund.amount_minor),0)!==Number(target.amount_minor))))throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','先核对原成交金额与各原付款分摊，保留已暂停商品')
    if(input.decision==='approved'&&target.status==='requested'){
      const price=(await this.tx.query<{valid:boolean}>(`SELECT (snapshot-ARRAY['originalEffectiveAmountMinor','effectiveAmountMinor','availablePaidMinor','otherEffectiveChargesMinor'])=(mbox.quote_after_sales_price($3)-ARRAY['originalEffectiveAmountMinor','effectiveAmountMinor','availablePaidMinor','otherEffectiveChargesMinor']) AS valid FROM mbox.item_after_sales_price_resolutions WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3`,[...this.scope,input.caseId])).rows[0]
      if(price&&!price.valid)throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','原付款或套餐保留商品已变化，请修改原暂停申请后重新核对金额')
    }
    const result=await new ItemQuantityRepository(this.tx).decide(input)
    if(result.replayed)return {...result,refundIds:linked.map(refund=>refund.id),inventoryReview:await this.remainingDisposition(input.caseId)}
    const repository=new RefundRepository(this.tx)
    for(const refund of linked){
      if(refund.status!=='requested')throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','关联退款已执行或被处理，请核对原申请结果')
      if(input.decision==='approved'){
        const approved=await repository.approve(refund.id,input.employeeId,input.reason)
        if(approved.paymentProvider==='postar'){
          await repository.beginExecution(refund.id)
          await this.tx.query(`UPDATE mbox.refunds SET auto_execute_requested_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,refund.id])
        }
      }else if(input.decision==='rejected')await repository.reject(refund.id,input.employeeId,input.reason)
      else await this.tx.query(`UPDATE mbox.refunds SET status='cancelled',decision_reason=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='requested'`,[...this.scope,refund.id,input.reason.trim()])
    }
    if(input.decision==='approved'){
      const units=(await this.tx.query<{id:string;order_item_id:string;inventory_evidence_state:string}>(`SELECT id,order_item_id,inventory_evidence_state FROM mbox.order_item_quantity_units
        WHERE tenant_id=$1 AND store_id=$2 AND held_by_case_id=$3 AND production_state='unmade' ORDER BY order_item_id,unit_index`,[...this.scope,input.caseId])).rows
      const known=units.filter(unit=>unit.inventory_evidence_state!=='unresolved')
      for(const itemId of new Set(known.map(unit=>unit.order_item_id)))await new ItemUnitInventoryRepository(this.tx).disposeUnmadeUnits({itemId,unitIds:known.filter(unit=>unit.order_item_id===itemId).map(unit=>unit.id),employeeId:input.employeeId,caseId:input.caseId})
    }
    return {...result,refundIds:linked.map(refund=>refund.id),inventoryReview:await this.remainingDisposition(input.caseId)}
  }

  private async remainingDisposition(caseId:string){return (await this.tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND held_by_case_id=$3) AS found`,[...this.scope,caseId])).rows[0]?.found===true}

  private async case(id:string){
    const result=(await this.tx.query<{status:string;kind:string;amount_minor:string|null;reason:string;requested_by_employee_id:string}>(`SELECT status,COALESCE(resolved_kind,kind) AS kind,amount_minor::text,reason,requested_by_employee_id FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,id])).rows[0]
    if(!result)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原商品售后不存在')
    return result
  }
  private async linked(caseId:string){
    return (await this.tx.query<{id:string;status:string;amount_minor:string}>(`SELECT refund.id,refund.status,refund.amount_minor::text FROM mbox.item_after_sales_case_refunds link JOIN mbox.refunds refund
      ON refund.tenant_id=link.tenant_id AND refund.store_id=link.store_id AND refund.id=link.refund_id WHERE link.tenant_id=$1 AND link.store_id=$2 AND link.case_id=$3 AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries retry WHERE retry.tenant_id=link.tenant_id AND retry.store_id=link.store_id AND retry.previous_refund_id=link.refund_id) ORDER BY refund.id FOR UPDATE OF refund`,[...this.scope,caseId])).rows
  }
}
