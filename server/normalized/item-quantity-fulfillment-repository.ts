import {synchronizeQuantityItem} from './item-quantity-projection.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemUnitInventoryRepository} from './item-unit-inventory-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** Quantity transitions for the complete after-sales coordinator. The public
 * KDS command must authorize its task and publish the resulting read model and
 * notifications in the same transaction before enabling this path. */
export class ItemQuantityFulfillmentRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}

  async start(input:{itemId:string;taskId:string;employeeId:string;quantity:number;eventKey:string}){
    const {units}=await new ItemQuantityRepository(this.tx).initialize(input.itemId)
    this.requireQuantity(input.quantity)
    const replay=await this.previous(input.taskId,input.eventKey,'quantity.started',input.quantity,input.employeeId)
    if(replay)return replay
    await this.assertTask(input.itemId,input.taskId,input.employeeId,true)
    const remade=await this.remadeUnits(input.itemId)
    const available=units.filter(unit=>!remade.has(unit.id)&&unit.production_state==='unmade'&&!unit.held_by_case_id&&!unit.operationally_stopped)
    if(input.quantity>available.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE',`当前最多可开始制作${available.length}份`)
    const ids=available.slice(0,input.quantity).map(unit=>unit.id)
    await new ItemUnitInventoryRepository(this.tx).consumeUnheldUnits({itemId:input.itemId,unitIds:ids,employeeId:input.employeeId,taskId:input.taskId})
    await synchronizeQuantityItem(this.tx,input.itemId)
    await this.record(input,'quantity.started',ids)
    return {quantity:ids.length,unitIds:ids,replayed:false}
  }

  async complete(input:{itemId:string;taskId:string;employeeId:string;quantity:number;eventKey:string}){
    const ledger=new ItemQuantityRepository(this.tx),{units}=await ledger.initialize(input.itemId)
    this.requireQuantity(input.quantity)
    const replay=await this.previous(input.taskId,input.eventKey,'quantity.ready',input.quantity,input.employeeId)
    if(replay)return replay
    await this.assertTask(input.itemId,input.taskId,input.employeeId,true)
    // Existing started units go first; newly available units follow. Held units
    // cannot consume inventory or be reported as completed by this command.
    const remade=await this.remadeUnits(input.itemId)
    const selectable=units.filter(unit=>!remade.has(unit.id)&&!unit.held_by_case_id&&!unit.operationally_stopped&&['unmade','started'].includes(unit.production_state))
      .sort((a,b)=>Number(a.production_state==='unmade')-Number(b.production_state==='unmade')||a.unit_index-b.unit_index)
    if(input.quantity>selectable.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE',`当前最多可完成${selectable.length}份，其余已完成、暂停或停止`)
    const ids=selectable.slice(0,input.quantity).map(unit=>unit.id)
    await new ItemUnitInventoryRepository(this.tx).consumeUnheldUnits({itemId:input.itemId,unitIds:ids,employeeId:input.employeeId,taskId:input.taskId})
    await this.tx.query(`UPDATE mbox.order_item_quantity_units SET production_state='ready',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])`,[...this.scope,ids])
    await synchronizeQuantityItem(this.tx,input.itemId)
    await this.record(input,'quantity.ready',ids)
    return {quantity:ids.length,unitIds:ids,replayed:false}
  }

  async deliver(input:{itemId:string;taskId:string;employeeId:string;quantity:number;eventKey:string}){
    const {units}=await new ItemQuantityRepository(this.tx).initialize(input.itemId)
    this.requireQuantity(input.quantity)
    const replay=await this.previous(input.taskId,input.eventKey,'quantity.delivered',input.quantity,input.employeeId)
    if(replay)return replay
    await this.assertTask(input.itemId,input.taskId,input.employeeId,false)
    const remade=await this.remadeUnits(input.itemId)
    const selectable=units.filter(unit=>!remade.has(unit.id)&&unit.production_state==='ready'&&!unit.held_by_case_id&&!unit.operationally_stopped)
    if(input.quantity>selectable.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE',`当前最多可送达${selectable.length}份，请核对已备齐且未暂停的商品`)
    const ids=selectable.slice(0,input.quantity).map(unit=>unit.id)
    await this.tx.query(`UPDATE mbox.order_item_quantity_units SET production_state='delivered',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])`,[...this.scope,ids])
    await synchronizeQuantityItem(this.tx,input.itemId)
    await this.record(input,'quantity.delivered',ids)
    return {quantity:ids.length,unitIds:ids,replayed:false}
  }

  private async remadeUnits(itemId:string){
    return new Set((await this.tx.query<{unit_id:string}>(`SELECT part.unit_id FROM mbox.quantity_remake_units part JOIN mbox.quantity_remake_batches batch
      ON batch.tenant_id=part.tenant_id AND batch.store_id=part.store_id AND batch.id=part.batch_id
      WHERE batch.tenant_id=$1 AND batch.store_id=$2 AND batch.order_item_id=$3`,[...this.scope,itemId])).rows.map(row=>row.unit_id))
  }
  private requireQuantity(quantity:number){if(!Number.isSafeInteger(quantity)||quantity<1)throw new ItemQuantityConflict('QUANTITY_INVALID','请选择大于零的实际份数')}
  private async assertTask(itemId:string,taskId:string,employeeId:string,production:boolean){
    const task=(await this.tx.query<{status:string;remake_of_task_id:string|null;assigned_employee_id:string|null;session_status:string}>(`SELECT task.status,task.remake_of_task_id,task.assigned_employee_id,session.status AS session_status
      FROM mbox.kds_tasks task JOIN mbox.order_items item ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
      JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
      JOIN mbox.table_sessions session ON session.tenant_id=original.tenant_id AND session.store_id=original.store_id AND session.id=original.table_session_id
      WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=$3 AND task.order_item_id=$4 FOR UPDATE OF task`,[...this.scope,taskId,itemId])).rows[0]
    if(!task||['cancelled','failed'].includes(task.status)||task.remake_of_task_id||!['open','closing'].includes(task.session_status))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原制作任务或桌次已改变，请读取当前批次后处理')
    if(production){
      if(task.assigned_employee_id&&task.assigned_employee_id!==employeeId)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原制作已由另一位员工接手，请核对原任务')
      await this.tx.query(`UPDATE mbox.kds_tasks SET assigned_employee_id=COALESCE(assigned_employee_id,$4),accepted_at=COALESCE(accepted_at,clock_timestamp()),updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,taskId,employeeId])
    }
  }
  private async previous(taskId:string,key:string,type:string,quantity:number,employeeId:string){
    if(!key.trim()||key.length>160)throw new ItemQuantityConflict('QUANTITY_INVALID','原操作编号无效')
    const previous=(await this.tx.query<{event_type:string;actor_employee_id:string;metadata:{unitIds:string[];quantity:number}}>(`SELECT event_type,actor_employee_id,metadata FROM mbox.kds_task_events WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3 AND idempotency_key=$4`,[...this.scope,taskId,key])).rows[0]
    if(!previous)return null
    if(previous.event_type!==type||previous.actor_employee_id!==employeeId||previous.metadata.quantity!==quantity)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原操作编号已经用于另一动作')
    return {unitIds:previous.metadata.unitIds,quantity:previous.metadata.quantity,replayed:true}
  }
  private async record(input:{taskId:string;employeeId:string;quantity:number;eventKey:string},type:string,ids:string[]){
    await this.tx.query(`INSERT INTO mbox.kds_task_events(tenant_id,store_id,kds_task_id,event_type,actor_employee_id,idempotency_key,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[...this.scope,input.taskId,type,input.employeeId,input.eventKey,JSON.stringify({unitIds:ids,quantity:input.quantity})])
  }
}
