import {lockQuantityOrder} from './item-quantity-lock.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {assertUnpaidMadeStopPermission} from './item-unpaid-made-stop.js'

/** Internal to the quantity coordinator. This does not change original invoices
 * or imply that KDS, payment, delivery or an after-sales case is complete. */
export class ItemQuantityReceivableRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}

  async recordUnpaidReduction(input:{caseId:string;employeeId:string;businessDate:string}){
    const header=(await this.tx.query<{order_id:string}>(`SELECT order_id FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,input.caseId])).rows[0]
    if(!header)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原停止申请不存在')
    await lockQuantityOrder(this.tx,{kind:'order',id:header.order_id})
    const previous=(await this.tx.query<{id:string;amount_minor:string;quantity:number}>(`SELECT id,amount_minor::text,quantity FROM mbox.item_receivable_adjustments WHERE tenant_id=$1 AND store_id=$2 AND case_id=$3`,[...this.scope,input.caseId])).rows[0]
    if(previous)return {id:previous.id,amountMinor:Number(previous.amount_minor),quantity:previous.quantity,replayed:true}
    const target=(await this.tx.query<{kind:string;status:string;amount_minor:string|null}>(`SELECT COALESCE(resolved_kind,kind) AS kind,status,amount_minor::text FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,input.caseId])).rows[0]!
    if(target.kind!=='unpaid_stop'||!['requested','approved'].includes(target.status))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','仅原未付款停止申请可直接调整应收')
    if(target.amount_minor===null)throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','所选份数的原成交分摊未确认，不按当前单卖价减少应收')
    const madeDecision=target.status==='approved'
    if(madeDecision)await assertUnpaidMadeStopPermission(this.tx,input.caseId,input.employeeId)
    const units=(await this.tx.query<{order_item_id:string;production_state:string;stopped_by_case_id:string|null;held_by_case_id:string|null}>(`SELECT unit.order_item_id,unit.production_state,unit.stopped_by_case_id,unit.held_by_case_id FROM mbox.item_after_sales_case_units selected
      JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
      WHERE selected.tenant_id=$1 AND selected.store_id=$2 AND selected.case_id=$3 ORDER BY unit.order_item_id,unit.unit_index FOR UPDATE OF unit`,[...this.scope,input.caseId])).rows
    if(!units.length||new Set(units.map(unit=>unit.order_item_id)).size!==1||units.some(unit=>unit.production_state==='unmade'?unit.stopped_by_case_id!==input.caseId:!madeDecision||(unit.held_by_case_id!==input.caseId&&unit.stopped_by_case_id!==input.caseId)))throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','先完成对应未制作份数的停止和库存处置；已制作份数须保留在原授权申请中')
    const itemId=units[0]!.order_item_id
    // A bundle needs component selection from its original composition before a financial stop.
    const bundle=(await this.tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.order_items WHERE tenant_id=$1 AND store_id=$2 AND (parent_order_item_id=$3 OR (id=$3 AND parent_order_item_id IS NOT NULL))) AS found`,[...this.scope,itemId])).rows[0]?.found
    if(bundle)throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','套餐须同时核对原组成和所选份数，不能只减少套餐应收却继续制作子品')
    const inserted=(await this.tx.query<{id:string}>(`INSERT INTO mbox.item_receivable_adjustments(tenant_id,store_id,case_id,order_id,order_item_id,amount_minor,quantity,business_date,created_by_employee_id)
      VALUES($1,$2,$3,$4,$5,$6::bigint,$7,$8::date,$9) RETURNING id`,[...this.scope,input.caseId,header.order_id,itemId,target.amount_minor,units.length,input.businessDate,input.employeeId])).rows[0]!
    await this.tx.query(`INSERT INTO mbox.item_after_sales_events(tenant_id,store_id,case_id,employee_id,event_type,metadata)
      VALUES($1,$2,$3,$4,'quantity.receivable_reduced',$5::jsonb)`,[...this.scope,input.caseId,input.employeeId,JSON.stringify({adjustmentId:inserted.id,orderItemId:itemId,quantity:units.length,amountMinor:Number(target.amount_minor)})])
    return {id:inserted.id,amountMinor:Number(target.amount_minor),quantity:units.length,replayed:false}
  }

  async readOrder(orderId:string){
    const row=(await this.tx.query<{original:string;effective:string}>(`SELECT total_amount_minor::text AS original,mbox.order_receivable_amount(tenant_id,store_id,id)::text AS effective
      FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,orderId])).rows[0]
    if(!row)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原订单不存在')
    const original=Number(row.original),effective=Number(row.effective)
    if(!Number.isSafeInteger(original)||!Number.isSafeInteger(effective)||effective<0)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原单与应收调整记录不一致')
    return {orderId,originalAmountMinor:original,effectiveAmountMinor:effective,cancelledAmountMinor:Math.max(0,original-effective),...(effective>original?{receivableIncreaseMinor:effective-original}:{})}
  }
}
