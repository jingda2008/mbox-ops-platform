import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { PerformanceSession, SingerRepertoireEntry, SongCatalogItem, SongRequest } from '../src/shared/song-contracts.js'
import { requireConfiguredOperation } from './authorization.js'
import type { RuntimeRepository } from './repository.js'
import {
  acceptSongRequest,
  cancelSongRequest,
  completeSongRequest,
  confirmSongRequest,
  markSongRequestPaid,
  markSongRequestRefunded,
  rejectSongRequest,
  startSongPerformance,
  submitSongRequest,
  validateSongConfiguration,
} from './song-domain.js'

const idempotencyKey = z.string().trim().min(8).max(128)
function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

const submitSchema = z.object({
  performanceSessionId: z.string().trim().min(1),
  appearanceId: z.string().trim().min(1),
  tableSessionId: z.string().trim().min(1),
  singerId: z.string().trim().min(1),
  songId: z.string().trim().min(1),
  requestedBy: z.string().trim().min(1).optional(),
  customerNote: z.string().trim().max(300).default(''),
  idempotencyKey,
})

const paymentSchema = z.object({
  paymentReference: z.string().trim().min(4).max(128),
  collectionChannel: z.enum(['cash', 'physical_pos']),
  idempotencyKey,
})

const actionSchema = z.object({
  action: z.enum(['confirm', 'accept', 'start', 'complete', 'reject', 'cancel', 'refund']),
  reason: z.string().trim().max(300).default(''),
  refundReference: z.string().trim().max(128).default(''),
  idempotencyKey,
})

const singerProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  photoUrl: z.string().trim().max(500).refine((value) => !value || value.startsWith('/') || value.startsWith('https://'), '照片地址必须是站内路径或HTTPS地址'),
  headline: z.string().trim().max(100),
  bio: z.string().trim().max(600),
  styleTags: z.array(z.string().trim().min(1).max(20)).max(6),
  active: z.boolean(),
})

const createSingerSchema = singerProfileSchema.extend({
  actorId: z.string().trim().min(1).max(128).optional(),
})

const repertoireSchema = z.object({
  title: z.string().trim().min(1).max(120),
  artist: z.string().trim().min(1).max(120),
  durationSeconds: z.number().int().min(30).max(1800),
  priceAmount: z.number().int().positive().max(10_000_000),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default('CNY'),
  enabled: z.boolean().default(true),
})

const appearanceSchema = z.object({
  id: z.string().trim().min(1).max(128),
  singerId: z.string().trim().min(1).max(128),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  requestOpensAt: z.iso.datetime({ offset: true }),
  requestClosesAt: z.iso.datetime({ offset: true }),
  acceptingRequests: z.boolean(),
})

const performanceSchema = z.object({
  businessDate: z.iso.date(),
  title: z.string().trim().min(1).max(120),
  status: z.enum(['scheduled', 'live', 'completed', 'cancelled']),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  appearances: z.array(appearanceSchema).min(1).max(30),
})

function mutateSong(state: RuntimeState, operation: () => SongRequest) {
  const idempotencyCount = state.songState.idempotencyRecords.length
  const result = operation()
  if (state.songState.idempotencyRecords.length !== idempotencyCount) state.revision += 1
  return result
}

export function registerSongRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/songs/singers', async (request, reply) => {
    const input = createSingerSchema.parse(request.body)
    const singer = await repository.mutate((state) => {
      requireConfiguredOperation(request, state, 'song.manage')
      const id = `singer_${randomUUID()}`
      const next = { ...input, id, actorId: input.actorId ?? id }
      state.songState.singers.push(next)
      validateSongConfiguration(state.songState)
      state.revision += 1
      return next
    })
    return reply.status(201).send(singer)
  })

  app.put<{ Params: { singerId: string } }>('/api/songs/singers/:singerId/profile', async (request) => {
    const input = singerProfileSchema.parse(request.body)
    return repository.mutate((state) => {
      requireConfiguredOperation(request, state, 'song.manage')
      const singer = state.songState.singers.find((item) => item.id === request.params.singerId)
      if (!singer) throw new Error('歌手不存在')
      singer.displayName = input.displayName
      singer.photoUrl = input.photoUrl
      singer.headline = input.headline
      singer.bio = input.bio
      singer.styleTags = [...new Set(input.styleTags)]
      singer.active = input.active
      validateSongConfiguration(state.songState)
      state.revision += 1
      return singer
    })
  })

  app.post<{ Params: { singerId: string } }>('/api/songs/singers/:singerId/repertoire', async (request, reply) => {
    const input = repertoireSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      requireConfiguredOperation(request, state, 'song.manage')
      if (!state.songState.singers.some((item) => item.id === request.params.singerId)) throw new Error('歌手不存在')
      const song: SongCatalogItem = {
        id: `song_${randomUUID()}`,
        title: input.title,
        artist: input.artist,
        durationSeconds: input.durationSeconds,
        active: true,
      }
      const offer: SingerRepertoireEntry = {
        id: `repertoire_${randomUUID()}`,
        singerId: request.params.singerId,
        songId: song.id,
        priceAmount: input.priceAmount,
        currency: input.currency,
        configVersion: 1,
        enabled: input.enabled,
      }
      state.songState.songs.push(song)
      state.songState.repertoire.push(offer)
      validateSongConfiguration(state.songState)
      state.revision += 1
      return { song, offer }
    })
    return reply.status(201).send(result)
  })

  app.put<{ Params: { entryId: string } }>('/api/songs/repertoire/:entryId', async (request) => {
    const input = repertoireSchema.parse(request.body)
    return repository.mutate((state) => {
      requireConfiguredOperation(request, state, 'song.manage')
      const offer = state.songState.repertoire.find((item) => item.id === request.params.entryId)
      if (!offer) throw new Error('曲库报价不存在')
      const song = state.songState.songs.find((item) => item.id === offer.songId)
      if (!song) throw new Error('歌曲不存在')
      song.title = input.title
      song.artist = input.artist
      song.durationSeconds = input.durationSeconds
      song.active = true
      offer.priceAmount = input.priceAmount
      offer.currency = input.currency
      offer.enabled = input.enabled
      offer.configVersion += 1
      validateSongConfiguration(state.songState)
      state.revision += 1
      return { song, offer }
    })
  })

  app.put<{ Params: { sessionId: string } }>('/api/songs/performances/:sessionId', async (request) => {
    const input = performanceSchema.parse(request.body)
    return repository.mutate((state) => {
      requireConfiguredOperation(request, state, 'song.manage')
      const session: PerformanceSession = { id: request.params.sessionId, ...input }
      const index = state.songState.performanceSessions.findIndex((item) => item.id === session.id)
      if (index === -1) state.songState.performanceSessions.push(session)
      else state.songState.performanceSessions[index] = session
      if (session.businessDate === state.store.businessDate) state.songState.businessDate = state.store.businessDate
      validateSongConfiguration(state.songState)
      state.revision += 1
      return session
    })
  })

  app.post('/api/songs/requests', async (request, reply) => {
    const input = submitSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'song.request')
      return mutateSong(state, () => submitSongRequest(state.songState, {
        ...input,
        requestId: deterministicId('song_request', input.idempotencyKey),
        requestedBy: actor.actorId,
        occurredAt: new Date().toISOString(),
      }))
    })
    return reply.status(201).send(result)
  })

  app.post<{ Params: { requestId: string } }>('/api/songs/requests/:requestId/payment', async (request) => {
    const input = paymentSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'payment.intent.create')
      return mutateSong(state, () => {
        const songRequest = state.songState.requests.find((item) => item.id === request.params.requestId)
        if (!songRequest) throw new Error('点歌请求不存在')
        return markSongRequestPaid(state.songState, {
          requestId: songRequest.id,
          paymentReference: input.paymentReference,
          paidAmount: songRequest.priceSnapshot.priceAmount,
          currency: songRequest.priceSnapshot.currency,
          collectionChannel: input.collectionChannel,
          actor: { actorId: actor.actorId, role: 'staff' },
          occurredAt: new Date().toISOString(),
          idempotencyKey: input.idempotencyKey,
        })
      })
    })
  })

  app.post<{ Params: { requestId: string } }>('/api/songs/requests/:requestId/actions', async (request) => {
    const input = actionSchema.parse(request.body)
    return repository.mutate((state) => {
      const songRequest = state.songState.requests.find((item) => item.id === request.params.requestId)
      if (!songRequest) throw new Error('点歌请求不存在')
      const serviceDecision = input.action === 'confirm' || (input.action === 'reject' && songRequest.status === 'pending_confirmation')
      const actor = requireConfiguredOperation(request, state, serviceDecision ? 'song.request' : 'song.manage')
      const command = {
        requestId: request.params.requestId,
        actor: { actorId: actor.actorId, role: serviceDecision ? 'staff' as const : 'manager' as const },
        occurredAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      }
      return mutateSong(state, () => {
        if (input.action === 'confirm') return confirmSongRequest(state.songState, command)
        if (input.action === 'accept') return acceptSongRequest(state.songState, command)
        if (input.action === 'start') return startSongPerformance(state.songState, command)
        if (input.action === 'complete') return completeSongRequest(state.songState, command)
        if (input.action === 'reject') return rejectSongRequest(state.songState, { ...command, reason: input.reason })
        if (input.action === 'cancel') return cancelSongRequest(state.songState, { ...command, reason: input.reason })
        return markSongRequestRefunded(state.songState, { ...command, refundReference: input.refundReference })
      })
    })
  })
}
