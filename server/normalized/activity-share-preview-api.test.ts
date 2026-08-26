import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activitySharePreviewApiPlugin } from './activity-share-preview-api.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'

const apps: FastifyInstance[] = []
const scope = {
  tenantId: '82000000-0000-4000-8000-000000000001',
  storeId: '82000000-0000-4000-8000-000000000002',
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('anonymous activity share preview API', () => {
  it('serves only a narrow preview without a guest session or Set-Cookie', async () => {
    const activitySharePreview = vi.fn(async () => ({
      publicId: 'community-activity-share-0001', kind: 'music_night', title: '超嗨音乐夜', summary: '一起听歌',
      coverUrl: 'https://m-box.oss-cn-shanghai.aliyuncs.com/activities/share.jpg',
      startsAt: '2026-09-01T12:00:00.000Z', endsAt: '2026-09-01T15:00:00.000Z', assemblyLocation: 'M-BOX',
      feeAmountMinor: 0, depositAmountMinor: 0, feeBasis: 'per_registration', paymentMode: 'none',
      paymentRuleText: '免费报名', currency: 'CNY', availability: 'available', availabilityText: '开放报名',
      marketingCopy: { details: '活动详情', includedItems: ['欢迎饮品'], participationRequirements: [], memberBenefitText: null },
      safetyRequirements: ['请合理饮酒'], packageSelectionRequired: false, packages: [],
      registrationRequiresMembership: true,
    }))
    const resolveShareScope = vi.fn(() => scope)
    const app = fixture(activitySharePreview, resolveShareScope)
    const response = await app.inject({
      method: 'GET',
      url: '/public/mini/activity-previews/community-activity-share-0001',
    })
    const memberCookieResponse = await app.inject({
      method: 'GET',
      url: '/public/mini/activity-previews/community-activity-share-0001',
      headers: { cookie: 'mbox_reservation_session=member-session-will-not-be-read' },
    })

    expect(response.statusCode).toBe(200)
    expect(memberCookieResponse.statusCode).toBe(200)
    expect(memberCookieResponse.body).toBe(response.body)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.json()).toMatchObject({ data: {
      publicId: 'community-activity-share-0001', registrationRequiresMembership: true,
    }, meta: { registrationRequiresMembership: true } })
    expect(activitySharePreview).toHaveBeenCalledWith(scope, 'community-activity-share-0001')
    expect(resolveShareScope).toHaveBeenCalledTimes(2)
    const serialized = response.body
    for (const forbidden of [
      'customerId', 'registrationStatus', 'remainingCapacity', 'memberPurchaseLimit',
      'contactInstructions', 'paymentAvailability', 'providerAction',
    ]) expect(serialized).not.toContain(forbidden)
  })

  it('makes missing, non-public, and malformed identifiers equally non-enumerable', async () => {
    const activitySharePreview = vi.fn(async () => {
      throw new CustomerExperienceRequestError('活动不存在或当前不可分享', 'ACTIVITY_NOT_FOUND', 404)
    })
    const app = fixture(activitySharePreview)
    const absent = await app.inject({ method: 'GET', url: '/public/mini/activity-previews/activity-missing-0001' })
    const malformed = await app.inject({ method: 'GET', url: '/public/mini/activity-previews/bad%20id' })

    expect(absent.statusCode).toBe(404)
    expect(malformed.statusCode).toBe(404)
    expect(absent.json()).toEqual(malformed.json())
    expect(activitySharePreview).toHaveBeenCalledTimes(1)
  })

  it('does not reveal an unexpected internal failure', async () => {
    const activitySharePreview = vi.fn(async () => {
      throw new Error('postgres detail with 13800138000 and internal table names')
    })
    const app = fixture(activitySharePreview)
    const response = await app.inject({
      method: 'GET', url: '/public/mini/activity-previews/community-unexpected-0001',
    })

    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain('postgres detail')
    expect(response.body).not.toContain('internal table')
    expect(response.body).not.toContain('13800138000')
  })
})

function fixture(
  activitySharePreview: ReturnType<typeof vi.fn>,
  resolveShareScope: ReturnType<typeof vi.fn> = vi.fn(() => scope),
): FastifyInstance {
  const app = Fastify()
  apps.push(app)
  void app.register(activitySharePreviewApiPlugin, {
    service: { activitySharePreview },
    resolveShareScope,
  })
  return app
}
