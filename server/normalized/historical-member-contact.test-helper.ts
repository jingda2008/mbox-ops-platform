import { randomBytes } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'

/** Reproduce a verified duplicate that predates the enrollment guard. */
export async function seedHistoricalDuplicateContact(tx: ScopedTransaction, source: string, duplicate: string) {
  const result = await tx.query(`
    INSERT INTO mbox.customer_verified_contacts(
      tenant_id,store_id,customer_id,contact_type,contact_hash,encrypted_value,encryption_key_version,
      contact_encryption_key_id,masked_value,verification_source,verified_by_employee_id,verified_at,
      provider_reference_sha256
    ) SELECT tenant_id,store_id,$4,'phone',contact_hash,encrypted_value,encryption_key_version,
      contact_encryption_key_id,masked_value,'staff_controlled',verified_by_employee_id,verified_at,$5
    FROM mbox.customer_verified_contacts WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3
      AND processing_status='active' AND verification_source='staff_controlled'
  `, [tx.scope.tenantId, tx.scope.storeId, source, duplicate, randomBytes(32).toString('hex')])
  if (result.rowCount !== 1) throw new Error('Expected one verified historical phone fixture')
}
