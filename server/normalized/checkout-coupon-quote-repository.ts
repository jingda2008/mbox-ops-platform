import {createHash,randomUUID} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {CheckoutCouponRepository,type CheckoutCouponSelection} from './checkout-coupon-repository.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {CheckoutCartPricingError} from './checkout-cart-pricing.js'
import {CustomerRepository} from './customer-repository.js'

interface QuoteRow extends Record<string,unknown>{id:string;cart_id:string;cart_generation:string;cart_version:string;table_session_id:string;customer_id:string;subtotal_minor:string;discount_minor:string;payable_minor:string;currency:string;expires_at:string;request_fingerprint:string;current:boolean}
export class CheckoutCouponQuoteRepository{
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
  async prepare(input:{customerId:string;tableSessionId:string;expectedGeneration:number;expectedVersion:number;selections:readonly CheckoutCouponSelection[];requestKey:string}){
    if(!/^[A-Za-z0-9:_-]{8,128}$/.test(input.requestKey))throw new CheckoutCartPricingError('报价请求编号无效')
    const customer=await new CustomerRepository(this.tx).resolveCanonical(input.customerId)
    const selections=input.selections.map(s=>({...s})).sort((a,b)=>a.portionId.localeCompare(b.portionId))
    const fingerprint=createHash('sha256').update(JSON.stringify({tableSessionId:input.tableSessionId,customerId:customer.id,generation:input.expectedGeneration,version:input.expectedVersion,selections})).digest('hex')
    const lock=await this.tx.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`coupon-quote:${this.scope.join(':')}:${customer.id}:${input.requestKey}`])
    if(!lock.rows[0]?.ok)throw new CheckoutCartPricingError('同一报价正在处理，请稍后核对')
    const previous=(await this.tx.query<{id:string;request_fingerprint:string}>('SELECT id,request_fingerprint FROM mbox.checkout_coupon_quotes WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND request_key=$4',[...this.scope,customer.id,input.requestKey])).rows[0]
    if(previous){if(previous.request_fingerprint!==fingerprint)throw new CheckoutCartPricingError('同一报价请求的选择已改变，请重新确认');return{...await this.find(previous.id,customer.id),replayed:true}}
    const cart=await new GuestSharedCartRepository(this.tx).readOpen(input.tableSessionId,`GSC${randomUUID().replaceAll('-','').toUpperCase()}`)
    const quote=await new CheckoutCouponRepository(this.tx).quote({...input,customerId:customer.id,cart,channel:'guest_qr'})
    const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.checkout_coupon_quotes(tenant_id,store_id,cart_id,cart_generation,cart_version,table_session_id,customer_id,subtotal_minor,discount_minor,payable_minor,currency,expires_at,request_key,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+interval '2 minutes',$12,$13) RETURNING id`,[...this.scope,cart.id,cart.generation,cart.version,cart.tableSessionId,customer.id,quote.price.subtotalMinor,quote.price.discountMinor,quote.price.payableMinor,quote.currency,input.requestKey,fingerprint])).rows[0]!
    for(const line of quote.lineAllocations){
      const portionId=quote.portionIds[line.requestIndex]!
      await this.tx.query(`INSERT INTO mbox.checkout_coupon_quote_lines(tenant_id,store_id,quote_id,request_index,portion_id,product_id,standard_minor,discount_minor,line_fingerprint,benefit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[...this.scope,row.id,line.requestIndex,portionId,line.productId,line.unitPriceMinor,line.discountAmountMinor,line.lineFingerprint,selections.find(s=>s.portionId===portionId)?.benefitId??null])
    }
    await this.tx.query('INSERT INTO mbox.checkout_coupon_quote_seals(tenant_id,store_id,quote_id) VALUES($1,$2,$3)',[...this.scope,row.id])
    return{...await this.find(row.id,customer.id),replayed:false}
  }
  async find(id:string,customerId:string){
    const customer=await new CustomerRepository(this.tx).resolveCanonical(customerId)
    const row=(await this.tx.query<QuoteRow>(`SELECT q.*,q.expires_at::text,(q.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM mbox.guest_shared_carts c WHERE c.tenant_id=q.tenant_id AND c.store_id=q.store_id AND c.id=q.cart_id AND c.status='open' AND c.generation=q.cart_generation AND c.version=q.cart_version)) AS current FROM mbox.checkout_coupon_quotes q WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.id=$3 AND mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id)=$4`,[...this.scope,id,customer.id])).rows[0]
    if(!row)throw new CheckoutCartPricingError('报价不存在或不属于当前会员')
    const lines=(await this.tx.query<{request_index:number;portion_id:string;product_id:string;standard_minor:string;discount_minor:string;line_fingerprint:string;benefit_id:string|null}>('SELECT * FROM mbox.checkout_coupon_quote_lines WHERE tenant_id=$1 AND store_id=$2 AND quote_id=$3 ORDER BY request_index',[...this.scope,id])).rows
    return{id:row.id,cartId:row.cart_id,generation:Number(row.cart_generation),version:Number(row.cart_version),customerId:customer.id,tableSessionId:row.table_session_id,
      subtotalMinor:Number(row.subtotal_minor),discountMinor:Number(row.discount_minor),payableMinor:Number(row.payable_minor),currency:row.currency,expiresAt:row.expires_at,current:row.current,
      orderAuthorization:false as const,inventoryReserved:false as const,couponsReserved:false as const,
      lines:lines.map(l=>({requestIndex:l.request_index,portionId:l.portion_id,productId:l.product_id,standardMinor:Number(l.standard_minor),discountMinor:Number(l.discount_minor),lineFingerprint:l.line_fingerprint,benefitId:l.benefit_id}))}
  }
}
