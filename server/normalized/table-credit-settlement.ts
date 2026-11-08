import type {ScopedTransaction} from './transaction-runner.js'
import type {OutboxMessage} from './command-executor.js'
import {TablePrepaymentRepository} from './table-prepayment-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {PaymentFulfillmentRepository} from './payment-fulfillment-repository.js'
import {LoyaltyAccrualRepository} from './loyalty-accrual-repository.js'
import {RecommendationFinancialAttributionRepository} from './recommendation-financial-attribution-repository.js'

/** Spending existing receipts creates allocations and fulfillment, never cash entries. */
export async function settleTableCreditOrders(tx:ScopedTransaction,paymentId:string,occurredAt:string):Promise<OutboxMessage[]>{
 const scope=[tx.scope.tenantId,tx.scope.storeId]
 const source=(await tx.query<{session_id:string;status:string}>(`SELECT p.prepaid_table_session_id session_id,s.status FROM mbox.payments p JOIN mbox.table_sessions s ON(s.tenant_id,s.store_id,s.id)=(p.tenant_id,p.store_id,p.prepaid_table_session_id) WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$3`,[...scope,paymentId])).rows[0]
 if(!source||source.status!=='open')return[]
 const repo=new TablePrepaymentRepository(tx);const session=await repo.lock(source.session_id,true);if(session.status!=='open')return[]
 const orders=(await tx.query<{id:string}>(`SELECT o.id FROM mbox.table_credit_order_links l JOIN mbox.orders o ON(o.tenant_id,o.store_id,o.id)=(l.tenant_id,l.store_id,l.order_id) WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.table_session_id=$3 AND o.status NOT IN('cancelled','draft') AND o.payment_status NOT IN('paid','partially_refunded','refunded') ORDER BY o.created_at,o.id FOR UPDATE OF o`,[...scope,source.session_id])).rows
 const messages:OutboxMessage[]=[]
 for(const order of orders){
  const allocation=await repo.allocate(source.session_id,order.id,true)
  const payments=new PaymentRepository(tx)
  if(!await payments.hasSettledConsumption(order.id))continue
  const activation=await new PaymentFulfillmentRepository(tx).activatePaidOrder(order.id,{paymentId:allocation.paymentIds[0]??paymentId,metadata:{settlementKind:'table_prepayment'}})
  if(activation.financialAttributionEligible){
   await new LoyaltyAccrualRepository(tx).recordPaidOrder({paymentId:allocation.paymentIds[0]??paymentId,orderId:order.id,occurredAt})
   await new RecommendationFinancialAttributionRepository(tx).recordPaidForOrder({paymentId:allocation.paymentIds[0]??paymentId,orderId:order.id,actorRef:`payment:${paymentId}`})
  }
  if(activation.activated)messages.push({businessEventKey:`credit-fulfillment:${order.id}`,aggregateType:'order',aggregateId:order.id,aggregateVersion:2,eventType:'order.fulfillment_activated_after_payment.v1',payload:{orderId:order.id,settlementKind:'table_prepayment',paymentIds:allocation.paymentIds,inventoryMovementCount:activation.inventoryConsumptions.length,kdsTaskCount:activation.kdsTasks.length}})
 }
 return messages
}
