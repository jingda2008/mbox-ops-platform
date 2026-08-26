import { describe, expect, it } from 'vitest'
import { CustomerExperienceRepository } from './customer-experience-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '84000000-0000-4000-8000-000000000001',
  storeId: '84000000-0000-4000-8000-000000000002',
}

describe('customer-experience transaction query sequencing', () => {
  it('does not overlap policy configuration reads on one scoped transaction', async () => {
    const probe = exclusiveQueryProbe((sql) => sql.includes('customer_experience_features')
      ? [{ rollout_state: 'disabled', reason: '尚未启用', effective_from: null, updated_at: '2026-08-26T12:00:00.000Z' }]
      : [])

    await expect(new CustomerExperienceRepository(probe.transaction).recommendationPolicyConfiguration())
      .resolves.toMatchObject({ feature: { rolloutState: 'disabled' }, policies: [] })
    expect(probe.maximumConcurrentQueries()).toBe(1)
  })

  it('does not overlap dashboard reads on one scoped transaction', async () => {
    const probe = exclusiveQueryProbe(() => [])

    await expect(new CustomerExperienceRepository(probe.transaction).staffDashboard())
      .resolves.toMatchObject({ activePlanCount: 0, cueQueue: [], followups: [], activities: [] })
    expect(probe.maximumConcurrentQueries()).toBe(1)
  })
})

function exclusiveQueryProbe(rowsFor: (sql: string) => Array<Record<string, unknown>>) {
  let activeQueries = 0
  let maximum = 0
  const transaction = {
    scope,
    query: async (sql: string) => {
      activeQueries += 1
      maximum = Math.max(maximum, activeQueries)
      // A queued pg client leaves this async gap open. Promise.all would therefore make
      // maximum exceed one before any result becomes available.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      activeQueries -= 1
      const rows = rowsFor(sql)
      return { rows, rowCount: rows.length }
    },
  } as unknown as ScopedTransaction
  return { transaction, maximumConcurrentQueries: () => maximum }
}
