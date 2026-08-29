import { describe,expect,it } from 'vitest'
import {
  CustomerExperienceRepository,
  recommendationInputConfiguration,
  recommendationPaidOrderHistoryContribution,
  type RecommendationAnswer,
} from './customer-experience-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '10000000-0000-4000-8000-000000000002',
}
const customerId = '10000000-0000-4000-8000-000000000003'
const tableSessionId = '10000000-0000-4000-8000-000000000004'

describe('recommendation input and paid-history contract', () => {
  it('uses exactly three server-owned customer questions and keeps service intensity operational', () => {
    const configuration = recommendationInputConfiguration({})
    expect(configuration.version).toBe(1)
    expect(configuration.questions.map((question) => question.code))
      .toEqual(['occasion', 'alcoholPreference', 'experienceLevel'])
    expect(configuration.strategy.shakeExcludes).toEqual(['exposed', 'cart', 'ordered', 'rejected'])
  })

  it('allows a policy version to control question copy/order and bounded history strategy only', () => {
    const configuration = recommendationInputConfiguration({
      recommendationInput: {
        version: 1,
        questions: [
          { code: 'experienceLevel', title: '今晚想要什么节奏？' },
          { code: 'occasion', title: '今晚想怎么坐坐？' },
          { code: 'alcoholPreference', title: '更想喝点什么？' },
        ],
        strategy: {
          paidOrderHistoryWeight: 240,
          multiGuestHistoryConfidenceBasisPoints: 1_500,
        },
      },
    })
    expect(configuration.questions.map((question) => question.code))
      .toEqual(['experienceLevel', 'occasion', 'alcoholPreference'])
    expect(configuration.strategy).toMatchObject({
      paidOrderHistoryWeight: 240,
      multiGuestHistoryConfidenceBasisPoints: 1_500,
    })
    expect(() => recommendationInputConfiguration({
      recommendationInput: { version: 1, questions: [], strategy: {} },
    })).toThrow(/三项顾客问题/)
  })

  it('gives multiple-person table history only the policy-configured low confidence', () => {
    const configuration = recommendationInputConfiguration({})
    expect(recommendationPaidOrderHistoryContribution(0, 10_000, configuration)).toBe(25)
    expect(recommendationPaidOrderHistoryContribution(10_000, 0, configuration)).toBe(100)
    expect(recommendationPaidOrderHistoryContribution(10_000, 10_000, configuration)).toBe(100)
  })

  it('persists the normalized three-question configuration with every new policy version', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = []
    const transaction = {
      scope,
      query: async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values })
        if (sql.includes('INSERT INTO mbox.recommendation_policy_versions')) {
          return { rows: [{ public_id: 'recommendation-input-policy-v1', policy_code: 'DEFAULT', version: 2, status: 'draft' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as ScopedTransaction
    await new CustomerExperienceRepository(transaction).createRecommendationPolicy({
      publicId: 'recommendation-input-policy-v1', code: 'DEFAULT', employeeId: customerId,
      preferenceWeight: 100, sceneWeight: 60, marginWeight: 50, priorityWeight: 50,
      performanceWeight: 0, inventoryWeight: 0, capacityWeight: 0, minimumGrossMarginBasisPoints: 0,
      preferenceHalfLifeDays: 90, preferenceMaxAgeDays: 730, preferenceMinEffectiveScore: 1000,
      preferenceMinConfidenceBasisPoints: 2500, explanationTemplate: '测试版本化顾客输入',
      displayConfiguration: {}, draftReason: '验证默认三题进入策略版本',
    })
    const insert = queries.find((query) => query.sql.includes('INSERT INTO mbox.recommendation_policy_versions'))!
    const storedConfiguration = insert.values.find((value) => typeof value === 'string' && value.includes('recommendationInput'))
    expect(JSON.parse(storedConfiguration as string)).toMatchObject({
      recommendationInput: { version: 1, questions: [
        { code: 'occasion' }, { code: 'alcoholPreference' }, { code: 'experienceLevel' },
      ] },
    })
  })

  it('keeps paid-history and shake exclusion authority in server-side SQL', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = []
    const transaction = {
      scope,
      query: async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values })
        return { rows: [], rowCount: 0 }
      },
    } as unknown as ScopedTransaction
    const repository = new CustomerExperienceRepository(transaction) as unknown as {
      shakeExcludedProductIds(input: { customerId: string; tableSessionId: string }): Promise<string[]>
      recommendationProducts(
        answers: RecommendationAnswer,
        customerId: string,
        excludedProductIds: readonly string[],
      ): Promise<unknown[]>
    }
    await repository.shakeExcludedProductIds({ customerId, tableSessionId })
    await repository.recommendationProducts({
      partySize: 2,
      occasion: 'friends',
      alcoholPreference: 'mixed',
      experienceLevel: 'enhanced',
      serviceIntensity: 'balanced',
    }, customerId, ['10000000-0000-4000-8000-000000000005'])

    const shake = queries[0]!
    expect(shake.sql).toContain("event_type='rejected'")
    expect(shake.sql).toContain("cart.status IN ('open','submitting')")
    expect(shake.sql).toContain("ordering.status<>'cancelled'")
    const history = queries[1]!
    expect(history.sql).toContain("ordering.payment_status='paid'")
    expect(history.sql).toContain("payment.status='succeeded'")
    expect(history.sql).toContain("refund.status IN ('requested','approved','processing','succeeded')")
    expect(history.sql).toContain('ordering.created_by_customer_id IN (SELECT id FROM family)')
    expect(history.sql).toContain('product.id=ANY($6::uuid[])')
    expect(history.values.at(-1)).toEqual(['10000000-0000-4000-8000-000000000005'])
  })
})
