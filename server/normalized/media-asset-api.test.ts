import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { mediaAssetApiPlugin } from './media-asset-api.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '10000000-0000-4000-8000-000000000002',
}
const context = {
  scope,
  employeeId: '10000000-0000-4000-8000-000000000003',
  businessDate: '2026-08-22',
}
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')

describe('media asset API', () => {
  it('lets an activity manager read the image library required by the editor', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => {
        permissions.push(permission)
        if (permission === 'community.activity.view') throw new StaffAccessDeniedError('denied')
      },
    })
    const response = await app.inject({ method: 'GET', url: '/staff/media-assets' })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['community.activity.view', 'community.activity.manage'])
    await app.close()
  })

  it('requires activity management permission and accepts only a bounded matching image payload', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({
      method: 'POST', url: '/staff/media-assets', headers: { 'idempotency-key': 'media-upload-activity-cover-001' },
      payload: { purpose: 'community_activity', fileName: 'superhigh-cover.png', mimeType: 'image/png', base64: pngHeader },
    })
    expect(response.statusCode).toBe(201)
    expect(permissions).toEqual(['community.activity.manage'])
    expect(service.upload).toHaveBeenCalledWith(context, expect.objectContaining({
      purpose: 'community_activity', originalFileName: 'superhigh-cover.png', mimeType: 'image/png',
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), idempotencyKey: 'media-upload-activity-cover-001',
    }))
    await app.close()
  })

  it('lets the support-contact manager use only the QR image path needed by that page', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => {
        permissions.push(permission)
        if (permission !== 'customer.experience.feature.manage') throw new StaffAccessDeniedError(permission)
      },
    })

    const list = await app.inject({ method: 'GET', url: '/staff/media-assets' })
    const supportUpload = await app.inject({
      method: 'POST', url: '/staff/media-assets', headers: { 'idempotency-key': 'media-upload-support-qr-001' },
      payload: { purpose: 'support_contact', fileName: 'wecom.png', mimeType: 'image/png', base64: pngHeader },
    })
    const activityUpload = await app.inject({
      method: 'POST', url: '/staff/media-assets', headers: { 'idempotency-key': 'media-upload-activity-denied-001' },
      payload: { purpose: 'community_activity', fileName: 'activity.png', mimeType: 'image/png', base64: pngHeader },
    })

    expect(list.statusCode).toBe(200)
    expect(supportUpload.statusCode).toBe(201)
    expect(activityUpload.statusCode).toBe(403)
    expect(service.upload).toHaveBeenCalledTimes(1)
    expect(service.upload).toHaveBeenCalledWith(context, expect.objectContaining({ purpose: 'support_contact' }))
    expect(permissions).toContain('customer.experience.feature.manage')
    await app.close()
  })

  it('rejects mismatched bytes before any upload command and hides the library without view authority', async () => {
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async () => { throw new StaffAccessDeniedError('denied') },
    })
    const invalid = await app.inject({
      method: 'POST', url: '/staff/media-assets', headers: { 'idempotency-key': 'media-upload-invalid-001' },
      payload: { purpose: 'community_activity', fileName: 'not-a-png.png', mimeType: 'image/png', base64: Buffer.from('not png').toString('base64') },
    })
    expect(invalid.statusCode).toBe(403)
    expect(service.upload).not.toHaveBeenCalled()
    const list = await app.inject({ method: 'GET', url: '/staff/media-assets' })
    expect(list.statusCode).toBe(403)
    await app.close()
  })

  it('fails malformed image payloads closed before the service is called', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'POST', url: '/staff/media-assets', headers: { 'idempotency-key': 'media-upload-invalid-002' },
      payload: { purpose: 'community_activity', fileName: 'cover.png', mimeType: 'image/png', base64: '%%%%' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('MEDIA_ASSET_INPUT_INVALID')
    expect(service.upload).not.toHaveBeenCalled()
    await app.close()
  })

  it('accepts exactly 200KB but rejects an image one byte above the shared limit', async () => {
    const service = serviceMock()
    const app = await application(service)
    const withinLimit = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(200 * 1024 - 8)]).toString('base64')
    const accepted = await app.inject({
      method: 'POST', url: '/staff/media-assets', headers: { 'idempotency-key': 'media-upload-200kb-accepted-001' },
      payload: { purpose: 'home_content', fileName: 'within-limit.png', mimeType: 'image/png', base64: withinLimit },
    })
    expect(accepted.statusCode).toBe(201)

    const aboveLimit = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(200 * 1024 + 1 - 8)]).toString('base64')
    const rejected = await app.inject({
      method: 'POST', url: '/staff/media-assets', headers: { 'idempotency-key': 'media-upload-200kb-rejected-001' },
      payload: { purpose: 'home_content', fileName: 'above-limit.png', mimeType: 'image/png', base64: aboveLimit },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error.message).toBe('图片压缩后不能超过 200KB')
    expect(service.upload).toHaveBeenCalledTimes(1)
    await app.close()
  })
})

function serviceMock() {
  return {
    list: vi.fn(async () => [asset()]),
    upload: vi.fn(async () => ({ value: asset(), replayed: false })),
  }
}

function asset() {
  return {
    publicId: 'MA00000000000000000000000000000001', purpose: 'community_activity',
    originalFileName: 'superhigh-cover.png', mimeType: 'image/png', byteLength: 8,
    sha256: 'a'.repeat(64), publicUrl: '/api/public/media-assets/MA00000000000000000000000000000001',
    staffUrl: '/api/staff/media-assets/MA00000000000000000000000000000001', createdAt: '2026-08-22T00:00:00.000Z',
  }
}

async function application(service = serviceMock(), access = { assertPermission: async () => undefined }) {
  const app = Fastify()
  await app.register(mediaAssetApiPlugin, {
    transactions: { run: async (_scope, callback) => callback({ scope } as never) },
    service: service as never, resolveStaffContext: () => context, resolveScope: () => scope,
    createStaffAccessRepository: () => access,
  })
  return app
}
