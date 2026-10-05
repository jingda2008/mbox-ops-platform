import { PRINT_TICKET_KINDS, type PrintTicketPolicy } from '../../src/shared/print-ticket-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'

export async function lockPrintTicketPolicy(tx: ScopedTransaction, ticketKind: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
    [`${tx.scope.tenantId}:${tx.scope.storeId}`,`print-ticket-policy:${ticketKind}`])
  // Keep the existing-row lock compatible with older writers as well.
  await tx.query('SELECT ticket_kind FROM mbox.print_ticket_policies WHERE tenant_id=$1 AND store_id=$2 AND ticket_kind=$3 FOR UPDATE',
    [tx.scope.tenantId,tx.scope.storeId,ticketKind])
}

export async function readPrintTicketPolicies(tx: ScopedTransaction): Promise<PrintTicketPolicy[]> {
  const rows=(await tx.query<PrintTicketPolicy & Record<string,unknown>>(`
    SELECT p.ticket_kind AS "ticketKind",p.enabled,
      CASE WHEN i.ticket_kind IS NOT NULL THEN NULL ELSE p.copies END AS copies
    FROM mbox.print_ticket_policies p
    LEFT JOIN mbox.print_ticket_policy_inheritance i USING(tenant_id,store_id,ticket_kind)
    WHERE p.tenant_id=$1 AND p.store_id=$2`,[tx.scope.tenantId,tx.scope.storeId])).rows
  return PRINT_TICKET_KINDS.map(ticketKind=>rows.find(row=>row.ticketKind===ticketKind)??{ticketKind,enabled:true,copies:null})
}

export async function writePrintTicketPolicy(tx: ScopedTransaction, policy: PrintTicketPolicy): Promise<void> {
  const {ticketKind,enabled,copies}=policy
  if(copies===null&&enabled) {
    await tx.query('DELETE FROM mbox.print_ticket_policies WHERE tenant_id=$1 AND store_id=$2 AND ticket_kind=$3',
      [tx.scope.tenantId,tx.scope.storeId,ticketKind])
  } else {
    await tx.query(`INSERT INTO mbox.print_ticket_policies(tenant_id,store_id,ticket_kind,enabled,copies)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,store_id,ticket_kind) DO UPDATE
      SET enabled=EXCLUDED.enabled,copies=EXCLUDED.copies,updated_at=clock_timestamp()`,
    [tx.scope.tenantId,tx.scope.storeId,ticketKind,enabled,copies??1])
  }
  if(copies===null) {
    // Retain the policy-change cutoff even when inheritance removes the legacy
    // override, so old unmaterialized payment events do not print on re-enable.
    await tx.query(`INSERT INTO mbox.print_ticket_policy_inheritance(tenant_id,store_id,ticket_kind)
      VALUES($1,$2,$3) ON CONFLICT(tenant_id,store_id,ticket_kind) DO UPDATE SET updated_at=clock_timestamp()`,
    [tx.scope.tenantId,tx.scope.storeId,ticketKind])
  }
}
