import type {ScopedTransaction} from './transaction-runner.js'

// Historical ledgers can be inspected before their upgrade to ticket-aware collection.
export const ticketDiningAvailableSql="to_regprocedure('mbox.ticket_pending_dining(uuid,uuid,uuid)') IS NOT NULL"

export async function pendingTicketDining(tx:ScopedTransaction,orderId:string){
  const result=await tx.query<{id:string;amount_minor:string}>('SELECT id,amount_minor FROM mbox.ticket_pending_dining($1,$2,$3)',
    [tx.scope.tenantId,tx.scope.storeId,orderId])
  return result.rows[0]??null
}
