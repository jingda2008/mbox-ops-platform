import {QuantityRemakeRepository} from './quantity-remake-repository.js'
import {restoreQuantityInventoryBalance} from './quantity-inventory-return-balance.js'
import {lockQuantityOrder} from './item-quantity-lock.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

interface SourceLot extends Record<string,unknown>{id:string;inventory_item_id:string;quantity:string;status:'reserved'|'consumed'|'released';movement_id:string|null}
interface UnitStock extends Record<string,unknown>{id:string;unit_id:string;inventory_item_id:string;quantity:string;status:string;reservation_id:string|null;original_movement_id:string|null;consumption_movement_id:string|null}

/** Allocates existing inventory evidence without issuing a new sale or changing balances. */
export class ItemUnitInventoryRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}

  async initialize(itemId:string):Promise<'allocated'|'untracked'|'unresolved'>{
    const item=(await this.tx.query<{quantity:number;untracked:boolean}>(`SELECT quantity,
      product_snapshot->>'inventoryControlMode'='not_managed' AS untracked
      FROM mbox.order_items WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,itemId])).rows[0]
    if(!item)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原商品库存证据不存在')
    const existing=(await this.tx.query<{state:string}>(`SELECT inventory_evidence_state AS state FROM mbox.order_item_quantity_units
      WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY unit_index FOR UPDATE`,[...this.scope,itemId])).rows
    if(existing.length!==item.quantity)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原商品数量记录尚未完整建立')
    if(existing.every(unit=>unit.state==='allocated'))return 'allocated'
    if(existing.every(unit=>unit.state==='untracked'))return 'untracked'
    if(existing.some(unit=>unit.state!=='unresolved'))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','库存份数证据不完整')
    // Legacy partial returns do not identify exact units. Do not allocate their remainder by guessing.
    const returns=(await this.tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.inventory_movements
      WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 AND quantity_delta>0 AND movement_type='return') AS found`,[...this.scope,itemId])).rows[0]?.found
    if(returns)return 'unresolved'
    let lots=(await this.tx.query<SourceLot>(`SELECT id,inventory_item_id,quantity::text,status,movement_id
      FROM mbox.inventory_order_reservations WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY inventory_item_id,id FOR UPDATE`,[...this.scope,itemId])).rows
    const fromReservations=lots.length>0
    if(!fromReservations)lots=(await this.tx.query<SourceLot>(`SELECT id,inventory_item_id,(-quantity_delta)::text AS quantity,'consumed'::text AS status,id AS movement_id
      FROM mbox.inventory_movements WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 AND movement_type='sale' AND quantity_delta<0
      ORDER BY inventory_item_id,occurred_at,id`,[...this.scope,itemId])).rows
    if(lots.length===0){
      if(item.untracked){await this.setState(itemId,'untracked');return 'untracked'}
      return 'unresolved'
    }
    // Check all sources before inserting; an indivisible microscopic lot remains a review item.
    for(const lot of lots){
      if(!['reserved','consumed','released'].includes(lot.status))return 'unresolved'
      if(lot.status==='consumed'&&!lot.movement_id)return 'unresolved'
      const precision=(await this.tx.query<{valid:boolean}>(`SELECT bool_and(
        round($1::numeric*(n+1)/$2::integer,6)-round($1::numeric*n/$2::integer,6)>0) AS valid
        FROM generate_series(0,$2::integer-1) n`,[lot.quantity,item.quantity])).rows[0]?.valid
      if(!precision)return 'unresolved'
    }
    for(const lot of lots){
      await this.tx.query(`INSERT INTO mbox.order_item_unit_inventory(tenant_id,store_id,unit_id,inventory_item_id,reservation_id,original_movement_id,quantity,status,consumption_movement_id)
        SELECT $1,$2,unit.id,$4,$5::uuid,$6::uuid,
          round($7::numeric*(unit.unit_index+1)/$8::integer,6)-round($7::numeric*unit.unit_index/$8::integer,6),$9,$6::uuid
        FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=$1 AND unit.store_id=$2 AND unit.order_item_id=$3`,
      [...this.scope,itemId,lot.inventory_item_id,fromReservations?lot.id:null,lot.movement_id,lot.quantity,item.quantity,lot.status])
    }
    await this.setState(itemId,'allocated')
    return 'allocated'
  }

  async consumeUnheldUnits(input:{itemId:string;unitIds:readonly string[];employeeId:string;taskId:string}){
    const units=await this.lockUnits(input.itemId,input.unitIds)
    if(units.some(unit=>unit.held_by_case_id||unit.operationally_stopped))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','所选份数已暂停或停止，请读取当前制作数量')
    const stocks=await this.lockStocks(input.unitIds)
    if(stocks.some(stock=>!['reserved','consumed'].includes(stock.status)))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','本批物料已经处置，不能重复制作')
    let consumed=0
    for(const stock of stocks){
      if(stock.status==='consumed')continue
      const movement=(await this.tx.query<{id:string}>(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,
        reference_type,reference_id,order_item_id,reason,created_by_employee_id,metadata,quantity_unit_id,unit_cost_minor)
        SELECT $1,$2,$3,'sale',-$4::numeric,'quantity_production',$5,$6,'开始制作所选份数，消费对应原预留',$7,$8::jsonb,$5::uuid,
          CASE WHEN balance.cost_status='complete' THEN balance.weighted_unit_cost_minor ELSE NULL END
        FROM mbox.inventory_balances balance WHERE balance.tenant_id=$1 AND balance.store_id=$2 AND balance.inventory_item_id=$3 RETURNING id`,
      [...this.scope,stock.inventory_item_id,stock.quantity,stock.unit_id,input.itemId,input.employeeId,JSON.stringify({quantityUnitId:stock.unit_id,kdsTaskId:input.taskId,reservationId:stock.reservation_id})])).rows[0]!.id
      const balance=await this.tx.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=on_hand_quantity-$4::numeric,reserved_quantity=reserved_quantity-$4::numeric,
        last_movement_id=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3
        AND on_hand_quantity>=$4::numeric AND reserved_quantity>=$4::numeric`,[...this.scope,stock.inventory_item_id,stock.quantity,movement])
      if(balance.rowCount!==1)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','库存预留与实际余额不一致，本批尚未开始制作')
      await this.tx.query(`UPDATE mbox.order_item_unit_inventory SET status='consumed',consumption_movement_id=$4,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,stock.id,movement]);consumed++
    }
    await this.tx.query(`UPDATE mbox.order_item_quantity_units SET production_state='started',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND production_state='unmade'`,[...this.scope,input.unitIds])
    return {consumedRecords:consumed}
  }

  /** Only the owning case can dispose held unmade units. The coordinator must
   * update KDS and the receivable/refund facts in this same transaction. */
  async disposeUnmadeUnits(input:{itemId:string;unitIds:readonly string[];employeeId:string;caseId:string}){
    const units=await this.lockUnits(input.itemId,input.unitIds)
    if(units.some(unit=>unit.production_state!=='unmade'||(unit.held_by_case_id!==input.caseId&&unit.stopped_by_case_id!==input.caseId))) {
      throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','只能释放本申请已暂停且未开始制作的份数')
    }
    const target=(await this.tx.query<{kind:string;status:string;order_id:string}>(`SELECT COALESCE(resolved_kind,kind) AS kind,status,order_id FROM mbox.item_after_sales_cases
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,input.caseId])).rows[0]
    if(!target)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原商品处置申请不存在')
    if(target.kind==='unpaid_stop'){
      if(!['requested','approved','completed'].includes(target.status))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','申请已撤回或拒绝，不能继续执行停止')
      const paid=(await this.tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.order_payment_facts
        WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('failed','closed')) AS found`,[...this.scope,target.order_id])).rows[0]?.found
      if(paid)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原付款仍有资金事实或在途结果，请先核对，不按未付款直接停止')
    }else if(target.status!=='approved')throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','先完成原申请的一次审核，再处理对应商品库存')
    const stocks=await this.lockStocks(input.unitIds)
    let released=0,returned=0
    for(const stock of stocks){
      if(['released','returned'].includes(stock.status))continue
      if(stock.status==='reserved'){
        const changed=await this.tx.query(`UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-$4::numeric,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND reserved_quantity>=$4::numeric`,[...this.scope,stock.inventory_item_id,stock.quantity])
        if(changed.rowCount!==1)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原库存预留余额不一致，未释放对应数量')
        await this.tx.query(`UPDATE mbox.order_item_unit_inventory SET status='released',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,stock.id]);released++
      }else if(stock.status==='consumed'){
        const original=stock.consumption_movement_id??stock.original_movement_id
        if(!original)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','未找到原扣减流水，不补造库存')
        const movement=(await this.tx.query<{id:string}>(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,
          reference_type,reference_id,order_item_id,reason,created_by_employee_id,unit_cost_minor,metadata,quantity_unit_id)
          SELECT $1,$2,$3,'return',$4::numeric,'quantity_unmade_return',$5,$6,'确认未制作，依原流水退回所选份数',$7,original.unit_cost_minor,
            jsonb_build_object('originalMovementId',original.id,'quantityUnitId',$9::uuid),$9::uuid
          FROM mbox.inventory_movements original WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.id=$8 AND original.inventory_item_id=$3 AND original.order_item_id=$6 AND original.quantity_delta<0 RETURNING id`,
        [...this.scope,stock.inventory_item_id,stock.quantity,input.caseId,input.itemId,input.employeeId,original,stock.unit_id])).rows[0]?.id
        if(!movement)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原扣减流水归属不符，未增加库存')
        await restoreQuantityInventoryBalance(this.tx,{inventoryItemId:stock.inventory_item_id,movementId:movement,quantity:stock.quantity})
        await this.tx.query(`UPDATE mbox.order_item_unit_inventory SET status='returned',return_movement_id=$4,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,stock.id,movement]);returned++
      }else throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','已消耗物料不能还原成未制作库存')
    }
    await this.tx.query(`UPDATE mbox.order_item_quantity_units SET held_by_case_id=NULL,stopped_by_case_id=$4,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])`,[...this.scope,input.unitIds,input.caseId])
    return {releasedRecords:released,returnedRecords:returned}
  }

  /** Made goods retain their consumption facts. A refund alone cannot turn them
   * back into raw material; unopened returns require an explicit physical receipt. */
  async disposeMadeUnits(input:{itemId:string;unitIds:readonly string[];employeeId:string;caseId:string;disposition:'used_loss'|'returned_unopened';unopenedReceived:boolean;reason:string}){
    if(input.reason.trim().length<2||input.reason.length>1000)throw new ItemQuantityConflict('QUANTITY_INVALID','请填写实际商品处置原因')
    const units=await this.lockUnits(input.itemId,input.unitIds)
    if(units.some(unit=>unit.held_by_case_id!==input.caseId&&unit.stopped_by_case_id!==input.caseId))throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','请选择本申请中尚待实物处置的对应份数')
    const target=(await this.tx.query<{status:string;kind:string;visit_ended:boolean}>(`SELECT target.status,COALESCE(target.resolved_kind,target.kind) AS kind,
      original.status='cancelled' OR session.status='closed' AS visit_ended
      FROM mbox.item_after_sales_cases target JOIN mbox.orders original ON original.tenant_id=target.tenant_id AND original.store_id=target.store_id AND original.id=target.order_id
      JOIN mbox.table_sessions session ON session.tenant_id=original.tenant_id AND session.store_id=original.store_id AND session.id=original.table_session_id
      WHERE target.tenant_id=$1 AND target.store_id=$2 AND target.id=$3 FOR UPDATE OF target`,[...this.scope,input.caseId])).rows[0]
    const declinedAfterVisit=target&&['rejected','withdrawn'].includes(target.status)&&target.visit_ended
    if(!target||(!['approved','completed'].includes(target.status)&&!declinedAfterVisit))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','先按原授权完成商品处置审核')
    // Older orders may have consumed stock at ordering without a production
    // event. After a declined case's visit ends, only an explicit physical
    // disposition may settle those shares; it never changes the refund decision.
    if(!declinedAfterVisit&&units.some(unit=>unit.production_state==='unmade'))throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','请选择本申请中已有制作记录的对应份数')
    if(!['used_loss','returned_unopened'].includes(input.disposition))throw new ItemQuantityConflict('QUANTITY_INVALID','请选择实际商品去向')
    if(input.disposition==='returned_unopened'&&!input.unopenedReceived)throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','需确认实物已经收回且未开封，不能只凭退款回库')
    // The financial unit retains its first production history. Physical return
    // or loss follows its latest actual batch; original lost stock is never returned.
    const remakes=(await this.tx.query<{id:string;unit_id:string;batch_id:string;production_state:string}>(`SELECT DISTINCT ON(part.unit_id) part.id,part.unit_id,part.batch_id,part.production_state
      FROM mbox.quantity_remake_units part WHERE part.tenant_id=$1 AND part.store_id=$2 AND part.unit_id=ANY($3::uuid[]) ORDER BY part.unit_id,part.generation DESC`,[...this.scope,input.unitIds])).rows
    const remadeIds=new Set(remakes.map(part=>part.unit_id)),originalIds=input.unitIds.filter(id=>!remadeIds.has(id))
    const remakeRepository=new QuantityRemakeRepository(this.tx)
    for(const batchId of new Set(remakes.map(part=>part.batch_id))){
      const parts=remakes.filter(part=>part.batch_id===batchId),unmade=parts.filter(part=>part.production_state==='unmade'),made=parts.filter(part=>part.production_state!=='unmade')
      if(unmade.length)await remakeRepository.releaseUnmade({batchId,unitIds:unmade.map(part=>part.id),reason:input.reason})
      if(made.length)await remakeRepository.disposeMade({...input,batchId,unitIds:made.map(part=>part.id)})
    }
    const stocks=await this.lockStocks(originalIds)
    const terminal=input.disposition==='used_loss'?'used_loss':'returned'
    if(stocks.some(stock=>!['consumed',terminal].includes(stock.status)))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','这些物料已按另一结果处置，不能重复回库或再次扣减')
    if(input.disposition==='returned_unopened'&&originalIds.length){
      const packaged=(await this.tx.query<{ok:boolean}>(`SELECT count(*)=$4::integer AND count(DISTINCT stock.unit_id)=$4::integer AND bool_and(
        CASE WHEN inventory.base_unit='ml' AND inventory.item_type='bottle' THEN inventory.package_volume_ml>0 AND mod(stock.quantity,inventory.package_volume_ml)=0
        WHEN inventory.base_unit IN ('bottle','piece') AND inventory.item_type IN ('bottle','food') THEN stock.quantity>=1 AND mod(stock.quantity,1)=0 ELSE false END) AS ok
        FROM mbox.order_item_unit_inventory stock JOIN mbox.inventory_items inventory ON inventory.tenant_id=stock.tenant_id AND inventory.store_id=stock.store_id AND inventory.id=stock.inventory_item_id
        WHERE stock.tenant_id=$1 AND stock.store_id=$2 AND stock.unit_id=ANY($3::uuid[])`,[...this.scope,originalIds,originalIds.length])).rows[0]?.ok
      if(!packaged)throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','仅可核对的单一整包装商品能退回原库存，配方成品不能恢复为原料')
    }
    let disposed=0
    for(const stock of stocks){
      if(stock.status===terminal)continue
      if(terminal==='used_loss'){
        // It was already consumed by production. Do not create another negative stock movement.
        await this.tx.query(`UPDATE mbox.order_item_unit_inventory SET status='used_loss',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,stock.id])
      }else{
        const movement=(await this.tx.query<{id:string}>(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,order_item_id,reason,created_by_employee_id,unit_cost_minor,quantity_unit_id,metadata)
          SELECT $1,$2,$3,'return',$4::numeric,'quantity_unopened_return',$5,$6,$7,$8,original.unit_cost_minor,$10::uuid,
            jsonb_build_object('originalMovementId',original.id,'unopenedReceived',true)
          FROM mbox.inventory_movements original WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.id=$9 AND original.inventory_item_id=$3 AND original.order_item_id=$6 AND original.quantity_delta<0 RETURNING id`,
          [...this.scope,stock.inventory_item_id,stock.quantity,input.caseId,input.itemId,input.reason.trim(),input.employeeId,stock.consumption_movement_id,stock.unit_id])).rows[0]?.id
        if(!movement)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原扣减流水不完整，尚未增加库存')
        await restoreQuantityInventoryBalance(this.tx,{inventoryItemId:stock.inventory_item_id,movementId:movement,quantity:stock.quantity})
        await this.tx.query(`UPDATE mbox.order_item_unit_inventory SET status='returned',return_movement_id=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,stock.id,movement])
      }
      disposed++
    }
    const stopped=await this.tx.query(`UPDATE mbox.order_item_quantity_units SET held_by_case_id=NULL,stopped_by_case_id=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND stopped_by_case_id IS NULL`,[...this.scope,input.unitIds,input.caseId])
    if(stopped.rowCount)await this.tx.query(`INSERT INTO mbox.item_after_sales_events(tenant_id,store_id,case_id,employee_id,event_type,metadata) VALUES($1,$2,$3,$4,'quantity.made_disposed',$5::jsonb)`,[...this.scope,input.caseId,input.employeeId,JSON.stringify({unitIds:input.unitIds,disposition:input.disposition,reason:input.reason.trim(),unopenedReceived:input.unopenedReceived,remakePhysicalUnitIds:remakes.map(part=>part.id)})])
    return {disposedRecords:disposed,stoppedQuantity:stopped.rowCount??0}
  }

  private async lockUnits(itemId:string,ids:readonly string[]){
    await lockQuantityOrder(this.tx,{kind:'item',id:itemId})
    if(!ids.length||new Set(ids).size!==ids.length)throw new ItemQuantityConflict('QUANTITY_INVALID','所选份数无效')
    const units=(await this.tx.query<{id:string;production_state:string;held_by_case_id:string|null;stopped_by_case_id:string|null;operationally_stopped:boolean;inventory_evidence_state:string}>(`SELECT id,production_state,held_by_case_id,stopped_by_case_id,operationally_stopped,inventory_evidence_state
      FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 AND id=ANY($4::uuid[]) ORDER BY unit_index FOR UPDATE`,[...this.scope,itemId,ids])).rows
    if(units.length!==ids.length||units.some(unit=>unit.inventory_evidence_state==='unresolved'))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','所选份数或对应库存原始证据尚未核对')
    return units
  }
  private async lockStocks(ids:readonly string[]):Promise<UnitStock[]>{
    const stocks=(await this.tx.query<UnitStock>(`SELECT id,unit_id,inventory_item_id,quantity::text,status,reservation_id,original_movement_id,consumption_movement_id
      FROM mbox.order_item_unit_inventory WHERE tenant_id=$1 AND store_id=$2 AND unit_id=ANY($3::uuid[]) ORDER BY inventory_item_id,id FOR UPDATE`,[...this.scope,ids])).rows
    await this.tx.query(`SELECT inventory_item_id FROM mbox.inventory_balances WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=ANY($3::uuid[]) ORDER BY inventory_item_id FOR UPDATE`,[...this.scope,[...new Set(stocks.map(stock=>stock.inventory_item_id))]])
    return stocks
  }

  private async setState(itemId:string,state:'allocated'|'untracked'){
    await this.tx.query(`UPDATE mbox.order_item_quantity_units SET inventory_evidence_state=$4,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3`,[...this.scope,itemId,state])
  }
}
