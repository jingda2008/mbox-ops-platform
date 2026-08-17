import { describe, expect, it } from 'vitest'
import { CustomerExperienceRepository } from './customer-experience-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '84000000-0000-4000-8000-000000000001',
  storeId: '84000000-0000-4000-8000-000000000002',
}

describe('checkout upgrade transaction-local safety', () => {
  it('evaluates an enabled feature without blocking checkout when no current rule matches', async () => {
    const statements: string[] = []
    const transaction = fakeTransaction(async <Row extends Record<string, unknown>>(sql: string) => {
      statements.push(sql)
      if (sql.includes('UPDATE mbox.checkout_upgrade_offers')) return result<Row>([])
      if (sql.includes('FROM mbox.customer_experience_features')) {
        return result<Row>([{ feature_code: 'checkout_upgrade', rollout_state: 'enabled', configuration: {} }])
      }
      if (sql.includes('FROM mbox.checkout_upgrade_rules AS rule')) return result<Row>([])
      throw new Error(`unexpected checkout query: ${sql}`)
    })

    await expect(new CustomerExperienceRepository(transaction).prepareCheckoutUpgrade({
      customerId: '84000000-0000-4000-8000-000000000003',
      tableSessionId: '84000000-0000-4000-8000-000000000004',
      businessDate: '2026-08-15',
      actorRef: 'guest-checkout-upgrade-test',
      partySize: 2,
    }, {
      items: [{ productId: '84000000-0000-4000-8000-000000000005', quantity: 1 }],
      idempotencyKey: 'checkout-upgrade-atomicity-test',
    })).resolves.toBeNull()

    expect(statements.some((sql) => sql.includes('INSERT INTO mbox.checkout_upgrade_offers'))).toBe(false)
  })

  it('rejects a supplied stale or foreign offer before changing it', async () => {
    const statements: string[] = []
    const transaction = fakeTransaction(async <Row extends Record<string, unknown>>(sql: string) => {
      statements.push(sql)
      return result<Row>([])
    })
    await expect(new CustomerExperienceRepository(transaction).selectCheckoutUpgrade({
      customerId: '84000000-0000-4000-8000-000000000003',
      tableSessionId: '84000000-0000-4000-8000-000000000004',
      businessDate: '2026-08-15',
    }, 'checkout-upgrade-old-offer-0001', [{
      productId: '84000000-0000-4000-8000-000000000005', quantity: 1,
    }])).rejects.toMatchObject({ code: 'CHECKOUT_UPGRADE_UNAVAILABLE', statusCode: 409 })
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('FOR UPDATE OF offer')
  })

  it('fails closed when the price or rule changed after the offer was shown', async () => {
    const statements: string[] = []
    const transaction = fakeTransaction(async <Row extends Record<string, unknown>>(sql: string) => {
      statements.push(sql)
      if (sql.includes('FROM mbox.checkout_upgrade_offers AS offer')) {
        return result<Row>([{
          id: '84000000-0000-4000-8000-000000000006',
          upgraded_basket: [{ productId: '84000000-0000-4000-8000-000000000007', quantity: 1 }],
          basket_fingerprint: '0'.repeat(64),
          rule_id: '84000000-0000-4000-8000-000000000008',
          rule_updated_at: '2026-08-16T00:00:00.000Z',
          source_product_id: '84000000-0000-4000-8000-000000000005',
          target_product_id: '84000000-0000-4000-8000-000000000007',
          source_price_id: '84000000-0000-4000-8000-000000000009',
          target_price_id: '84000000-0000-4000-8000-000000000010',
          source_amount_minor: '6800',
          target_amount_minor: '9800',
          currency: 'CNY',
        }])
      }
      if (sql.includes('FROM mbox.product_prices')) {
        return result<Row>([
          { id: '84000000-0000-4000-8000-000000000009', amount_minor: '6800', currency: 'CNY' },
          { id: '84000000-0000-4000-8000-000000000010', amount_minor: '9800', currency: 'CNY' },
        ])
      }
      throw new Error(`offer must not be changed after a fingerprint mismatch: ${sql}`)
    })

    await expect(new CustomerExperienceRepository(transaction).selectCheckoutUpgrade({
      customerId: '84000000-0000-4000-8000-000000000003',
      tableSessionId: '84000000-0000-4000-8000-000000000004',
      businessDate: '2026-08-15',
    }, 'checkout-upgrade-price-changed-0001', [{
      productId: '84000000-0000-4000-8000-000000000005', quantity: 1,
    }])).rejects.toMatchObject({ code: 'CHECKOUT_UPGRADE_PRICE_CHANGED', statusCode: 409 })
    expect(statements).toHaveLength(2)
    expect(statements[1]).toContain('FOR SHARE')
  })
})

function fakeTransaction(query: ScopedTransaction['query']): ScopedTransaction {
  return { scope, query }
}

function result<Row extends Record<string, unknown>>(rows: Row[]) {
  return { rows, rowCount: rows.length }
}
