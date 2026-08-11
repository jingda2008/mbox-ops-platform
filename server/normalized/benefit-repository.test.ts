import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { BenefitCommandService, BenefitUnavailableError } from './benefit-repository.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CustomerCommandService } from './customer-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('BenefitRepository normalized grant and redemption integrity', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const tableSessionId = randomUUID()
  const employeeId = randomUUID()
  const roleId = randomUUID()
  const approvalLimitId = randomUUID()
  let pool: Pool
  let customers: CustomerCommandService
  let benefits: BenefitCommandService
  let customerId: string
  const giftOrder = vi.fn(async () => ({ reference: `gift-order-${randomUUID()}` }))

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    const transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    const commands = new NormalizedCommandExecutor(transactions)
    customers = new CustomerCommandService(commands)
    benefits = new BenefitCommandService(commands, { createGiftOrder: giftOrder })
    await seedStore()
    const customer = await customers.createAnonymous({
      scope: { tenantId, storeId }, actor: { type: 'system', ref: 'seed' },
      businessDate: '2026-08-11', publicId: 'benefit-customer-public-0001',
      identityHash: 'f'.repeat(64), idempotencyKey: 'benefit-customer-create-0001',
      requestFingerprint: 'benefit-customer-create-fingerprint',
    })
    customerId = customer.value.customer.id
    await pool.query(`
      INSERT INTO mbox.table_sessions (
        id, tenant_id, store_id, table_id, public_id, business_date, guest_count
      ) VALUES ($1, $2, $3, $4, 'benefit-table-session-0001', '2026-08-11', 2)
    `, [tableSessionId, tenantId, storeId, tableId])
    await pool.query(`
      INSERT INTO mbox.table_session_customers (
        tenant_id, store_id, table_session_id, customer_id, relationship
      ) VALUES ($1, $2, $3, $4, 'primary')
    `, [tenantId, storeId, tableSessionId, customerId])
  })

  afterAll(async () => pool?.end())

  it('requires live permission, approval source, reason and integer approval limit for manual grants', async () => {
    const command = issueCommand('manual-ok', 400, 2)
    const issued = await benefits.issue(command)
    const replay = await benefits.issue(command)
    expect(issued.value).toMatchObject({
      customerId,
      valueAmountMinor: 400,
      quantityTotal: 2,
      quantityAvailable: 2,
      issuanceReason: '客户生日现场关怀',
    })
    expect(replay.replayed).toBe(true)
    await expect(benefits.issue(issueCommand('manual-over-limit', 1_001, 1)))
      .rejects.toThrow('exceeds the employee approval limit')

    const evidence = await pool.query<{ benefits: string; audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.benefits WHERE tenant_id = $1 AND store_id = $2
          AND issuance_idempotency_key LIKE 'benefit-issue-manual-%') AS benefits,
        (SELECT count(*)::text FROM mbox.audit_events WHERE tenant_id = $1 AND store_id = $2
          AND action = 'benefit.issued') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE tenant_id = $1 AND store_id = $2
          AND message_type = 'benefit.issued.v1') AS outbox
    `, [tenantId, storeId])
    expect(evidence.rows[0]).toEqual({ benefits: '1', audits: '1', outbox: '1' })
  })

  it('allows only one concurrent reservation when one unit remains', async () => {
    const issued = await benefits.issue(issueCommand('race', 500, 1))
    const reserve = (suffix: string) => benefits.reserve({
      scope: { tenantId, storeId },
      actor: { type: 'guest' as const, ref: `guest-${suffix}` },
      businessDate: '2026-08-11',
      benefitId: issued.value.id,
      customerId,
      tableSessionId,
      quantity: 1,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      reservationIdempotencyKey: `benefit-reserve-race-${suffix}-0001`,
      reservationFingerprint: `benefit-reserve-race-${suffix}`,
    })
    const outcomes = await Promise.allSettled([reserve('one'), reserve('two')])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(BenefitUnavailableError)
    const balance = await pool.query<{ quantity_reserved: number; quantity_redeemed: number }>(`
      SELECT quantity_reserved, quantity_redeemed FROM mbox.benefits WHERE id = $1
    `, [issued.value.id])
    expect(balance.rows[0]).toEqual({ quantity_reserved: 1, quantity_redeemed: 0 })
  })

  it('binds redemption to the current customer/table, invokes gift order port, and replays safely', async () => {
    const issued = await benefits.issue(issueCommand('redeem', 300, 1))
    const reserved = await benefits.reserve({
      scope: { tenantId, storeId }, actor: { type: 'guest', ref: 'guest-redeem' },
      businessDate: '2026-08-11', benefitId: issued.value.id, customerId, tableSessionId,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      reservationIdempotencyKey: 'benefit-reserve-redeem-0001',
      reservationFingerprint: 'benefit-reserve-redeem-fingerprint',
    })
    const command = {
      scope: { tenantId, storeId }, actor: { type: 'employee' as const, employeeId },
      businessDate: '2026-08-11', benefitId: issued.value.id,
      benefitReservationId: reserved.value.id, customerId, tableSessionId,
      redeemedByEmployeeId: employeeId,
      authorizationSource: { kind: 'employee', permission: 'benefit.redeem' },
      redemptionIdempotencyKey: 'benefit-redeem-bound-0001',
      redemptionFingerprint: 'benefit-redeem-bound-fingerprint',
    }
    const redeemed = await benefits.redeem(command)
    const replay = await benefits.redeem(command)
    expect(redeemed.value).toMatchObject({ customerId, tableSessionId, quantity: 1 })
    expect(replay.replayed).toBe(true)
    expect(giftOrder).toHaveBeenCalledTimes(1)
    expect(giftOrder).toHaveBeenCalledWith(expect.objectContaining({ scope: { tenantId, storeId } }),
      expect.objectContaining({ customerId, tableSessionId, benefitId: issued.value.id }))
    await expect(benefits.redeem({
      ...command,
      redemptionIdempotencyKey: 'benefit-redeem-bound-second-0001',
      redemptionFingerprint: 'benefit-redeem-bound-second-fingerprint',
    })).rejects.toThrow('already redeemed by another request')

    const evidence = await pool.query<{ redemptions: string; reserved: number; redeemed: number }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.benefit_redemptions WHERE benefit_id = $1) AS redemptions,
        quantity_reserved AS reserved,
        quantity_redeemed AS redeemed
      FROM mbox.benefits WHERE id = $1
    `, [issued.value.id])
    expect(evidence.rows[0]).toEqual({ redemptions: '1', reserved: 0, redeemed: 1 })
  })

  it('cancels a reservation idempotently and restores available quantity', async () => {
    const issued = await benefits.issue(issueCommand('cancel', 200, 1))
    const reserved = await benefits.reserve({
      scope: { tenantId, storeId }, actor: { type: 'guest', ref: 'guest-cancel' },
      businessDate: '2026-08-11', benefitId: issued.value.id, customerId, tableSessionId,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      reservationIdempotencyKey: 'benefit-reserve-cancel-0001',
      reservationFingerprint: 'benefit-reserve-cancel-fingerprint',
    })
    const command = {
      scope: { tenantId, storeId }, actor: { type: 'guest' as const, ref: 'guest-cancel' },
      businessDate: '2026-08-11', benefitReservationId: reserved.value.id,
      customerId, tableSessionId, reason: '客人改变选择',
      cancellationIdempotencyKey: 'benefit-cancel-reservation-0001',
      cancellationFingerprint: 'benefit-cancel-reservation-fingerprint',
    }
    const cancelled = await benefits.cancelReservation(command)
    const replay = await benefits.cancelReservation(command)
    expect(cancelled.value.status).toBe('cancelled')
    expect(replay.replayed).toBe(true)
    const balance = await pool.query<{ quantity_reserved: number }>(`
      SELECT quantity_reserved FROM mbox.benefits WHERE id = $1
    `, [issued.value.id])
    expect(balance.rows[0]?.quantity_reserved).toBe(0)
  })

  it('grants only least-privilege runtime access to immutable customer and redemption facts', async () => {
    const privileges = await pool.query<{
      event_update: boolean
      redemption_update: boolean
      tag_delete: boolean
    }>(`
      SELECT
        has_table_privilege('mbox_runtime', 'mbox.customer_events', 'UPDATE') AS event_update,
        has_table_privilege('mbox_runtime', 'mbox.benefit_redemptions', 'UPDATE') AS redemption_update,
        has_table_privilege('mbox_runtime', 'mbox.customer_tags', 'DELETE') AS tag_delete
    `)
    expect(privileges.rows[0]).toEqual({
      event_update: false,
      redemption_update: false,
      tag_delete: true,
    })
  })

  function issueCommand(suffix: string, valueAmountMinor: number, quantity: number) {
    return {
      scope: { tenantId, storeId },
      actor: { type: 'employee' as const, employeeId },
      businessDate: '2026-08-11', customerId,
      benefitCode: `gift.${suffix}`,
      benefitType: 'gift_product' as const,
      valueAmountMinor,
      currency: 'CNY',
      quantity,
      benefitSnapshot: { productCode: 'BEER-001', publicDisplay: { title: '生日赠饮' } },
      validUntil: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      issuedByEmployeeId: employeeId,
      authorizationLimitId: approvalLimitId,
      reason: '客户生日现场关怀',
      authorizationSource: { kind: 'role_approval_limit', approvalLimitId },
      issuanceIdempotencyKey: `benefit-issue-${suffix}-0001`,
      issuanceFingerprint: `benefit-issue-${suffix}-fingerprint`,
    }
  }

  async function seedStore(): Promise<void> {
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Benefit Tenant')`,
      [tenantId, `benefit-${tenantId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Benefit Store')`,
      [storeId, tenantId, `store-${storeId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1, $2, $3, 'BENEFIT', 'Benefit Area', 'indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1, $2, $3, $4, 'B01', 'Benefit Table', 4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1, $2, $3, 'MANAGER_BENEFIT', 'Benefit Manager')`, [employeeId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.roles (id, tenant_id, store_id, code, name)
      VALUES ($1, $2, $3, 'BENEFIT_MANAGER', 'Benefit Manager')`, [roleId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employee_roles (tenant_id, store_id, employee_id, role_id)
      VALUES ($1, $2, $3, $4)`, [tenantId, storeId, employeeId, roleId])
    await pool.query(`INSERT INTO mbox.staff_permission_definitions (
      tenant_id, store_id, code, name, category
    ) VALUES
      ($1, $2, 'benefit.issue', 'Issue benefit', 'customer_benefit'),
      ($1, $2, 'benefit.redeem', 'Redeem benefit', 'customer_benefit'),
      ($1, $2, 'benefit.cancel', 'Cancel benefit', 'customer_benefit')
      ON CONFLICT (tenant_id, store_id, code) DO NOTHING`, [tenantId, storeId])
    await pool.query(`INSERT INTO mbox.role_permission_assignments (tenant_id, store_id, role_id, permission_id)
      SELECT $1, $2, $3, id FROM mbox.staff_permission_definitions
      WHERE tenant_id = $1 AND store_id = $2 AND code IN ('benefit.issue', 'benefit.redeem', 'benefit.cancel')`,
    [tenantId, storeId, roleId])
    await pool.query(`INSERT INTO mbox.role_approval_limits (
      id, tenant_id, store_id, role_id, approval_code, amount_minor, currency
    ) VALUES ($1, $2, $3, $4, 'benefit.issue', 1000, 'CNY')`,
    [approvalLimitId, tenantId, storeId, roleId])
  }
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
