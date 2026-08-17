import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  CustomerNotificationConsentConflictError,
  CustomerNotificationConsentRepository,
} from './customer-notification-consent-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('CustomerNotificationConsentRepository PostgreSQL integration', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const customerId = randomUUID()
  const scope = { tenantId, storeId }

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    await pool.query(`
      INSERT INTO mbox.tenants (id, code, name)
      VALUES ($1, $2, 'Notification consent tenant')
    `, [tenantId, `consent-${tenantId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name)
      VALUES ($1, $2, $3, 'Notification consent store')
    `, [storeId, tenantId, `consent-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.customers (id, tenant_id, store_id, public_id)
      VALUES ($1, $2, $3, $4)
    `, [customerId, tenantId, storeId, `consent-customer-${customerId}`])
  })

  afterAll(async () => pool?.end())

  it('serializes competing grants, records a revocation as a new version, and remains append-only', async () => {
    const grant = () => transactions.run(scope, (transaction) => (
      new CustomerNotificationConsentRepository(transaction).record({
        customerId,
        channel: 'wechat',
        purpose: 'transactional_service',
        decision: 'granted',
        expectedVersion: 0,
        policyVersion: 'customer-notification-v1',
        source: 'member_portal',
        actorType: 'customer',
        actorRef: 'integration-customer-session',
      })
    ))
    const settled = await Promise.allSettled([grant(), grant()])
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find((result) => result.status === 'rejected')
    expect(rejected?.status === 'rejected' ? rejected.reason : null)
      .toBeInstanceOf(CustomerNotificationConsentConflictError)

    const revoked = await transactions.run(scope, (transaction) => (
      new CustomerNotificationConsentRepository(transaction).record({
        customerId,
        channel: 'wechat',
        purpose: 'transactional_service',
        decision: 'revoked',
        expectedVersion: 1,
        policyVersion: 'customer-notification-v1',
        source: 'member_portal',
        actorType: 'customer',
        actorRef: 'integration-customer-session',
      })
    ))
    expect(revoked).toMatchObject({ decision: 'revoked', consentVersion: 2 })
    await expect(transactions.run(scope, (transaction) => (
      new CustomerNotificationConsentRepository(transaction).isGranted(customerId, 'wechat')
    ), { readOnly: true })).resolves.toBe(false)

    const denied = await transactions.run(scope, (transaction) => (
      new CustomerNotificationConsentRepository(transaction).record({
        customerId, channel: 'wechat', purpose: 'transactional_service',
        decision: 'denied', expectedVersion: 2, policyVersion: 'wechat-service-v2',
        source: 'wechat_authorization', sourceReference: 'loyalty_accrual',
        templateId: 'wechat-template-001', authorizationContext: 'loyalty_accrual',
        platformResult: 'reject', platformEventReference: 'wx-event-reference-001',
        actorType: 'customer', actorRef: 'integration-customer-session',
      })
    ))
    expect(denied).toMatchObject({
      decision: 'denied', consentVersion: 3, templateId: 'wechat-template-001',
      authorizationContext: 'loyalty_accrual', platformResult: 'reject',
    })

    const rows = await pool.query<{ purpose: string; decision: string; consent_version: number }>(`
      SELECT purpose, decision, consent_version
      FROM mbox.customer_notification_consents
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND customer_id = $3::uuid
      ORDER BY consent_version
    `, [tenantId, storeId, customerId])
    expect(rows.rows).toEqual([
      { purpose: 'transactional_service', decision: 'granted', consent_version: 1 },
      { purpose: 'transactional_service', decision: 'revoked', consent_version: 2 },
      { purpose: 'transactional_service', decision: 'denied', consent_version: 3 },
    ])
    await expect(pool.query(`
      UPDATE mbox.customer_notification_consents
      SET decision = 'granted'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND customer_id = $3::uuid
    `, [tenantId, storeId, customerId])).rejects.toThrow()
  })
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
