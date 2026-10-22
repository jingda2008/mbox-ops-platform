import {randomUUID} from 'node:crypto'
import type {ActivityServiceExceptionCommand,ActivityServiceExceptionResult} from '../../src/shared/activity-service-exception.js'
import {parseActivityServiceException} from '../../src/shared/activity-service-exception.js'
import {appendOutboxMessage} from './command-executor.js'
import {ActivityServiceRepository,ActivityServiceError,assertActivityServiceAvailable} from './activity-service-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {refreshActivityMealNumber} from './activity-service-number.js'

interface Line extends Record<string,unknown> {
  id:string;registration_id:string;meal_id:string;product_id:string;source_ref:string;product_snapshot:Record<string,unknown>
  quantity:number;started_quantity:number;ready_quantity:number;taken_quantity:number;stopped_quantity:number;discarded_ready_quantity:number;remade_taken_quantity:number
  version:number;held:boolean;status:string;station_code:'bar'|'kitchen'
}
interface Destination extends Record<string,unknown> {number:number;business_date:string;plaque_state:string;public_id:string;payment_status:string;service_refund_disposition:string|null;registration_status:string;fee_amount_minor:number;location:string|null}
const reject=(message:string,code='ACTIVITY_EXCEPTION_CONFLICT'):never=>{throw new ActivityServiceError(message,code)}

/** Manager exceptions retain the original paid source, quantities and stock movements. */
export class ActivityServiceExceptionRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
  async execute(input:ActivityServiceExceptionCommand,key:string,employeeId:string):Promise<ActivityServiceExceptionResult> {
    const command=parseActivityServiceException(input),repository=new ActivityServiceRepository(this.tx)
    // Purchase roots first, then child purchases and the physical line: same order as production/door commands.
    await this.tx.query(`SELECT r.id FROM mbox.community_activity_registrations r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id IN
      (SELECT l.registration_id FROM mbox.activity_service_lines l WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.id=$3
       UNION SELECT m.registration_id FROM mbox.activity_service_lines l JOIN mbox.activity_meals m ON (m.tenant_id,m.store_id,m.id)=(l.tenant_id,l.store_id,l.meal_id) WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.id=$3)
      ORDER BY (r.purchase_kind='single_dish'),r.id FOR UPDATE`,[...this.scope,command.lineId])
    const old=await repository.previous<ActivityServiceExceptionResult>('exception',key,command)
    if(old)return old
    const line=(await this.tx.query<Line>('SELECT * FROM mbox.activity_service_lines WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,command.lineId])).rows[0]
    if(!line||line.status!=='active'||line.version!==command.expectedVersion)reject('原出品刚有变化，请重新核对实际数量','ACTIVITY_SERVICE_STALE')
    const source=line!
    // New purchases retain their original category. Older snapshots did not
    // record it; use the existing product category without rewriting history.
    if(!Object.prototype.hasOwnProperty.call(source.product_snapshot,'categoryCode')){
      const product=(await this.tx.query<{category_code:string}>('SELECT category_code FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,source.product_id])).rows[0]
      source.product_snapshot={...source.product_snapshot,categoryCode:product?.category_code??null}
    }
    const destination=(await this.tx.query<Destination>(`SELECT m.number,m.business_date::text,m.plaque_state,m.location,r.public_id,r.payment_status,r.service_refund_disposition,r.status registration_status,r.fee_amount_minor
      FROM mbox.activity_meals m JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=($1,$2,$4)
      WHERE m.tenant_id=$1 AND m.store_id=$2 AND m.id=$3 FOR UPDATE OF m`,[...this.scope,source.meal_id,source.registration_id])).rows[0]!
    if(command.action==='resume'||command.action==='remake') {
      await assertActivityServiceAvailable(this.tx,source.registration_id)
      if(!['confirmed','checked_in'].includes(destination.registration_status)||!(destination.payment_status==='paid'||(destination.payment_status==='refunded'&&destination.service_refund_disposition!==null)||destination.payment_status==='not_required'&&Number(destination.fee_amount_minor)===0))reject('原付款或售后尚未核清，不能恢复制作')
    }
    const receiptId=randomUUID(),quantity=command.quantity??0
    if(command.action==='hold'||command.action==='resume') {
      const held=command.action==='hold'
      if(source.held===held)reject(held?'原出品已经暂停':'原出品没有暂停')
      if(source.taken_quantity+source.discarded_ready_quantity+source.stopped_quantity>=source.quantity)reject('原出品已经处理完毕，无需暂停或恢复')
      await this.tx.query('UPDATE mbox.activity_service_lines SET held=$4,version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,source.id,held])
      await this.notice(source,destination,receiptId,command,source.quantity-source.stopped_quantity)
    } else if(command.action==='cancel_unmade') {
      if(quantity>source.quantity-source.started_quantity-source.stopped_quantity)reject('只能停止仍未开做的实际份数，已做部分请另行核对')
      await this.releaseUnmade(source,quantity)
      await this.tx.query('UPDATE mbox.activity_service_lines SET stopped_quantity=stopped_quantity+$4,version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,source.id,quantity])
      await this.notice(source,destination,receiptId,command,quantity)
    } else if(command.action==='remake') {
      if(source.held)reject('原出品仍暂停，请先核清并恢复')
      if(destination.plaque_state!=='issued')reject('请先落实原号码牌和收餐位置，再安排补做')
      const available=command.remakeFrom==='ready'?source.ready_quantity-source.taken_quantity-source.discarded_ready_quantity:source.taken_quantity-source.remade_taken_quantity
      if(quantity>available)reject('补做数量超过这批尚未处理的实际损耗范围')
      const sourceRef=`remake:${receiptId}`,newLineId=randomUUID()
      await this.reserveRemake(source,quantity,sourceRef)
      const field=command.remakeFrom==='ready'?'discarded_ready_quantity':'remade_taken_quantity'
      await this.tx.query(`UPDATE mbox.activity_service_lines SET ${field}=${field}+$4,version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,source.id,quantity])
      const created=(await this.tx.query<{created_at:string}>(`INSERT INTO mbox.activity_service_lines(id,tenant_id,store_id,meal_id,registration_id,product_id,source_ref,product_snapshot,station_code,quantity)
        VALUES($3,$1,$2,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING created_at::text`,[...this.scope,newLineId,source.meal_id,source.registration_id,source.product_id,sourceRef,JSON.stringify({...source.product_snapshot,name:`补做 · ${String(source.product_snapshot.name??'原菜品')}`,quantity,remakeOfLineId:source.id,remakeReason:command.reason}),source.station_code,quantity])).rows[0]!
      await this.tx.query(`INSERT INTO mbox.kds_tasks(tenant_id,store_id,activity_service_line_id,station_code,quantity,status) VALUES($1,$2,$3,$4,$5,'pending')`,[...this.scope,newLineId,source.station_code,quantity])
      await appendOutboxMessage(this.tx,{businessEventKey:`activity-meal-line:${newLineId}`,aggregateType:'activity_service_line',aggregateId:newLineId,aggregateVersion:1,eventType:'activity.meal.line.created.v1',payload:{lineId:newLineId},occurredAt:created.created_at})
    }
    await this.tx.query(`UPDATE mbox.kds_tasks k SET status=CASE WHEN l.stopped_quantity=l.quantity THEN 'cancelled' WHEN l.ready_quantity+l.stopped_quantity=l.quantity THEN 'ready' WHEN l.started_quantity>0 THEN 'preparing' ELSE 'pending' END,updated_at=clock_timestamp()
      FROM mbox.activity_service_lines l WHERE (k.tenant_id,k.store_id,k.activity_service_line_id)=(l.tenant_id,l.store_id,l.id) AND l.tenant_id=$1 AND l.store_id=$2 AND l.id=$3`,[...this.scope,source.id])
    await refreshActivityMealNumber(this.tx,source.meal_id)
    const result={receiptId,action:command.action,lines:await repository.lines({mealId:source.meal_id})}
    await repository.persist('exception',key,command,result,employeeId,receiptId)
    return result
  }
  private async releaseUnmade(line:Line,quantity:number) {
    const released=(await this.tx.query<{id:string;inventory_item_id:string;amount:string}>(`SELECT id,inventory_item_id,
      LEAST(quantity-consumed_quantity-released_quantity,GREATEST(0,round(quantity*$6::numeric/$7::numeric,6)-released_quantity))::text amount
      FROM mbox.activity_service_inventory WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3 AND product_id=$4 AND source_ref=$5 AND status='reserved' ORDER BY inventory_item_id FOR UPDATE`,[...this.scope,line.registration_id,line.product_id,line.source_ref,line.stopped_quantity+quantity,line.quantity])).rows
    for(const stock of released) {
      if(Number(stock.amount)<=0)continue
      const result=await this.tx.query(`UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-$4::numeric,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND reserved_quantity>=$4::numeric`,[...this.scope,stock.inventory_item_id,stock.amount])
      if(result.rowCount!==1)reject('原菜品预留库存不一致，请先核对库存')
      await this.tx.query(`UPDATE mbox.activity_service_inventory SET released_quantity=released_quantity+$4::numeric,status=CASE WHEN consumed_quantity+released_quantity+$4::numeric>=quantity THEN 'released' ELSE 'reserved' END WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,stock.id,stock.amount])
    }
  }
  private async reserveRemake(line:Line,quantity:number,sourceRef:string) {
    // Reuse the actual original material promise, even if today's recipe has changed.
    const stocks=(await this.tx.query<{inventory_item_id:string;quantity:string}>(`SELECT inventory_item_id,round(quantity*$6::numeric/$7::numeric,6)::text quantity FROM mbox.activity_service_inventory
      WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3 AND product_id=$4 AND source_ref=$5 ORDER BY inventory_item_id FOR UPDATE`,[...this.scope,line.registration_id,line.product_id,line.source_ref,quantity,line.quantity])).rows
    for(const stock of stocks) {
      if(Number(stock.quantity)<=0)continue
      const reserved=await this.tx.query(`UPDATE mbox.inventory_balances balance SET reserved_quantity=reserved_quantity+$4::numeric,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND on_hand_quantity-reserved_quantity>=$4::numeric
        AND EXISTS(SELECT 1 FROM mbox.inventory_items item WHERE (item.tenant_id,item.store_id,item.id)=(balance.tenant_id,balance.store_id,balance.inventory_item_id) AND item.status='active')`,[...this.scope,stock.inventory_item_id,stock.quantity])
      if(reserved.rowCount!==1)reject('补做材料不足，请由领班协调，原损耗记录未被本次覆盖','ACTIVITY_INVENTORY_INSUFFICIENT')
      await this.tx.query(`INSERT INTO mbox.activity_service_inventory(tenant_id,store_id,registration_id,product_id,source_ref,inventory_item_id,quantity,status) VALUES($1,$2,$3,$4,$5,$6,$7::numeric,'reserved')`,[...this.scope,line.registration_id,line.product_id,sourceRef,stock.inventory_item_id,stock.quantity])
    }
  }
  private async notice(line:Line,destination:Destination,id:string,command:ActivityServiceExceptionCommand,quantity:number) {
    const instruction=command.action==='hold'?'暂停后续制作和取走':command.action==='resume'?'继续原剩余，勿重复制作':'停止指定未做份数，已做部分保留'
    const source=await appendOutboxMessage(this.tx,{eventId:id,aggregateType:'item_after_sales_notice',aggregateId:id,aggregateVersion:1,eventType:'item.after_sales.production_notice.v1',occurredAt:new Date().toISOString(),
      payload:{stationCode:line.station_code,categoryCode:typeof line.product_snapshot.categoryCode==='string'?line.product_snapshot.categoryCode:null,ticket:{schemaVersion:1,kind:'production_notice',title:'活动出品处理通知',subtitle:instruction,test:false,issuedAt:new Date().toISOString(),businessDate:destination.business_date,ticketReference:destination.public_id,tableCode:`餐号 ${destination.number}`,guestCount:null,operatorLabel:null,
        lines:[{name:String(line.product_snapshot.name??'原菜品'),quantity,unitAmountMinor:null,totalAmountMinor:null,note:'按原餐号核对实际份数；本票不是另一份原餐。'}],payment:null,totalAmountMinor:null,currency:'CNY',note:`餐号 ${destination.number} · ${command.reason}`}}})
    await this.tx.query(`INSERT INTO mbox.print_source_jobs(tenant_id,store_id,source_outbox_message_id,aggregate_id,ticket_kind) VALUES($1,$2,$3,$4,'production_notice')`,[...this.scope,source,id])
  }
}
