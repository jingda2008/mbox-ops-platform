import { createHash } from 'node:crypto'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import { ChannelGiftInventory } from './channel-gift-inventory.js'
import { ChannelPricingRepository } from './channel-pricing-repository.js'
import { ChannelDistributionError } from './channel-distribution-policy.js'
import { assertEmployeeTableSessionAccess } from './employee-table-access.js'
import type { CommerceCommandService } from './commerce-command-service.js'
import type { ScopedTransaction } from './transaction-runner.js'

export async function fulfillChannelGift(tx:ScopedTransaction,commerce:Pick<CommerceCommandService,'submitOrderInTransaction'>,input:{claimId:string;tableSessionId:string;employeeId:string;businessDate:string}){
 const repo=new ChannelDistributionRepository(tx);await repo.lockIdentity()
 await assertEmployeeTableSessionAccess(tx,{employeeId:input.employeeId,tableSessionId:input.tableSessionId,requiredPermissionCodes:['channel.activate','order.create'],lockTableSession:true})
 const args=[tx.scope.tenantId,tx.scope.storeId]
 const promise=(await tx.query<{product_id:string;quantity:number;order_id:string|null;state:string}>(`SELECT g.product_id,g.quantity,g.order_id,g.state FROM mbox.channel_gift_promises g
  JOIN mbox.channel_activations a ON (a.tenant_id,a.store_id,a.claim_id)=(g.tenant_id,g.store_id,g.claim_id)
  JOIN mbox.channel_visit_tables t ON (t.tenant_id,t.store_id,t.visit_id)=(a.tenant_id,a.store_id,a.visit_id)
  WHERE g.tenant_id=$1 AND g.store_id=$2 AND g.claim_id=$3 AND a.status IN('active','fulfilled') AND t.table_session_id=$4 AND t.detached_at IS NULL FOR UPDATE OF g`,[...args,input.claimId,input.tableSessionId])).rows[0]
 if(!promise)throw new ChannelDistributionError('OWNERSHIP',403)
 if(promise.order_id)return{result:{orderId:promise.order_id,claimId:input.claimId,replayed:true},auditEvents:[],outboxMessages:[]}
 if(!await new ChannelGiftInventory(tx).release(input.claimId,true))throw new ChannelDistributionError('VERSION_CONFLICT')
 const pricing=new ChannelPricingRepository(tx),lines=[{productId:promise.product_id,quantity:promise.quantity}]
 const quoteId=await pricing.prepareGift({tableSessionId:input.tableSessionId,channel:'cashier',actorRef:`employee:${input.employeeId}`,lines},input.claimId)
 const outcome=await commerce.submitOrderInTransaction(tx,{scope:tx.scope,actor:{type:'employee',employeeId:input.employeeId},businessDate:input.businessDate,
  idempotencyKey:`channel-gift:${input.claimId}`,publicId:`channel-gift-${createHash('sha256').update(input.claimId).digest('hex').slice(0,40)}`,
  tableSessionId:input.tableSessionId,channel:'cashier',settlementMode:'immediate_payment',createdByEmployeeId:input.employeeId,lines,
  pricingAuthorization:{sourceType:'channel_quote',sourceId:quoteId},note:`渠道赠品；原券 ${input.claimId}`})
 await repo.event(input.claimId,'gift.ordered',`employee:${input.employeeId}`,{orderId:outcome.result.order.id,tableSessionId:input.tableSessionId})
 return{result:{orderId:outcome.result.order.id,claimId:input.claimId,replayed:false},auditEvents:outcome.auditEvents,outboxMessages:outcome.outboxMessages}
}
