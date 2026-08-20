import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

export async function seedActiveGuestTableAuthority(
  pool: Pool,
  input: Readonly<{
    tenantId: string
    storeId: string
    tableSessionId: string
    customerId: string
    guestSessionId?: string
  }>,
): Promise<string> {
  const guestSessionId=input.guestSessionId ?? randomUUID()
  const digest=(domain: string) => createHash('sha256')
    .update(`${domain}:${guestSessionId}`,'utf8').digest('hex')
  await pool.query(`
    INSERT INTO mbox.guest_sessions(
      id,tenant_id,store_id,session_kind,customer_id,table_session_id,
      token_hash,device_hash,scopes,issued_at,expires_at,last_seen_at
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'table',$4::uuid,$5::uuid,
      $6::char(64),$7::char(64),ARRAY[
        'guest.session.read','guest.menu.read','guest.order.create',
        'guest.service.create','guest.song.request'
      ]::text[],clock_timestamp(),clock_timestamp()+interval '90 minutes',clock_timestamp()
    )
  `,[guestSessionId,input.tenantId,input.storeId,input.customerId,input.tableSessionId,
    digest('token'),digest('device')])
  await pool.query(`
    INSERT INTO mbox.guest_session_events(
      tenant_id,store_id,guest_session_id,table_id,table_session_id,
      event_type,outcome,metadata
    )
    SELECT $1::uuid,$2::uuid,$3::uuid,session.table_id,$4::uuid,
      'guest_session.issued','succeeded','{"kind":"table","source":"integration_fixture"}'::jsonb
    FROM mbox.table_sessions session
    WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid AND session.id=$4::uuid
  `,[input.tenantId,input.storeId,guestSessionId,input.tableSessionId])
  return `guest-session:${guestSessionId}`
}
