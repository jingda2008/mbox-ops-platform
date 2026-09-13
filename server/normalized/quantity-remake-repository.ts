import {restoreQuantityInventoryBalance} from './quantity-inventory-return-balance.js'
import {randomUUID} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {assertEmployeeEffectivePermission} from './employee-table-access.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {lockQuantityOrder} from './item-quantity-lock.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {planQuantityRemake,type RemakeMaterialFact} from './quantity-remake-plan.js'
import {KdsRepository} from './kds-repository.js'

/** Quantity batches retain their own physical and material facts. Public
 * admission stays behind the rollout gate; recovery of committed batches remains
 * available. The caller supplies KDS employee/device/station authorization and
 * the idempotent command transaction. */
export class QuantityRemakeRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
  async create(input:{itemId:string;employeeId:string;quantity:number;originalGoodsLost:boolean;reason:string;eventKey:string;previousBatchId?:string}){
    await assertEmployeeEffectivePermission(this.tx,input.employeeId,'kds.exception.manage')
    if(input.reason.trim().length<2||input.reason.length>1000)throw new ItemQuantityConflict('QUANTITY_INVALID','请说明实际需要重做的原因')
    await lockQuantityOrder(this.tx,{kind:'item',id:input.itemId})
    const source=(await this.tx.query<{id:string;station_code:'bar'|'kitchen';active:boolean}>(`SELECT task.id,task.station_code,
      visit.status IN ('open','closing') AND original.status<>'cancelled' AND original.fulfillment_state NOT IN ('awaiting_payment','released','cancelled') AND item.status<>'cancelled' AS active
      FROM mbox.order_items item JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
      JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
      JOIN mbox.kds_tasks task ON task.tenant_id=item.tenant_id AND task.store_id=item.store_id AND task.order_item_id=item.id AND task.remake_of_task_id IS NULL
      WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3 ORDER BY task.created_at,task.id LIMIT 1 FOR UPDATE OF task`,[...this.scope,input.itemId])).rows[0]
    if(!source?.active||!['bar','kitchen'].includes(source.station_code))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原商品或原桌次已结束，不能创建原出品重做批次')
    const {units}=await new ItemQuantityRepository(this.tx).initialize(input.itemId)
    const oldBatches=(await this.tx.query<{id:string;unit_id:string;batch_id:string;generation:number;production_state:'unmade'|'started'|'ready'|'delivered';cancelled_at:string|null}>(`SELECT DISTINCT ON(unit_id) id,unit_id,batch_id,generation,production_state,cancelled_at::text
      FROM mbox.quantity_remake_units WHERE tenant_id=$1 AND store_id=$2 AND unit_id=ANY($3::uuid[]) ORDER BY unit_id,generation DESC`,[...this.scope,units.map(unit=>unit.id)])).rows
    if(input.previousBatchId&&!oldBatches.some(part=>part.batch_id===input.previousBatchId))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','前一批已经接续或不属于原商品，请读取实际批次')
    const redeliveries=(await this.tx.query<{unit_id:string}>('SELECT unit_id FROM mbox.quantity_redelivery_units WHERE tenant_id=$1 AND store_id=$2 AND unit_id=ANY($3::uuid[]) AND outcome IS NULL',[...this.scope,units.map(unit=>unit.id)])).rows
    const originalMaterials=(await this.tx.query<RemakeMaterialFact&{unit_id:string}&Record<string,unknown>>(`SELECT id,unit_id,inventory_item_id AS "inventoryItemId",quantity::text,status,consumption_movement_id AS "consumptionMovementId"
      FROM mbox.order_item_unit_inventory WHERE tenant_id=$1 AND store_id=$2 AND unit_id=ANY($3::uuid[]) ORDER BY inventory_item_id,id FOR UPDATE`,[...this.scope,units.map(unit=>unit.id)])).rows
    const previousMaterials=input.previousBatchId?(await this.tx.query<RemakeMaterialFact&{unit_id:string}&Record<string,unknown>>(`SELECT stock.id,part.unit_id,stock.inventory_item_id AS "inventoryItemId",stock.quantity::text,stock.status,stock.consumption_movement_id AS "consumptionMovementId"
      FROM mbox.quantity_remake_stocks stock JOIN mbox.quantity_remake_units part ON part.tenant_id=stock.tenant_id AND part.store_id=stock.store_id AND part.id=stock.remake_unit_id
      WHERE stock.tenant_id=$1 AND stock.store_id=$2 AND part.batch_id=$3 ORDER BY stock.inventory_item_id,stock.id FOR UPDATE OF stock`,[...this.scope,input.previousBatchId])).rows:[]
    // An explicitly disposed previous batch has already recorded its loss/return
    // or unused release. Its successor reuses the immutable original material
    // specification, never treats that terminal result as another loss.
    const usingPreviousStock=new Set(oldBatches.filter(part=>part.batch_id===input.previousBatchId&&!part.cancelled_at).map(part=>part.unit_id))
    const materials=units.flatMap(unit=>(usingPreviousStock.has(unit.id)?previousMaterials:originalMaterials).filter(stock=>stock.unit_id===unit.id))
    const plan=planQuantityRemake({...input,units:units.map(unit=>{
      const previous=oldBatches.find(part=>part.unit_id===unit.id),matching=!!input.previousBatchId&&previous?.batch_id===input.previousBatchId
      return {id:unit.id,index:unit.unit_index,productionState:matching&&previous&&!previous.cancelled_at?previous.production_state:unit.production_state,held:unit.held_by_case_id!==null,stopped:unit.operationally_stopped,
        hasActiveRemake:input.previousBatchId?!matching:!!previous,hasActiveRedelivery:redeliveries.some(value=>value.unit_id===unit.id),inventoryEvidence:unit.inventory_evidence_state,materials:materials.filter(value=>value.unit_id===unit.id)}
    })})
    const inventoryIds=[...new Set(plan.materials.map(stock=>stock.inventoryItemId))].sort()
    await this.tx.query('SELECT inventory_item_id FROM mbox.inventory_balances WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=ANY($3::uuid[]) ORDER BY inventory_item_id FOR UPDATE',[...this.scope,inventoryIds])
    // Retire only the exact prior physical shares selected by this request.
    // Reservation failure later rolls these changes back with the new task.
    const previousLossIds=plan.originalLossStockIds.filter(id=>previousMaterials.some(stock=>stock.id===id))
    if(previousLossIds.length)await this.tx.query("UPDATE mbox.quantity_remake_stocks SET status='used_loss',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND status='consumed'",[...this.scope,previousLossIds])
    const previousUnits=oldBatches.filter(part=>plan.unitIds.includes(part.unit_id)&&part.batch_id===input.previousBatchId)
    if(previousUnits.length)await this.tx.query("UPDATE mbox.quantity_remake_units SET cancelled_at=clock_timestamp(),cancel_reason=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND cancelled_at IS NULL",[...this.scope,previousUnits.map(part=>part.id),input.reason.trim()])
    const batchId=randomUUID()
    const task=await new KdsRepository(this.tx).create({quantityRemakeBatchId:batchId,orderItemId:input.itemId,remakeOfTaskId:source.id,stationCode:source.station_code,quantity:plan.quantity,eventIdempotencyKey:`${input.eventKey}:created`})
    await this.tx.query(`INSERT INTO mbox.quantity_remake_batches(id,tenant_id,store_id,order_item_id,kds_task_id,original_kds_task_id,requested_by_employee_id,reason,original_goods_lost)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)`,[batchId,...this.scope,input.itemId,task.id,source.id,input.employeeId,input.reason.trim()])
    for(const unitId of plan.unitIds){
      const replacementId=randomUUID()
      const previous=previousUnits.find(part=>part.unit_id===unitId)
      await this.tx.query('INSERT INTO mbox.quantity_remake_units(id,tenant_id,store_id,batch_id,unit_id,generation,previous_remake_unit_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[replacementId,...this.scope,batchId,unitId,previous?previous.generation+1:1,previous?.id??null])
      for(const material of plan.materials.filter(stock=>stock.sourceUnitId===unitId)){
        const reserved=await this.tx.query(`UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity+$4::numeric,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND on_hand_quantity-reserved_quantity>=$4::numeric`,[...this.scope,material.inventoryItemId,material.quantity])
        if(reserved.rowCount!==1)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','本批重做材料不足，尚未创建新任务或重复扣库存')
        await this.tx.query(`INSERT INTO mbox.quantity_remake_stocks(tenant_id,store_id,remake_unit_id,inventory_item_id,quantity,source_original_stock_id,source_remake_stock_id)
          VALUES($1,$2,$3,$4,$5::numeric,$6,$7)`,[...this.scope,replacementId,material.inventoryItemId,material.quantity,usingPreviousStock.has(unitId)?null:material.sourceStockId,usingPreviousStock.has(unitId)?material.sourceStockId:null])
      }
    }
    await this.tx.query("UPDATE mbox.order_item_unit_inventory SET status='used_loss',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND status='consumed'",[...this.scope,plan.originalLossStockIds.filter(id=>originalMaterials.some(stock=>stock.id===id))])
    if(input.previousBatchId)await this.finishDisposedTask(input.previousBatchId)
    return this.read(batchId)
  }
  async consume(input:{batchId:string;employeeId:string;unitIds:readonly string[]}){
    const current=await this.lock(input.batchId,input.unitIds)
    if(!current.active||current.units.some(unit=>unit.cancelled_at||unit.held||unit.stopped))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','本批对应份数已暂停或停止')
    const stocks=await this.stocks(input.unitIds)
    if(stocks.some(stock=>!['reserved','consumed'].includes(stock.status)))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','本批材料已经处置，不能重新消耗')
    for(const stock of stocks){
      if(stock.status==='consumed')continue
      const movementId=(await this.tx.query<{id:string}>(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,order_item_id,reason,created_by_employee_id,metadata,quantity_remake_stock_id,unit_cost_minor)
        SELECT $1,$2,$3,'waste',-$4::numeric,'quantity_remake',$5,$6,'原商品重做的新增一批材料，原消耗另存',$7,$8::jsonb,$9,
          CASE WHEN balance.cost_status='complete' THEN balance.weighted_unit_cost_minor ELSE NULL END
        FROM mbox.inventory_balances balance WHERE balance.tenant_id=$1 AND balance.store_id=$2 AND balance.inventory_item_id=$3 RETURNING id`,[...this.scope,stock.inventory_item_id,stock.quantity,input.batchId,current.itemId,input.employeeId,JSON.stringify({remakeUnitId:stock.remake_unit_id,sourceOriginalStockId:stock.source_original_stock_id,sourceRemakeStockId:stock.source_remake_stock_id}),stock.id])).rows[0]!.id
      const changed=await this.tx.query(`UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-$4::numeric,on_hand_quantity=on_hand_quantity-$4::numeric,last_movement_id=$5,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND reserved_quantity>=$4::numeric AND on_hand_quantity>=$4::numeric`,[...this.scope,stock.inventory_item_id,stock.quantity,movementId])
      if(changed.rowCount!==1)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','新批材料余额与预留不一致，未确认制作')
      await this.tx.query("UPDATE mbox.quantity_remake_stocks SET status='consumed',consumption_movement_id=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,stock.id,movementId])
    }
    await this.tx.query("UPDATE mbox.quantity_remake_units SET production_state='started',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND production_state='unmade'",[...this.scope,input.unitIds])
    return this.read(input.batchId)
  }
  async releaseUnmade(input:{batchId:string;unitIds:readonly string[];reason:string}){
    if(input.reason.trim().length<2||input.reason.length>1000)throw new ItemQuantityConflict('QUANTITY_INVALID','请说明本批停止原因')
    const current=await this.lock(input.batchId,input.unitIds)
    if(current.units.some(unit=>unit.production_state!=='unmade'))throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','已开始重做的份数须登记实际去向，不能当作未制作回库')
    const stocks=await this.stocks(input.unitIds)
    if(stocks.some(stock=>!['reserved','released'].includes(stock.status)))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','新批材料已消耗或另行处置')
    for(const stock of stocks){
      if(stock.status==='released')continue
      const changed=await this.tx.query('UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-$4::numeric,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND reserved_quantity>=$4::numeric',[...this.scope,stock.inventory_item_id,stock.quantity])
      if(changed.rowCount!==1)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','新批材料预留余额不一致')
      await this.tx.query("UPDATE mbox.quantity_remake_stocks SET status='released',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,stock.id])
    }
    await this.tx.query('UPDATE mbox.quantity_remake_units SET cancelled_at=clock_timestamp(),cancel_reason=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND cancelled_at IS NULL',[...this.scope,input.unitIds,input.reason.trim()])
    await this.finishDisposedTask(input.batchId)
    return this.read(input.batchId)
  }
  async disposeMade(input:{batchId:string;unitIds:readonly string[];employeeId:string;reason:string;disposition:'used_loss'|'returned_unopened';unopenedReceived:boolean}){
    if(input.reason.trim().length<2||input.reason.length>1000)throw new ItemQuantityConflict('QUANTITY_INVALID','请说明新批商品实际去向')
    const current=await this.lock(input.batchId,input.unitIds)
    if(current.units.some(unit=>unit.production_state==='unmade'))throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','未制作的新批仅释放预留，不认定为已消耗或实物退回')
    const terminal=input.disposition==='used_loss'?'used_loss':input.disposition==='returned_unopened'?'returned':null
    if(!terminal)throw new ItemQuantityConflict('QUANTITY_INVALID','请选择新批实物的实际去向')
    if(terminal==='returned'&&!input.unopenedReceived)throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','新批实物确已收回且未开封，才可退回库存')
    const stocks=await this.stocks(input.unitIds)
    if(stocks.some(stock=>!['consumed',terminal].includes(stock.status)))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','新批材料已按另一结果处置')
    if(terminal==='returned'){
      const packaged=(await this.tx.query<{ok:boolean}>(`SELECT count(*)=$4::integer AND count(DISTINCT stock.remake_unit_id)=$4::integer AND bool_and(
        CASE WHEN inventory.base_unit='ml' AND inventory.item_type='bottle' THEN inventory.package_volume_ml>0 AND mod(stock.quantity,inventory.package_volume_ml)=0
        WHEN inventory.base_unit IN ('bottle','piece') AND inventory.item_type IN ('bottle','food') THEN stock.quantity>=1 AND mod(stock.quantity,1)=0 ELSE false END) AS ok
        FROM mbox.quantity_remake_stocks stock JOIN mbox.inventory_items inventory ON inventory.tenant_id=stock.tenant_id AND inventory.store_id=stock.store_id AND inventory.id=stock.inventory_item_id
        WHERE stock.tenant_id=$1 AND stock.store_id=$2 AND stock.remake_unit_id=ANY($3::uuid[])`,[...this.scope,input.unitIds,input.unitIds.length])).rows[0]?.ok
      if(!packaged)throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','仅明确整包装的新批实物可回库，配方成品不能还原成原料')
    }
    for(const stock of stocks){
      if(stock.status===terminal)continue
      if(terminal==='used_loss')await this.tx.query("UPDATE mbox.quantity_remake_stocks SET status='used_loss',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,stock.id])
      else{
        const movementId=(await this.tx.query<{id:string}>(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,unit_cost_minor,reference_type,reference_id,order_item_id,reason,created_by_employee_id,metadata,quantity_remake_stock_id)
          SELECT $1,$2,$3,'return',$4::numeric,original.unit_cost_minor,'quantity_remake_return',$5,$6,$7,$8,jsonb_build_object('originalMovementId',original.id,'unopenedReceived',true),$9
          FROM mbox.inventory_movements original WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.id=$10 AND original.quantity_remake_stock_id=$9 AND original.quantity_delta<0 RETURNING id`,
          [...this.scope,stock.inventory_item_id,stock.quantity,input.batchId,current.itemId,input.reason.trim(),input.employeeId,stock.id,stock.consumption_movement_id])).rows[0]?.id
        if(!movementId)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','新批实际消耗流水不完整，未增加库存')
        await restoreQuantityInventoryBalance(this.tx,{inventoryItemId:stock.inventory_item_id,movementId,quantity:stock.quantity})
        await this.tx.query("UPDATE mbox.quantity_remake_stocks SET status='returned',return_movement_id=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,stock.id,movementId])
      }
    }
    await this.tx.query('UPDATE mbox.quantity_remake_units SET cancelled_at=clock_timestamp(),cancel_reason=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND cancelled_at IS NULL',[...this.scope,input.unitIds,input.reason.trim()])
    await this.finishDisposedTask(input.batchId)
    return this.read(input.batchId)
  }
  private async finishDisposedTask(batchId:string){
    await this.tx.query(`UPDATE mbox.kds_tasks task SET status='cancelled',cancelled_at=COALESCE(task.cancelled_at,clock_timestamp()),
      worker_locked_by=NULL,worker_locked_at=NULL,updated_at=clock_timestamp()
      FROM mbox.quantity_remake_batches batch WHERE task.tenant_id=$1 AND task.store_id=$2 AND batch.tenant_id=task.tenant_id AND batch.store_id=task.store_id
        AND batch.id=$3 AND task.id=batch.kds_task_id AND task.status NOT IN ('cancelled','failed')
        AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units part WHERE part.tenant_id=batch.tenant_id AND part.store_id=batch.store_id AND part.batch_id=batch.id AND part.cancelled_at IS NULL)`,[...this.scope,batchId])
  }
  async read(batchId:string){
    const batch=(await this.tx.query<{id:string;order_item_id:string;kds_task_id:string}>('SELECT id,order_item_id,kds_task_id FROM mbox.quantity_remake_batches WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,batchId])).rows[0]
    if(!batch)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','重做批次不存在')
    const units=(await this.tx.query<{id:string;unit_id:string;production_state:string;cancelled_at:string|null;held:boolean;stopped:boolean}>(`SELECT part.id,part.unit_id,part.production_state,part.cancelled_at::text,original.held_by_case_id IS NOT NULL AS held,original.operationally_stopped AS stopped
      FROM mbox.quantity_remake_units part JOIN mbox.order_item_quantity_units original ON original.tenant_id=part.tenant_id AND original.store_id=part.store_id AND original.id=part.unit_id
      WHERE part.tenant_id=$1 AND part.store_id=$2 AND part.batch_id=$3 ORDER BY original.unit_index`,[...this.scope,batchId])).rows
    return {id:batch.id,itemId:batch.order_item_id,taskId:batch.kds_task_id,units}
  }
  private async lock(batchId:string,unitIds:readonly string[]){
    if(!unitIds.length||new Set(unitIds).size!==unitIds.length)throw new ItemQuantityConflict('QUANTITY_INVALID','请选择本批实际份数')
    const lookup=await this.read(batchId);await lockQuantityOrder(this.tx,{kind:'item',id:lookup.itemId})
    const current=await this.read(batchId)
    const ids=current.units.filter(unit=>unitIds.includes(unit.id))
    if(ids.length!==unitIds.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','所选份数不属于此重做批次')
    await this.tx.query('SELECT id FROM mbox.quantity_remake_units WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE',[...this.scope,unitIds])
    const active=(await this.tx.query<{active:boolean}>(`SELECT visit.status IN ('open','closing') AND original.status<>'cancelled' AND item.status<>'cancelled' AS active
      FROM mbox.order_items item JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
      JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
      WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3`,[...this.scope,current.itemId])).rows[0]?.active===true
    return {...current,units:ids,active}
  }
  private async stocks(unitIds:readonly string[]){
    const rows=(await this.tx.query<{id:string;remake_unit_id:string;inventory_item_id:string;quantity:string;status:string;source_original_stock_id:string|null;source_remake_stock_id:string|null;consumption_movement_id:string|null}>(`SELECT id,remake_unit_id,inventory_item_id,quantity::text,status,source_original_stock_id,source_remake_stock_id,consumption_movement_id
      FROM mbox.quantity_remake_stocks WHERE tenant_id=$1 AND store_id=$2 AND remake_unit_id=ANY($3::uuid[]) ORDER BY inventory_item_id,id FOR UPDATE`,[...this.scope,unitIds])).rows
    await this.tx.query('SELECT inventory_item_id FROM mbox.inventory_balances WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=ANY($3::uuid[]) ORDER BY inventory_item_id FOR UPDATE',[...this.scope,[...new Set(rows.map(row=>row.inventory_item_id))].sort()])
    return rows
  }
}
