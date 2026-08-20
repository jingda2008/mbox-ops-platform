import { describe, expect, it } from 'vitest'
import { CustomerExperienceRepository } from './customer-experience-repository.js'
import type { PostgresQueryResult, ScopedTransaction } from './transaction-runner.js'

describe('normalized experience-plan selection', () => {
  it('selects a normalized recommendation option and ignores forged snapshot amounts', async () => {
    const queries: string[] = []
    const transaction: ScopedTransaction = {
      scope: {
        tenantId: '10000000-0000-4000-8000-000000000001',
        storeId: '10000000-0000-4000-8000-000000000002',
      },
      query: async <Row extends Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<Row>> => {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        queries.push(normalized)
        if (normalized.includes('FROM mbox.recommendation_sessions')) return rows([{
          id: '20000000-0000-4000-8000-000000000001',
          public_id: 'recommendation-normalized-plan-test',
          party_size: 2,
          occasion: 'date',
          alcohol_preference: 'cocktail',
          experience_level: 'enhanced',
          service_intensity: 'balanced',
        }])
        if (normalized.includes('FROM mbox.recommendation_options option')) return rows([{
          id: '30000000-0000-4000-8000-000000000001',
          product_id: '40000000-0000-4000-8000-000000000001',
          product_name: '权威推荐套餐',
          amount_minor: '12800',
          currency: 'CNY',
          display_snapshot: { name: '被篡改名称', amountMinor: 1, currency: 'USD' },
        }])
        if (normalized.startsWith('UPDATE mbox.recommendation_sessions')) return rows([{}])
        return rows([])
      },
    }

    const result = await new CustomerExperienceRepository(transaction).createExperiencePlan({
      context: {
        customerId: '60000000-0000-4000-8000-000000000001',
        tableSessionId: '70000000-0000-4000-8000-000000000001',
        businessDate: '2026-08-16',
        actorRef: 'guest-normalized-plan',
        partySize: 2,
      },
      recommendationPublicId: 'recommendation-normalized-plan-test',
      selectedProductId: '40000000-0000-4000-8000-000000000001',
      publicId: 'experience-plan-normalized-test',
      promiseSummary: '按本次选择安排体验',
    })

    expect(result.selectedProduct).toEqual({
      productId: '40000000-0000-4000-8000-000000000001',
      name: '权威推荐套餐',
      amountMinor: 12800,
      currency: 'CNY',
    })
    expect(result.state).toBe('intent')
    expect(result.plan).toBeNull()
    expect(queries.some((sql) => sql.includes('FROM mbox.recommendation_options option'))).toBe(true)
    expect(queries.some((sql) => sql.includes('recommendation_snapshot'))).toBe(false)
    expect(queries.some((sql) => sql.includes('INSERT INTO mbox.customer_experience_plans'))).toBe(false)
    expect(queries.some((sql) => sql.includes('INSERT INTO mbox.experience_plan_cues'))).toBe(false)
  })
})

function rows<Row extends Record<string, unknown>>(values: Row[]): PostgresQueryResult<Row> {
  return { rows: values, rowCount: values.length }
}
