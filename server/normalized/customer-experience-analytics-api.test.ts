import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { customerExperienceAnalyticsApiPlugin } from './customer-experience-analytics-api.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '10000000-0000-4000-8000-000000000002',
}

describe('customer experience analytics API', () => {
  it('requires both recommendation and observation analytics permissions', async () => {
    const permissions: string[] = []
    const app = Fastify()
    await app.register(customerExperienceAnalyticsApiPlugin, {
      transactions: {
        run: async (_scope, callback) => callback({ scope } as never),
      },
      resolveStaffContext: () => ({ scope, employeeId: '10000000-0000-4000-8000-000000000003' }),
      createStaffAccessRepository: () => ({
        assertPermission: async (_employeeId, permission) => { permissions.push(permission) },
      }),
      createAnalyticsRepository: () => ({
        dashboard: async (filter) => ({
          filter, recommendation: [], products: [], weeklySuggestions: [], generatedAt: '2026-08-16T00:00:00.000Z',
          dataQuality: { totalInputs: 0, confirmedInputs: 0, unmatchedInputs: 0, correctedEvents: 0,
            unmatchedRate: 0, correctionRate: 0, missingFacts: {
              recommendationWithoutExposureCount: 0,paidRecommendationCostUnavailableCount: 0,
              complaintWithoutOrderLinkCount: 0,
            }, staff: [] },
          packageOptions: [],filterCapabilities: {
            occasion: { available:true,basis:'强场景' },package: { available:true,basis:'强订单行' },
            customerSegment: { available:false,reason:'缺历史事实',requiredFact:'版本化分群事实' },
          },
          decisionBoundary: '人工复核',
        }),
        recentObservations: async () => [],
      }),
    })
    const response = await app.inject({
      method: 'GET',
      url: '/staff/customer-experience/analytics?from=2026-08-01T00%3A00%3A00.000Z&until=2026-08-08T00%3A00%3A00.000Z',
    })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['recommendation.analytics.view','product.observation.analytics.view'])
    await app.close()
  })

  it('rejects an invalid phase before querying', async () => {
    let runs = 0
    const app = Fastify()
    await app.register(customerExperienceAnalyticsApiPlugin, {
      transactions: { run: async () => { runs += 1; throw new Error('should not run') } },
      resolveStaffContext: () => ({ scope, employeeId: '10000000-0000-4000-8000-000000000003' }),
    })
    const response = await app.inject({
      method: 'GET', url: '/staff/customer-experience/analytics?performancePhase=unknown',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('ANALYTICS_FILTER_INVALID')
    expect(runs).toBe(0)
    await app.close()
  })

  it('passes strong operational filters to the analytics repository', async () => {
    let received: unknown
    const app = Fastify()
    await app.register(customerExperienceAnalyticsApiPlugin, {
      transactions: { run: async (_scope, callback) => callback({ scope } as never) },
      resolveStaffContext: () => ({ scope, employeeId: '10000000-0000-4000-8000-000000000003' }),
      createStaffAccessRepository: () => ({ assertPermission: async () => undefined }),
      createAnalyticsRepository: () => ({
        dashboard: async (filter) => {
          received = filter
          return { filter,recommendation: [],products: [],weeklySuggestions: [],generatedAt: '2026-08-16T00:00:00.000Z',
            dataQuality: { totalInputs: 0,confirmedInputs: 0,unmatchedInputs: 0,correctedEvents: 0,
              unmatchedRate: 0,correctionRate: 0,missingFacts: {
                recommendationWithoutExposureCount: 0,paidRecommendationCostUnavailableCount: 0,
                complaintWithoutOrderLinkCount: 0,
              },staff: [] },packageOptions: [],filterCapabilities: {
              occasion: { available:true,basis:'强场景' },package: { available:true,basis:'强订单行' },
              customerSegment: { available:false,reason:'缺历史事实',requiredFact:'版本化分群事实' },
            },decisionBoundary: '人工复核' }
        },
        recentObservations: async () => [],
      }),
    })
    const response = await app.inject({ method: 'GET',url: '/staff/customer-experience/analytics?'
      +'productId=10000000-0000-4000-8000-000000000004&employeeId=10000000-0000-4000-8000-000000000005'
      +'&packageProductId=10000000-0000-4000-8000-000000000006'
      +'&partySize=6&occasion=friends&performancePhase=band_live&tableCode=A08'
      +'&recommendationOutcome=repeat_purchase' })
    expect(response.statusCode).toBe(200)
    expect(received).toMatchObject({ partySize: 6,occasion: 'friends',performancePhase: 'band_live',
      tableCode: 'A08',packageProductId: '10000000-0000-4000-8000-000000000006',
      recommendationOutcome: 'repeat_purchase' })
    await app.close()
  })

  it('rejects an unsupported recommendation outcome before querying', async () => {
    let runs = 0
    const app = Fastify()
    await app.register(customerExperienceAnalyticsApiPlugin, {
      transactions: { run: async () => { runs += 1; throw new Error('should not run') } },
      resolveStaffContext: () => ({ scope,employeeId: '10000000-0000-4000-8000-000000000003' }),
    })
    const response = await app.inject({
      method: 'GET',url: '/staff/customer-experience/analytics?recommendationOutcome=caused_repeat_purchase',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('ANALYTICS_FILTER_INVALID')
    expect(runs).toBe(0)
    await app.close()
  })

  it.each([
    ['occasion=%E6%9C%8B%E5%8F%8B%E8%81%9A%E4%BC%9A','free-text occasion'],
    ['customerSegment=gold','customer segment without event-time authority'],
  ])('rejects %s instead of pretending that the filter is effective', async (query) => {
    let runs = 0
    const app = Fastify()
    await app.register(customerExperienceAnalyticsApiPlugin, {
      transactions: { run: async () => { runs += 1; throw new Error('should not run') } },
      resolveStaffContext: () => ({ scope,employeeId: '10000000-0000-4000-8000-000000000003' }),
    })
    const response = await app.inject({ method:'GET',url:`/staff/customer-experience/analytics?${query}` })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('ANALYTICS_FILTER_INVALID')
    expect(runs).toBe(0)
    await app.close()
  })

  it('fails closed when either permission is absent', async () => {
    const app = Fastify()
    await app.register(customerExperienceAnalyticsApiPlugin, {
      transactions: {
        run: async (_scope, callback) => callback({ scope } as never),
      },
      resolveStaffContext: () => ({ scope, employeeId: '10000000-0000-4000-8000-000000000003' }),
      createStaffAccessRepository: () => ({
        assertPermission: async (_employeeId, permission) => {
          if (permission==='product.observation.analytics.view') throw new StaffAccessDeniedError(permission)
        },
      }),
    })
    const response = await app.inject({ method: 'GET', url: '/staff/customer-experience/analytics' })
    expect(response.statusCode).toBe(403)
    await app.close()
  })

  it('requires raw evidence permission before returning original observations', async () => {
    const permissions: string[] = []
    const app = Fastify()
    await app.register(customerExperienceAnalyticsApiPlugin, {
      transactions: { run: async (_scope, callback) => callback({ scope } as never) },
      resolveStaffContext: () => ({ scope, employeeId: '10000000-0000-4000-8000-000000000003' }),
      createStaffAccessRepository: () => ({
        assertPermission: async (_employeeId, permission) => { permissions.push(permission) },
      }),
      createAnalyticsRepository: () => ({ dashboard: async () => { throw new Error('unused') }, recentObservations: async () => [] }),
    })
    const response = await app.inject({
      method: 'GET',url: '/staff/customer-experience/analytics/observations?limit=20',
    })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['product.observation.analytics.view','observation.view.raw'])
    await app.close()
  })
})
