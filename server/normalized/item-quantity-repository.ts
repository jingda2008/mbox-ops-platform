import {lockQuantityOrder} from './item-quantity-lock.js'
import {ItemUnitInventoryRepository} from './item-unit-inventory-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {ItemQuantityConflict,originalQuantityAmount,planItemQuantityHold,type ItemQuantityFacts} from './order-item-quantity-plan.js'

type ProductionState='unmade'|'started'|'ready'|'delivered'
interface QuantityItem extends Record<string,unknown>{id:string;order_id:string;quantity:number;unit_price_minor:string;total_amount_minor:string;parent_order_item_id:string|null;status:string}
interface Unit extends Record<string,unknown>{id:string;unit_index:number;production_state:ProductionState;held_by_case_id:string|null;stopped_by_case_id:string|null;operationally_stopped:boolean;original_amount_minor:string|null;inventory_evidence_state:'unresolved'|'untracked'|'allocated'}

/** Internal quantity ledger. The business coordinator must also settle inventory,
 * receivables, refunds and notifications in the same transaction before exposing actions. */
export class ItemQuantityRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}

  async initialize(orderItemId:string):Promise<{item:QuantityItem;units:Unit[]}> {
    await lockQuantityOrder(this.tx,{kind:'item',id:orderItemId})
    await this.tx.query(`SELECT id FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY id FOR UPDATE`,[...this.scope,orderItemId])
    const item=(await this.tx.query<QuantityItem>(`SELECT id,order_id,quantity,unit_price_minor::text,total_amount_minor::text,parent_order_item_id,status
      FROM mbox.order_items WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,orderItemId])).rows[0]!
    let units=await this.readUnits(orderItemId)
    if(units.length){if(units.length!==item.quantity)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原单份数记录不完整');return {item,units}}
    if(item.status==='cancelled')throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','商品已停止，请查看原处置记录')
    const evidence=(await this.tx.query<{started:boolean;ready:boolean;has_return:boolean;has_remake:boolean;has_failure:boolean}>(`SELECT
      EXISTS(SELECT 1 FROM mbox.kds_tasks t LEFT JOIN mbox.kds_task_events e ON e.tenant_id=t.tenant_id AND e.store_id=t.store_id AND e.kds_task_id=t.id
        WHERE t.tenant_id=$1 AND t.store_id=$2 AND t.order_item_id=$3 AND (t.status IN ('preparing','ready') OR e.from_status IN ('preparing','ready') OR e.to_status IN ('preparing','ready'))) AS started,
      EXISTS(SELECT 1 FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 AND status='ready') AS ready,
      EXISTS(SELECT 1 FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 AND status='failed') AS has_failure,
      EXISTS(SELECT 1 FROM mbox.order_stock_returns WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3) AS has_return,
      EXISTS(SELECT 1 FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 AND remake_of_task_id IS NOT NULL) AS has_remake`,[...this.scope,orderItemId])).rows[0]!
    if(evidence.has_failure)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','本行有原制作失败记录，请从出品异常继续处理；尚未拆分数量，原异常入口保留')
    if(evidence.has_return||evidence.has_remake)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','本行已有旧退库或重做记录，须先核对各批数量；原任务保持不变')
    const state:ProductionState=item.status==='delivered'?'delivered':evidence.ready?'ready':evidence.started?'started':'unmade'
    // A partial discounted line requires an original allocation or human pricing review.
    // NULL is intentional; neither current catalog prices nor fabricated zeroes are used.
    const plain=BigInt(item.unit_price_minor)*BigInt(item.quantity)===BigInt(item.total_amount_minor)
    const amount=item.parent_order_item_id===null&&(plain||item.quantity===1)?(plain?item.unit_price_minor:item.total_amount_minor):null
    await this.tx.query(`INSERT INTO mbox.order_item_quantity_units(tenant_id,store_id,order_item_id,unit_index,original_amount_minor,production_state)
      SELECT $1,$2,$3,n,$4::bigint,$5 FROM generate_series(0,$6::integer-1) n`,[...this.scope,item.id,amount,state,item.quantity])
    await new ItemUnitInventoryRepository(this.tx).initialize(orderItemId)
    units=await this.readUnits(orderItemId)
    return {item,units}
  }

  async hold(input:{orderItemId:string;quantity:number;kind:'unpaid_stop'|'paid_return'|'payment_review';employeeId:string;businessDate:string;reason:string;preferredUnitIds?:readonly string[];allowMadeUnpaidHold?:boolean}){
    const {item,units}=await this.initialize(input.orderItemId)
    if(item.status==='cancelled')throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','商品已停止，请查看原处置记录')
    const facts=quantityFacts(units)
    const plan=planItemQuantityHold(facts,input.quantity,input.kind==='unpaid_stop'&&!input.allowMadeUnpaidHold?'unpaid_stop':'paid_return')
    const preferred=new Set(input.preferredUnitIds??[])
    if(preferred.size!==(input.preferredUnitIds?.length??0)||preferred.size>input.quantity||[...preferred].some(id=>!units.some(unit=>unit.id===id&&!unit.held_by_case_id&&!unit.operationally_stopped)))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原修改份数已变化，请读回原申请')
    const selected=units.filter(unit=>!unit.held_by_case_id&&!unit.operationally_stopped)
      .sort((a,b)=>Number(preferred.has(b.id))-Number(preferred.has(a.id))||Number(a.production_state!=='unmade')-Number(b.production_state!=='unmade')||a.unit_index-b.unit_index)
      .slice(0,input.quantity)
    plan.unmade=selected.filter(unit=>unit.production_state==='unmade').length;plan.madeReview=selected.length-plan.unmade;plan.otherUnmade=facts.ordered-facts.started-facts.stoppedUnmade-facts.heldUnmade-plan.unmade
    if(input.kind==='unpaid_stop'&&plan.madeReview>0&&!input.allowMadeUnpaidHold)throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','原申请中已有实际制作份数，不能通过修改申请按未制作免单')
    let amountMinor:number|null=null
    try {amountMinor=originalQuantityAmount({quantity:item.quantity,unitAmountMinor:Number(item.unit_price_minor),totalAmountMinor:Number(item.total_amount_minor),includedInBundle:item.parent_order_item_id!==null},selected.map(unit=>unit.unit_index))}
    catch(error){if(!(error instanceof ItemQuantityConflict)||error.code!=='PRICE_REVIEW_REQUIRED')throw error}
    const result=(await this.tx.query<{id:string}>(`INSERT INTO mbox.item_after_sales_cases(tenant_id,store_id,order_id,kind,reason,requested_by_employee_id,amount_minor,business_date)
      VALUES($1,$2,$3,$4,$5,$6,$7::bigint,$8::date) RETURNING id`,[...this.scope,item.order_id,input.kind,input.reason.trim(),input.employeeId,amountMinor,input.businessDate])).rows[0]!
    const ids=selected.map(unit=>unit.id)
    await this.tx.query(`INSERT INTO mbox.item_after_sales_case_units(tenant_id,store_id,case_id,unit_id,production_state_at_request,amount_minor)
      SELECT tenant_id,store_id,$3,id,production_state,original_amount_minor FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($4::uuid[])`,[...this.scope,result.id,ids])
    const held=await this.tx.query(`UPDATE mbox.order_item_quantity_units SET held_by_case_id=$3,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($4::uuid[]) AND held_by_case_id IS NULL AND NOT operationally_stopped`,[...this.scope,result.id,ids])
    if(held.rowCount!==input.quantity)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','所选数量已被其他操作处理，请读回原结果')
    await this.event(result.id,input.employeeId,'quantity.held',{orderItemId:item.id,unitIds:ids,unmade:plan.unmade,madeReview:plan.madeReview,amountMinor})
    return {caseId:result.id,orderId:item.order_id,orderItemId:item.id,unitIds:ids,...plan,amountMinor,priceReviewRequired:amountMinor===null}
  }

  async decide(input:{caseId:string;employeeId:string;decision:'approved'|'rejected'|'withdrawn';reason:string}){
    const target=await this.lockCase(input.caseId)
    if(target.status===input.decision){
      const originalActor=input.decision==='withdrawn'?target.requested_by_employee_id:target.decided_by_employee_id
      if(originalActor!==input.employeeId)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原申请已由另一位员工处理，请读取原结果')
      return {caseId:input.caseId,status:target.status,replayed:true}
    }
    if(target.status!=='requested')throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','申请已被处理，请查看原决定')
    if(input.decision==='withdrawn'&&target.requested_by_employee_id!==input.employeeId)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','只能撤回本人尚未审核的申请')
    if(input.decision!=='withdrawn'&&target.requested_by_employee_id===input.employeeId&&!(input.decision==='rejected'&&target.kind==='unpaid_stop'))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','退款由另一位有权人员审核一次')
    if(input.decision==='approved'&&target.amount_minor===null)throw new ItemQuantityConflict('PRICE_REVIEW_REQUIRED','先核对所选商品的原成交分摊金额，再完成一次审核')
    await this.tx.query(`UPDATE mbox.item_after_sales_cases SET status=$4,decided_by_employee_id=$5,decision_reason=$6,decided_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,input.caseId,input.decision,input.decision==='withdrawn'?null:input.employeeId,input.reason.trim()])
    // Even approval leaves the units held until the coordinator confirms actual
    // stop/stock disposition; rejection/withdrawal never restarts production.
    await this.event(input.caseId,input.employeeId,`quantity.${input.decision}`,{reason:input.reason.trim(),production:'held_until_explicit_disposition'})
    return {caseId:input.caseId,status:input.decision,replayed:false}
  }

  async resume(input:{caseId:string;employeeId:string}){
    const target=await this.lockCase(input.caseId)
    if(!['rejected','withdrawn'].includes(target.status))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','请先处理原退款申请，再明确继续制作')
    // The original order may have been cancelled or its table turned over while
    // this case was waiting. Never announce resumed production for that old visit.
    const active=(await this.tx.query<{ok:boolean}>(`SELECT session.status IN ('open','closing')
      AND original.status<>'cancelled' AND original.fulfillment_state NOT IN ('awaiting_payment','released','cancelled')
      AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units selected
        JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
        JOIN mbox.order_items item ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
        WHERE selected.tenant_id=$1 AND selected.store_id=$2 AND selected.case_id=$3 AND item.status='cancelled') AS ok
      FROM mbox.item_after_sales_cases target
      JOIN mbox.orders original ON original.tenant_id=target.tenant_id AND original.store_id=target.store_id AND original.id=target.order_id
      JOIN mbox.table_sessions session ON session.tenant_id=original.tenant_id AND session.store_id=original.store_id AND session.id=original.table_session_id
      WHERE target.tenant_id=$1 AND target.store_id=$2 AND target.id=$3`,[...this.scope,input.caseId])).rows[0]?.ok
    if(!active)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原桌次或商品已结束，不能继续原商品；原售后记录仍可核对。')
    const units=(await this.tx.query<Unit>(`SELECT * FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND held_by_case_id=$3 ORDER BY order_item_id,unit_index FOR UPDATE`,[...this.scope,input.caseId])).rows
    if(units.some(unit=>unit.inventory_evidence_state==='unresolved'))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','库存原始记录尚未核对，继续制作前请核对对应份数的物料')
    const invalid=(await this.tx.query<{id:string}>(`SELECT unit.id FROM mbox.order_item_quantity_units unit
      LEFT JOIN LATERAL(SELECT part.id,part.cancelled_at FROM mbox.quantity_remake_units part
        WHERE part.tenant_id=unit.tenant_id AND part.store_id=unit.store_id AND part.unit_id=unit.id ORDER BY part.generation DESC LIMIT 1) latest ON true
      WHERE unit.tenant_id=$1 AND unit.store_id=$2 AND unit.id=ANY($3::uuid[]) AND (
        latest.cancelled_at IS NOT NULL OR (latest.id IS NULL AND EXISTS(SELECT 1 FROM mbox.order_item_unit_inventory stock
          WHERE stock.tenant_id=unit.tenant_id AND stock.store_id=unit.store_id AND stock.unit_id=unit.id AND stock.status IN ('released','returned','used_loss')))
        OR (latest.id IS NOT NULL AND EXISTS(SELECT 1 FROM mbox.quantity_remake_stocks stock
          WHERE stock.tenant_id=unit.tenant_id AND stock.store_id=unit.store_id AND stock.remake_unit_id=latest.id AND stock.status NOT IN ('reserved','consumed')))) LIMIT 1`,[...this.scope,units.map(unit=>unit.id)])).rows[0]
    if(invalid)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','所选商品库存已处置，须核对实际库存后再继续制作')
    await this.tx.query(`UPDATE mbox.order_item_quantity_units SET held_by_case_id=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND held_by_case_id=$3`,[...this.scope,input.caseId])
    if(units.length)await this.event(input.caseId,input.employeeId,'quantity.resumed',{unitIds:units.map(unit=>unit.id)})
    return {caseId:input.caseId,resumedQuantity:units.length}
  }

  async readUnits(orderItemId:string):Promise<Unit[]>{
    return (await this.tx.query<Unit>(`SELECT id,unit_index,production_state,held_by_case_id,stopped_by_case_id,operationally_stopped,original_amount_minor::text,inventory_evidence_state
      FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY unit_index FOR UPDATE`,[...this.scope,orderItemId])).rows
  }
  private async lockCase(caseId:string){
    await lockQuantityOrder(this.tx,{kind:'case',id:caseId})
    const row=(await this.tx.query<{id:string;kind:string;status:string;requested_by_employee_id:string;decided_by_employee_id:string|null;amount_minor:string|null}>(`SELECT c.id,COALESCE(c.resolved_kind,c.kind) AS kind,c.status,c.requested_by_employee_id,c.decided_by_employee_id,c.amount_minor::text FROM mbox.item_after_sales_cases c
      WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.id=$3 FOR UPDATE`,[...this.scope,caseId])).rows[0]
    if(!row)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','商品售后申请不存在')
    return row
  }
  private async event(caseId:string,employeeId:string,type:string,metadata:Record<string,unknown>){
    await this.tx.query(`INSERT INTO mbox.item_after_sales_events(tenant_id,store_id,case_id,employee_id,event_type,metadata)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[...this.scope,caseId,employeeId,type,JSON.stringify(metadata)])
  }
}

function quantityFacts(units:readonly Unit[]):ItemQuantityFacts{
  return {ordered:units.length,
    stoppedUnmade:units.filter(unit=>unit.operationally_stopped&&unit.production_state==='unmade').length,
    stoppedMade:units.filter(unit=>unit.operationally_stopped&&unit.production_state!=='unmade').length,
    heldUnmade:units.filter(unit=>unit.held_by_case_id&&!unit.operationally_stopped&&unit.production_state==='unmade').length,
    heldMade:units.filter(unit=>unit.held_by_case_id&&!unit.operationally_stopped&&unit.production_state!=='unmade').length,
    started:units.filter(unit=>unit.production_state!=='unmade').length,
    ready:units.filter(unit=>['ready','delivered'].includes(unit.production_state)).length,
    delivered:units.filter(unit=>unit.production_state==='delivered').length}
}
