import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { MemoryRateLimitStore } from './rate-limit'
import {
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
  it('authenticates, bounds, and forwards ephemeral audio without storing it', async () => {
    let received: VoiceTranscriptionInput | null = null
    const app = await testApp({
      transcribe: async (input) => {
        received = input
        return { transcript: 'L01开台', confidence: 0.91 }
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
    expect(response.json()).toEqual({ transcript: 'L01开台', confidence: 0.91 })
    expect(received).toMatchObject({ mimeType: 'audio/webm;codecs=opus', phrases: ['L01', 'Tom'] })
    expect(received?.audio.equals(audio)).toBe(true)
    await app.close()
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
