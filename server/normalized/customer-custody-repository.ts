import type { ScopedTransaction } from './transaction-runner.js'
import { BottleCustodyError } from './bottle-custody-policy.js'
import { BottleCustodyRepository } from './bottle-custody-repository.js'
import type { ActivityContactProtectionKeyring } from './personal-contact-protection.js'

/** Customer ownership is checked on every read, including each photograph. */
export class CustomerCustodyRepository {
  constructor(private readonly tx: ScopedTransaction, private readonly protection?: ActivityContactProtectionKeyring) {}
  private get scope() { return [this.tx.scope.tenantId, this.tx.scope.storeId] }
  private owner = 'mbox.canonical_customer_id(o.tenant_id,o.store_id,o.customer_id)=mbox.canonical_customer_id(o.tenant_id,o.store_id,$3)'
  async list(customerId: string, cursor?: string) {
    const rows = (await this.tx.query<{id:string;public_id:string;item_name:string;category_name:string;unit:string;remaining_quantity:string;original_quantity:string;stored_at:string;expires_at:string;status:string}>(`
      SELECT o.id,o.public_id,o.item_name,c.name AS category_name,o.unit,
        o.remaining_quantity::text,o.original_quantity::text,o.stored_at::text,o.expires_at::text,o.status
      FROM mbox.bottle_custody_orders o
      JOIN mbox.bottle_custody_categories c ON c.tenant_id=o.tenant_id AND c.store_id=o.store_id AND c.id=o.category_id
      WHERE o.tenant_id=$1 AND o.store_id=$2 AND ${this.owner}
        AND ($4::uuid IS NULL OR (o.stored_at,o.id)<(SELECT p.stored_at,p.id FROM mbox.bottle_custody_orders p
          WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$4
          AND mbox.canonical_customer_id(p.tenant_id,p.store_id,p.customer_id)=mbox.canonical_customer_id(p.tenant_id,p.store_id,$3)))
      ORDER BY o.stored_at DESC,o.id DESC LIMIT 21`, [...this.scope,customerId,cursor??null])).rows
    return {items:rows.slice(0,20),nextCursor:rows.length>20?rows[19]!.id:null}
  }
  private async assertOwner(customerId:string,id:string) {
    const row = (await this.tx.query(`SELECT o.id FROM mbox.bottle_custody_orders o
      WHERE o.tenant_id=$1 AND o.store_id=$2 AND ${this.owner} AND o.id=$4`,[...this.scope,customerId,id])).rows[0]
    if (!row) throw new BottleCustodyError('存酒单不存在或不属于当前会员','CUSTODY_NOT_FOUND',404)
  }
  async detail(customerId:string,id:string) {
    await this.assertOwner(customerId,id)
    const {order,events,collections,deposits} = await new BottleCustodyRepository(this.tx).detail(id)
    const phones = (await this.tx.query<{id:string;encrypted_phone:Buffer;phone_hash:string;phone_key_id:string}>(
      'SELECT id,encrypted_phone,phone_hash,phone_key_id FROM mbox.bottle_custody_deposits WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3',
      [...this.scope,id])).rows
    if (phones.length && !this.protection) throw new BottleCustodyError('存酒联系号码暂时无法读取，请重试','CUSTODY_CONTACT_UNAVAILABLE',503)
    const phoneByDeposit = new Map(phones.map(p=>[p.id,this.protection!.reveal({encryptedContact:p.encrypted_phone,contactHash:p.phone_hash,encryptionKeyId:p.phone_key_id})]))
    const restoredIds=collections.map(c=>c.restored_order_id).filter(Boolean)
    const restoredOrders=restoredIds.length?(await this.tx.query<{id:string;public_id:string}>(
      `SELECT o.id,o.public_id FROM mbox.bottle_custody_orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND ${this.owner} AND o.id=ANY($4::uuid[])`,
      [...this.scope,customerId,restoredIds])).rows:[]
    const restoredNumbers=new Map(restoredOrders.map(o=>[o.id,o.public_id]))
    const source = order.source_order_id ? (await this.tx.query<{public_id:string}>(
      'SELECT public_id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,order.source_order_id])).rows[0]?.public_id : null
    // Explicit presentation fields exclude verification codes, delivery diagnostics and internal customer/employee IDs.
    return {
      order:{id:order.id,public_id:order.public_id,member_no:order.member_no,item_name:order.item_name,
        category_name:order.category_name,unit:order.unit,original_quantity:order.original_quantity,
        remaining_quantity:order.remaining_quantity,stored_at:order.stored_at,expires_at:order.expires_at,
        status:order.status,location:order.location,note:order.note,source_reference:order.source_reference,
        source_order_number:source??null,declared_value_minor:order.declared_value_minor,
        extra_fields:order.extra_fields,extra_field_snapshot:order.extra_field_snapshot},
      deposits:deposits.map(d=>({id:d.id,quantity:d.quantity,fraction_label:d.fraction_label,phone:phoneByDeposit.get(String(d.id))??null,
        recorded_at:d.recorded_at,watermark:d.watermark})),
      collections:collections.map(c=>({id:c.id,quantity:c.quantity,returned_quantity:c.returned_quantity,
        status:c.status,collected_at:c.collected_at,restored_order_number:restoredNumbers.get(String(c.restored_order_id))??null})),
      events:events.map(e=>({event_type:e.event_type,quantity:e.quantity,employee_name:e.employee_name,
        reason:typeof e.reason==='string'?e.reason.replace(/再存新单ID=([0-9a-f-]{36})/gi,(_match,id:string)=>`再存单号：${restoredNumbers.get(id)??'请联系门店核对'}`):null,occurred_at:e.occurred_at})),
    }
  }
  async photo(customerId:string,id:string,depositId:string) {
    await this.assertOwner(customerId,id)
    return new BottleCustodyRepository(this.tx).photo(id,depositId)
  }
}
