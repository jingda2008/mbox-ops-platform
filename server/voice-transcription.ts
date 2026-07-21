import type { FastifyInstance } from 'fastify'
import { GoogleAuth } from 'google-auth-library'
import { z } from 'zod'
import { requireRequestActor } from './auth-context.js'
import type { RateLimitStore } from './rate-limit.js'

const MAX_AUDIO_BYTES = 600_000
const MAX_BIAS_PHRASES = 5_000
const MAX_BIAS_JSON_BYTES = 100_000
const voiceTranscriptionSchema = z.object({
  audioBase64: z.string().trim().min(8).max(820_000),
  mimeType: z.enum(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus']),
  phrases: z.array(z.string().trim().min(1).max(80)).max(MAX_BIAS_PHRASES).default([]),
})

function boundedBiasPhrases(phrases: readonly string[]) {
  const result: string[] = []
  const seen = new Set<string>()
  let jsonBytes = 2
  for (const phrase of phrases) {
    const key = phrase.toLocaleLowerCase('zh-CN')
    if (seen.has(key)) continue
    const encodedBytes = Buffer.byteLength(JSON.stringify(phrase), 'utf8') + (result.length > 0 ? 1 : 0)
    if (jsonBytes + encodedBytes > MAX_BIAS_JSON_BYTES) break
    seen.add(key)
    result.push(phrase)
    jsonBytes += encodedBytes
  }
  return result
}

export interface VoiceTranscriptionInput {
  audio: Buffer
  mimeType: string
  phrases: readonly string[]
}

export interface VoiceTranscriptionResult {
  transcript: string
  confidence: number | null
  alternatives: VoiceTranscriptionAlternative[]
}

export interface VoiceTranscriptionAlternative {
  transcript: string
  confidence: number | null
}

export interface VoiceTranscriber {
  transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult>
}

interface GoogleSpeechResponse {
  results?: Array<{
    alternatives?: Array<{ transcript?: string; confidence?: number }>
  }>
}

function appendTranscript(prefix: string, segment: string) {
  if (!prefix) return segment
  if (!segment) return prefix
  return /[a-z0-9]$/i.test(prefix) && /^[a-z0-9]/i.test(segment)
    ? `${prefix} ${segment}`
    : `${prefix}${segment}`
}

export function combineGoogleSpeechAlternatives(
  results: NonNullable<GoogleSpeechResponse['results']>,
  maximum = 8,
): VoiceTranscriptionAlternative[] {
  let beams: Array<{ transcript: string; confidenceTotal: number; confidenceCount: number }> = [{
    transcript: '',
    confidenceTotal: 0,
    confidenceCount: 0,
  }]
  for (const result of results) {
    const alternatives = (result.alternatives ?? [])
      .flatMap((alternative) => {
        const transcript = alternative.transcript?.trim() ?? ''
        if (!transcript) return []
        return [{ transcript, confidence: typeof alternative.confidence === 'number' ? alternative.confidence : 0.5 }]
      })
      .slice(0, maximum)
    if (alternatives.length === 0) continue
    beams = beams
      .flatMap((beam) => alternatives.map((alternative) => ({
        transcript: appendTranscript(beam.transcript, alternative.transcript),
        confidenceTotal: beam.confidenceTotal + alternative.confidence,
        confidenceCount: beam.confidenceCount + 1,
      })))
      .toSorted((left, right) => (
        right.confidenceTotal / Math.max(1, right.confidenceCount)
        - left.confidenceTotal / Math.max(1, left.confidenceCount)
      ))
      .slice(0, maximum)
  }
  const seen = new Set<string>()
  return beams.flatMap((beam) => {
    const transcript = beam.transcript.trim()
    const key = transcript.toLocaleLowerCase('zh-CN').replace(/\s+/g, '')
    if (!key || seen.has(key)) return []
    seen.add(key)
    return [{
      transcript,
      confidence: beam.confidenceCount > 0 ? beam.confidenceTotal / beam.confidenceCount : null,
    }]
  })
}

export class GoogleCloudVoiceTranscriber implements VoiceTranscriber {
  private readonly auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

  async transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult> {
    const client = await this.auth.getClient()
    const encoding = input.mimeType.startsWith('audio/ogg') ? 'OGG_OPUS' : 'WEBM_OPUS'
    const response = await client.request<GoogleSpeechResponse>({
      url: 'https://speech.googleapis.com/v1/speech:recognize',
      method: 'POST',
      data: {
        config: {
          encoding,
          sampleRateHertz: 48_000,
          languageCode: 'cmn-Hans-CN',
          alternativeLanguageCodes: ['en-US'],
          model: 'command_and_search',
          useEnhanced: true,
          maxAlternatives: 8,
          enableAutomaticPunctuation: false,
          speechContexts: input.phrases.length > 0 ? [{ phrases: input.phrases, boost: 15 }] : undefined,
        },
        audio: { content: input.audio.toString('base64') },
      },
      timeout: 15_000,
    })
    const alternatives = combineGoogleSpeechAlternatives(response.data.results ?? [])
    const best = alternatives[0]
    return {
      transcript: best?.transcript ?? '',
      confidence: best?.confidence ?? null,
      alternatives,
    }
  }
}

export interface VoiceTranscriptionRoutesOptions {
  transcriber?: VoiceTranscriber
  rateLimitStore: RateLimitStore
}

export async function registerVoiceTranscriptionRoutes(
  app: FastifyInstance,
  options: VoiceTranscriptionRoutesOptions,
) {
  app.post('/api/voice/transcribe', async (request, reply) => {
    const actor = requireRequestActor(request)
    if (!options.transcriber) {
      return reply.code(503).send({ code: 'VOICE_TRANSCRIPTION_DISABLED', message: '当前环境尚未启用云端语音识别' })
    }
    const decision = await options.rateLimitStore.consume({
      scope: 'staff_voice_transcription',
      key: `${actor.storeId}:${actor.actorId}`,
      limit: 20,
      windowMs: 60_000,
    })
    if (!decision.allowed) {
      return reply.code(429).send({
        code: 'VOICE_TRANSCRIPTION_RATE_LIMITED',
        message: '语音操作有点密集，请稍后再试',
        retryAfterMs: Math.max(0, decision.resetAt - Date.now()),
      })
    }

    const body = voiceTranscriptionSchema.parse(request.body)
    const audio = Buffer.from(body.audioBase64, 'base64')
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
      return reply.code(413).send({ code: 'VOICE_AUDIO_TOO_LARGE', message: '单次录音最长20秒，请缩短后重试' })
    }

    try {
      const result = await options.transcriber.transcribe({
        audio,
        mimeType: body.mimeType,
        phrases: boundedBiasPhrases(body.phrases),
      })
      if (!result.transcript) {
        return reply.code(422).send({ code: 'VOICE_NOT_RECOGNIZED', message: '这次没有听清，请靠近麦克风再说一次' })
      }
      return result
    } catch {
      request.log.warn({ actorId: actor.actorId }, 'cloud voice transcription failed')
      return reply.code(502).send({ code: 'VOICE_TRANSCRIPTION_FAILED', message: '语音识别暂时繁忙，可以重试或直接输入命令' })
    }
  })
}
