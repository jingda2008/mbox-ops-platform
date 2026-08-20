import { describe, expect, it, vi } from 'vitest'
import { OfficialWechatMiniProgramCodeProvider } from './wechat-mini-program-code.js'

describe('official WeChat mini-program code provider', () => {
  it('renders an official binary code with a bounded opaque scene and caches access token', async () => {
    const image = Buffer.alloc(256, 7)
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access-token', expires_in: 7200 }))
      .mockResolvedValueOnce(imageResponse(image))
      .mockResolvedValueOnce(imageResponse(image))
    const provider = new OfficialWechatMiniProgramCodeProvider({
      appId: 'wxMboxOfficial01', appSecret: 'secret-not-production', fetch: request,
      now: () => new Date('2026-08-16T10:00:00.000Z'),
    })
    const input = { scene: 'A'.repeat(32), page: 'pages/order/index', environment: 'trial' as const }
    await expect(provider.render(input)).resolves.toEqual(image)
    await expect(provider.render(input)).resolves.toEqual(image)
    expect(request).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      scene: 'A'.repeat(32), page: 'pages/order/index', width: 430,
      check_path: true, env_version: 'trial', is_hyaline: false,
    })
  })

  it('rejects URL-sized credentials and fails closed on platform contract errors', async () => {
    const provider = new OfficialWechatMiniProgramCodeProvider({
      appId: 'wxMboxOfficial01', appSecret: 'secret-not-production',
      fetch: vi.fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: 'access-token', expires_in: 7200 }))
        .mockResolvedValueOnce(jsonResponse({ errcode: 41030, errmsg: 'invalid page' })),
    })
    await expect(provider.render({
      scene: 'B'.repeat(43), page: 'pages/order/index', environment: 'release',
    })).rejects.toMatchObject({ code: 'WECHAT_MINI_CODE_SCENE_INVALID' })
    await expect(provider.render({
      scene: 'B'.repeat(32), page: 'pages/order/index', environment: 'release',
    })).rejects.toMatchObject({ code: 'WECHAT_MINI_CODE_CONTRACT_INVALID' })
  })
})

function jsonResponse(body: unknown) {
  return {
    ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => body, arrayBuffer: async () => new ArrayBuffer(0),
  }
}

function imageResponse(body: Buffer) {
  return {
    ok: true, status: 200, headers: { get: () => 'image/png' },
    json: async () => { throw new Error('not json') },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset+body.byteLength),
  }
}
