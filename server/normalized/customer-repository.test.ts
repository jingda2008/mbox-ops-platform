import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  CustomerCommandService,
  CustomerIdentityConflictError,
  CustomerRepository,
} from './customer-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('CustomerRepository normalized identity and profile integrity', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let customers: CustomerCommandService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    customers = new CustomerCommandService(new NormalizedCommandExecutor(transactions))
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Customer Tenant')`,
      [tenantId, `customer-${tenantId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Customer Store')`,
      [storeId, tenantId, `store-${storeId.slice(0, 8)}`])
  })

  afterAll(async () => pool?.end())

  it('deduplicates concurrent anonymous identity creation and stores only a hash', async () => {
    const identityHash = 'a'.repeat(64)
    const create = (suffix: string) => customers.createAnonymous({
      scope: { tenantId, storeId },
      actor: { type: 'guest' as const, ref: `guest-${suffix}` },
      businessDate: '2026-08-11',
      publicId: `anonymous-public-${suffix}`,
      identityHash,
      profile: { displayName: 'Guest', preferences: { drinkStyle: 'dry' } },
      idempotencyKey: `customer-concurrent-${suffix}-0001`,
      requestFingerprint: `fingerprint-${suffix}`,
    })
    const outcomes = await Promise.all([create('one'), create('two')])
    expect(new Set(outcomes.map((outcome) => outcome.value.customer.id)).size).toBe(1)

    const evidence = await pool.query<{ customers: string; identities: string; raw_columns: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.customers WHERE tenant_id = $1 AND store_id = $2) AS customers,
        (SELECT count(*)::text FROM mbox.customer_identities
          WHERE tenant_id = $1 AND store_id = $2 AND identity_hash = $3) AS identities,
        (SELECT count(*)::text FROM mbox.customer_identities
          WHERE tenant_id = $1 AND store_id = $2 AND identity_hash !~ '^[0-9a-f]{64}$') AS raw_columns
    `, [tenantId, storeId, identityHash])
    expect(evidence.rows[0]).toEqual({ customers: '1', identities: '1', raw_columns: '0' })
  })

  it('normalizes tags and visibility-aware preferences and provides queryable history', async () => {
    const created = await customers.createAnonymous(customerCommand('profile', 'b'))
    const updated = await customers.updateProfile({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'profile-test' },
      businessDate: '2026-08-11',
      customerId: created.value.customer.id,
      profile: {
        tags: ['老客'],
        publicTags: ['香槟偏好'],
        preferences: { publicScene: 'date', internalRisk: 'do-not-leak' },
        publicPreferenceKeys: ['publicScene'],
      },
      reason: '客户主动补充偏好',
      idempotencyKey: 'customer-profile-update-0001',
      requestFingerprint: 'profile-update-fingerprint',
    })
    expect(updated.value.profile.tags).toEqual(['老客', '香槟偏好'])
    expect(updated.value.profile.publicTags).toEqual(['香槟偏好'])
    expect(updated.value.profile.publicPreferences).toEqual({ publicScene: 'date' })

    const query = await transactions.run({ tenantId, storeId }, async (transaction) => {
      const repository = new CustomerRepository(transaction)
      return {
        publicCustomer: await repository.findPublicById(created.value.customer.id),
        history: await repository.listHistory(created.value.customer.id),
      }
    }, { readOnly: true })
    expect(query.publicCustomer?.preferences).toEqual({ publicScene: 'date' })
    expect(JSON.stringify(query.publicCustomer)).not.toContain('internalRisk')
    expect(query.history.map((event) => event.eventType)).toContain('customer.profile-updated')
  })

  it('links multiple hashed identities, rejects cross-customer reuse, and prevents merge cycles', async () => {
    const source = await customers.createAnonymous(customerCommand('merge-source', 'c'))
    const target = await customers.createAnonymous(customerCommand('merge-target', 'd'))
    await customers.linkIdentity({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'wechat-link' },
      businessDate: '2026-08-11',
      customerId: target.value.customer.id,
      identityKind: 'wechat',
      identityHash: 'e'.repeat(64),
      reason: '微信账号完成授权绑定',
      idempotencyKey: 'customer-wechat-link-0001',
      requestFingerprint: 'wechat-link-fingerprint',
    })
    await expect(customers.linkIdentity({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'wechat-link-conflict' },
      businessDate: '2026-08-11',
      customerId: source.value.customer.id,
      identityKind: 'wechat',
      identityHash: 'e'.repeat(64),
      reason: '错误绑定尝试',
      idempotencyKey: 'customer-wechat-link-conflict-0001',
      requestFingerprint: 'wechat-link-conflict-fingerprint',
    })).rejects.toBeInstanceOf(CustomerIdentityConflictError)

    await customers.merge({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'identity-merge' },
      businessDate: '2026-08-11',
      sourceCustomerId: source.value.customer.id,
      targetCustomerId: target.value.customer.id,
      reason: '确认属于同一客户',
      idempotencyKey: 'customer-merge-normalized-0001',
      requestFingerprint: 'customer-merge-normalized-fingerprint',
    })
    const merged = await transactions.run({ tenantId, storeId }, (transaction) =>
      new CustomerRepository(transaction).resolveCanonical(source.value.customer.id), { readOnly: true })
    expect(merged.id).toBe(target.value.customer.id)
    expect(merged.identities.map((identity) => identity.kind).sort()).toEqual(['anonymous', 'anonymous', 'wechat'])

    await expect(pool.query(`
      UPDATE mbox.customers SET status = 'merged', merged_into_customer_id = $1
      WHERE id = $2
    `, [source.value.customer.id, target.value.customer.id])).rejects.toMatchObject({ code: '23514' })
  })

  function customerCommand(suffix: string, hashCharacter: string) {
    return {
      scope: { tenantId, storeId },
      actor: { type: 'system' as const, ref: 'customer-test' },
      businessDate: '2026-08-11',
      publicId: `anonymous-customer-${suffix}`,
      identityHash: hashCharacter.repeat(64),
      profile: { displayName: `Guest ${suffix}`, tags: [suffix] },
      idempotencyKey: `customer-create-${suffix}-0001`,
      requestFingerprint: `customer-fingerprint-${suffix}`,
    }
  }
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
