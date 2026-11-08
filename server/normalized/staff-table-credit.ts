import {assertEmployeeTableSessionAccess,assertEmployeeTableSessionReadAccess} from './employee-table-access.js'
import {randomUUID} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {TablePrepaymentRepository,TablePrepaymentError} from './table-prepayment-repository.js'
import {PaymentRepository,type PaymentProvider,type PaymentMethod} from './payment-repository.js'
import {ReconciliationRepository} from './reconciliation-repository.js'
import {settleTableCreditOrders} from './table-credit-settlement.js'

export type StaffCreditInput={sessionId:string;employeeId:string;amountMinor:number;expectedLocationVersion:number;expectedMinimumMinor:number;orderIds:string[];payerReference:string;sharedTableConsent:true;provider:PaymentProvider;method:PaymentMethod;receiptReference?:string;terminalId?:string;externalMethodCode?:string;collectionNote?:string;publicId:string;businessDate:string}
export async function assertStaffCreditAccess(tx:ScopedTransaction,employee:string,provider:PaymentProvider|undefined,sessionId:string,readOnly=false){
 await new StaffAccessRepository(tx).assertPermission(employee,'payment.initiate.staff')
 await (readOnly?assertEmployeeTableSessionReadAccess:assertEmployeeTableSessionAccess)(tx,{employeeId:employee,tableSessionId:sessionId,allTablePermissionCodes:['payment.collect.all_tables'],includeTableViewAll:false,...(readOnly?{}:{lockTableSession:true})})
 if(provider&&['cash','physical_pos','external_manual'].includes(provider))await new StaffAccessRepository(tx).assertPermission(employee,provider==='cash'?'payment.manual.cash.record':provider==='physical_pos'?'payment.manual.pos.record':'payment.manual.external.record')
}
export async function readStaffCredit(tx:ScopedTransaction,sessionId:string){
 const scope=[tx.scope.tenantId,tx.scope.storeId]
 const session=(await tx.query<{id:string;tableCode:string;locationVersion:number;minimumMinor:string;status:string}>(`SELECT s.id,t.code AS "tableCode",s.location_version::int AS "locationVersion",s.effective_minimum_spend_minor::text AS "minimumMinor",s.status FROM mbox.table_sessions s JOIN mbox.tables t ON(t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id) WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3`,[...scope,sessionId])).rows[0]
 if(!session)throw new TablePrepaymentError('TABLE_CREDIT_NOT_FOUND','桌次不存在')
 const orders=(await tx.query(`SELECT o.id,o.public_id AS "publicId",EXISTS(SELECT 1 FROM mbox.table_credit_order_links l WHERE(l.tenant_id,l.store_id,l.order_id)=(o.tenant_id,o.store_id,o.id)) AS linked,GREATEST(0,mbox.order_financial_receivable_amount(o.tenant_id,o.store_id,o.id)-COALESCE((SELECT sum(p.amount_minor) FROM mbox.order_payment_facts p WHERE(p.tenant_id,p.store_id,p.order_id)=(o.tenant_id,o.store_id,o.id) AND p.status IN('succeeded','partially_refunded','refunded')),0))::text AS "dueMinor" FROM mbox.orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.table_session_id=$3 AND o.channel IN('staff_assisted','cashier') AND o.status NOT IN('draft','cancelled') AND o.payment_status IN('unpaid','pending','partially_paid') ORDER BY o.created_at,o.id`,[...scope,sessionId])).rows
 const pending=(await tx.query(`SELECT id,public_id AS "publicId",amount_minor::text AS "amountMinor",method,status FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND prepaid_table_session_id=$3 AND status IN('created','pending') ORDER BY created_at`,[...scope,sessionId])).rows
 return{session,orders,pending,prepayment:await new TablePrepaymentRepository(tx).snapshot(sessionId)}
}
export async function collectStaffCredit(tx:ScopedTransaction,input:StaffCreditInput){
 await assertStaffCreditAccess(tx,input.employeeId,input.provider,input.sessionId)
 if(!input.sharedTableConsent||input.payerReference.trim().length<2||input.payerReference.length>200||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0||input.amountMinor>100_000_000)throw new TablePrepaymentError('TABLE_CREDIT_INVALID','请核对收款金额、付款人及本桌共享授权')
 const scope=[tx.scope.tenantId,tx.scope.storeId],repo=new TablePrepaymentRepository(tx)
 await repo.lock(input.sessionId)
 const current=await readStaffCredit(tx,input.sessionId)
 if(current.session.locationVersion!==input.expectedLocationVersion||Number(current.session.minimumMinor)!==input.expectedMinimumMinor)throw new TablePrepaymentError('TABLE_CREDIT_CHANGED','桌位或低消已变化，请刷新核对后重新发起')
 if(current.pending.length)throw new TablePrepaymentError('TABLE_CREDIT_PENDING','存在待确认预付款，请先查询或继续原付款，不能重复收取')
 for(const id of input.orderIds){
  const target=current.orders.find(o=>o.id===id)
  if(!target||Number(target.dueMinor)<=0)throw new TablePrepaymentError('TABLE_CREDIT_ORDER_CHANGED','选定订单已变化，请刷新核对')
  await tx.query('SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...scope,id])
  const refreshed=(await readStaffCredit(tx,input.sessionId)).orders.find(o=>o.id===id)
  if(!refreshed||Number(refreshed.dueMinor)<=0)throw new TablePrepaymentError('TABLE_CREDIT_ORDER_CHANGED','选定订单已结清，请刷新核对后再收款')
  const blocked=(await tx.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN('created','pending')) OR EXISTS(SELECT 1 FROM mbox.order_refund_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3) OR EXISTS(SELECT 1 FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN('requested','approved')) AS blocked`,[...scope,id])).rows[0]?.blocked
  if(blocked)throw new TablePrepaymentError('TABLE_CREDIT_REVIEW_REQUIRED','原订单有待确认付款或售后退款，请先核对，不能用预收款覆盖')
 }
 await tx.query('SELECT mbox.enable_staff_table_credit($1,$2)',[input.sessionId,input.employeeId])
 for(const id of input.orderIds)await tx.query('INSERT INTO mbox.table_credit_order_links(tenant_id,store_id,table_session_id,order_id,employee_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[...scope,input.sessionId,id,input.employeeId])
 // A walk-in payer need not have scanned yet. Keep an explicit receipt identity,
 // never pretend this placeholder is an authenticated WeChat customer.
 const customerId=randomUUID()
 await tx.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[customerId,...scope,`staff-payer-${customerId}`])
 const evidence={source:'staff_table_credit',payerReference:input.payerReference.trim(),collectedByEmployeeId:input.employeeId,receiptReference:input.receiptReference??'',terminalId:input.terminalId??'',externalMethodCode:input.externalMethodCode??'',collectionNote:input.collectionNote??'',sharedTableConsent:'v1',expectedLocationVersion:input.expectedLocationVersion,expectedMinimumMinor:input.expectedMinimumMinor}
 const payment=await new PaymentRepository(tx).createForTablePrepayment({tableSessionId:input.sessionId,customerId,publicId:input.publicId,amountMinor:input.amountMinor,provider:input.provider,method:input.method,evidence,manualEmployeeId:input.employeeId})
 if(payment.status==='succeeded'){
  await new ReconciliationRepository(tx).append({paymentId:payment.id,entryType:'payment',provider:payment.provider,providerReference:payment.providerTransactionId!,amountMinor:payment.amountMinor,currency:payment.currency,businessDate:input.businessDate,occurredAt:payment.succeededAt!,evidenceSnapshot:evidence})
 }
 const messages=payment.status==='succeeded'?await settleTableCreditOrders(tx,payment.id,payment.succeededAt!):[]
 if(payment.status==='succeeded')messages.push({businessEventKey:`staff-credit-receipt:${payment.id}`,aggregateType:'payment',aggregateId:payment.id,aggregateVersion:1,eventType:'payment.manual_recorded.v1',payload:JSON.parse(JSON.stringify(payment))})
 return{payment,messages}
}
