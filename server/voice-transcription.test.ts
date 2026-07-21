import Fastify from 'fastify'
import { GoogleAuth } from 'google-auth-library'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRateLimitStore } from './rate-limit'
import {
  combineGoogleSpeechAlternatives,
  GoogleCloudVoiceTranscriber,
  registerVoiceTranscriptionRoutes,
  type VoiceTranscriber,
  type VoiceTranscriptionInput,
} from './voice-transcription'

const tenantId = '00000000-0000-4000-8000-000000000001'
const storeId = '00000000-0000-4000-8000-000000000002'

async function testApp(transcriber?: VoiceTranscriber) {
  const app = Fastify()
  app.addHook('onRequest', async (request) => {
    request.mboxActor = {
      actorId: 'emp-tom',
      storeId,
      roleId: 'server',
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
      sessionId: null,
      sessionExpiresAt: null,
    }
  })
  await registerVoiceTranscriptionRoutes(app, {
    transcriber,
    rateLimitStore: new MemoryRateLimitStore({
      usage: 'test',
      tenantId,
      storeId,
      hashSecret: 'voice-transcription-test-secret-32-characters',
    }),
  })
  return app
}

describe('voice transcription routes', () => {
  it('uses the short-command model, store hints, and multiple hypotheses', async () => {
    const request = vi.fn(async () => ({
      data: {
        results: [{ alternatives: [
          { transcript: 'LO1开台', confidence: 0.82 },
          { transcript: 'L01开台', confidence: 0.79 },
        ] }],
      },
    }))
    const auth = vi.spyOn(GoogleAuth.prototype, 'getClient').mockResolvedValue({ request } as never)
    try {
      const result = await new GoogleCloudVoiceTranscriber().transcribe({
        audio: Buffer.from('test-audio'),
        mimeType: 'audio/webm;codecs=opus',
        phrases: ['L01', '李艳', '精酿啤酒'],
      })

      expect(request).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          config: expect.objectContaining({
            languageCode: 'cmn-Hans-CN',
            model: 'command_and_search',
            useEnhanced: true,
            maxAlternatives: 8,
            speechContexts: [{ phrases: ['L01', '李艳', '精酿啤酒'], boost: 15 }],
          }),
        }),
      }))
      expect(result.alternatives).toHaveLength(2)
    } finally {
      auth.mockRestore()
    }
  })

  it('authenticates, bounds, and forwards ephemeral audio without storing it', async () => {
    let received: VoiceTranscriptionInput | null = null
    const app = await testApp({
      transcribe: async (input) => {
        received = input
        return {
          transcript: 'L01开台',
          confidence: 0.91,
          alternatives: [
            { transcript: 'L01开台', confidence: 0.91 },
            { transcript: 'LO1开台', confidence: 0.86 },
          ],
        }
      },
    })
    const audio = Buffer.from('test-audio')
    const response = await app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      payload: {
        audioBase64: audio.toString('base64'),
        mimeType: 'audio/webm;codecs=opus',
        phrases: ['L01', 'Tom', 'L01'],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      transcript: 'L01开台',
      confidence: 0.91,
      alternatives: [
        { transcript: 'L01开台', confidence: 0.91 },
        { transcript: 'LO1开台', confidence: 0.86 },
      ],
    })
    expect(received).toMatchObject({ mimeType: 'audio/webm;codecs=opus', phrases: ['L01', 'Tom'] })
    expect(received?.audio.equals(audio)).toBe(true)
    await app.close()
  })

  it('bounds the encoded hotword payload so maximum audio stays below the server body limit', async () => {
    let received: VoiceTranscriptionInput | null = null
    const app = await testApp({
      transcribe: async (input) => {
        received = input
        return { transcript: 'L01开台', confidence: 0.91, alternatives: [] }
      },
    })
    const phrases = Array.from({ length: 2_000 }, (_, index) => `${index}${'酒'.repeat(70)}`)
    const response = await app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      payload: {
        audioBase64: Buffer.from('test-audio').toString('base64'),
        mimeType: 'audio/webm;codecs=opus',
        phrases,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(received).not.toBeNull()
    expect(Buffer.byteLength(JSON.stringify(received!.phrases), 'utf8')).toBeLessThanOrEqual(100_000)
    expect(received!.phrases.length).toBeLessThan(phrases.length)
    await app.close()
  })

  it('combines multi-segment hypotheses and keeps several candidates for store dictionary reranking', () => {
    expect(combineGoogleSpeechAlternatives([
      { alternatives: [
        { transcript: '五分钟后让Tom', confidence: 0.88 },
        { transcript: '五分钟后让汤姆', confidence: 0.84 },
      ] },
      { alternatives: [
        { transcript: '给K2加水', confidence: 0.91 },
        { transcript: '给K区加水', confidence: 0.82 },
      ] },
    ], 3)).toEqual([
      { transcript: '五分钟后让Tom给K2加水', confidence: 0.895 },
      { transcript: '五分钟后让汤姆给K2加水', confidence: 0.875 },
      { transcript: '五分钟后让Tom给K区加水', confidence: 0.85 },
    ])
  })

  it('returns an explicit service state when cloud transcription is disabled', async () => {
    const app = await testApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      payload: {
        audioBase64: Buffer.from('test-audio').toString('base64'),
        mimeType: 'audio/webm',
        phrases: [],
      },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ code: 'VOICE_TRANSCRIPTION_DISABLED' })
    await app.close()
  })
})
