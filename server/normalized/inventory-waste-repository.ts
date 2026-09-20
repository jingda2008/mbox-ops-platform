import type {ScopedTransaction} from './transaction-runner.js';
import {InventoryRepository,InventoryConflictError,InventoryNotFoundError} from './inventory-repository.js';
import type {WasteResult,WasteType} from '../../src/shared/inventory-waste.js';

export class InventoryWasteRepository {
  constructor(private readonly transaction:ScopedTransaction){}
  async submit(itemId:string,quantity:string,employeeId:string,reason:string,wasteType:WasteType):Promise<WasteResult>{
    const {tenantId,storeId}=this.transaction.scope;
    const item=await this.transaction.query<{needs_review:boolean}>(`SELECT $4::numeric>reasonable_waste_quantity AS needs_review
      FROM mbox.inventory_items WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active' FOR SHARE`,[tenantId,storeId,itemId,quantity]);
    if(!item.rows[0])throw new InventoryNotFoundError('inventory item',itemId);
    if(!item.rows[0].needs_review)return {status:'recorded',...await new InventoryRepository(this.transaction).recordWaste(itemId,quantity,employeeId,reason,false,wasteType)};
    const result=await this.transaction.query<{id:string}>(`INSERT INTO mbox.inventory_waste_requests
      (tenant_id,store_id,inventory_item_id,quantity,waste_type,reason,requested_by_employee_id)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::numeric,$5,$6,$7::uuid) RETURNING id`,[tenantId,storeId,itemId,quantity,wasteType,reason,employeeId]);
    return {id:result.rows[0]!.id,status:'pending'};
  }
  async decide(id:string,employeeId:string,decision:'approve'|'reject',reason:string){
    const {tenantId,storeId}=this.transaction.scope;
    const result=await this.transaction.query<{inventory_item_id:string;quantity:string;waste_type:WasteType;reason:string;requested_by_employee_id:string;status:string}>(
      `SELECT inventory_item_id,quantity::text,waste_type,reason,requested_by_employee_id,status FROM mbox.inventory_waste_requests
       WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE`,[tenantId,storeId,id]);
    const request=result.rows[0];
    if(!request)throw new InventoryNotFoundError('waste request',id);
    if(request.requested_by_employee_id===employeeId)throw new InventoryConflictError('不能审批自己登记的损耗，请交由另一位有审批权限的人员处理');
    if(request.status!=='pending')throw new InventoryConflictError('这笔损耗已处理，请刷新审批记录');
    if(reason.trim().length<2)throw new TypeError('请填写至少两个字的审批说明');
    // The balance is locked and checked again now, never trusted from application time.
    const movement=decision==='approve'?await new InventoryRepository(this.transaction).recordWaste(request.inventory_item_id,request.quantity,employeeId,request.reason,true,request.waste_type):null;
    const status=decision==='approve'?'approved':'rejected';
    await this.transaction.query(`UPDATE mbox.inventory_waste_requests SET status=$4,decided_by_employee_id=$5::uuid,
      decided_at=clock_timestamp(),decision_reason=$6,movement_id=$7::uuid WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
      [tenantId,storeId,id,status,employeeId,reason.trim(),movement?.movementId??null]);
    return {id,status,movementId:movement?.movementId??null};
  }
}
