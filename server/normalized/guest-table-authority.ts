import type { ScopedTransaction } from './transaction-runner.js'

const GUEST_SESSION_REF = /^guest-session:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export function guestSessionIdFromActorRef(actorRef: string | null | undefined): string | null {
  if (actorRef === undefined || actorRef === null) return null
  return GUEST_SESSION_REF.exec(actorRef.trim())?.[1] ?? null
}

export function requireGuestSessionIdFromActorRef(actorRef: string | null | undefined): string {
  const id=guestSessionIdFromActorRef(actorRef)
  if (id===null) throw new Error('Authenticated table guest session authority is required')
  return id
}

export async function lockBoundGuestTablePosition(
  transaction: ScopedTransaction,
  input: Readonly<{ tableSessionId: string; customerId: string; actorRef: string | null | undefined }>,
): Promise<boolean> {
  const guestSessionId=guestSessionIdFromActorRef(input.actorRef)
  if (guestSessionId===null) return false
  const result=await transaction.query<{ participation_id: string | null }>(`
    SELECT mbox.lock_active_table_guest_session_position($1::uuid,$2::uuid,$3::uuid)
      AS participation_id
  `,[input.tableSessionId,input.customerId,guestSessionId])
  return result.rows[0]?.participation_id!==null
}
