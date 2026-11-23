import type {ScopedTransaction} from './transaction-runner.js'

// Historical ledgers can be inspected before their upgrade to ticket-aware collection.
export async function hasTicketDiningReceipts(tx:ScopedTransaction){
  const result=await tx.query<{available:boolean}>("SELECT to_regprocedure('mbox.ticket_pending_dining(uuid,uuid,uuid)') IS NOT NULL AS available")
  return result.rows[0]?.available===true
}

export async function pendingTicketDining(tx:ScopedTransaction,orderId:string){
  if(!await hasTicketDiningReceipts(tx))return null
  const result=await tx.query<{id:string;amount_minor:string}>('SELECT id,amount_minor FROM mbox.ticket_pending_dining($1,$2,$3)',
    [tx.scope.tenantId,tx.scope.storeId,orderId])
  return result.rows[0]??null
}
