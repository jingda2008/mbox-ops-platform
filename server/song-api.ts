import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { SongRequest } from '../src/shared/song-contracts.js'
import { requireConfiguredOperation } from './authorization.js'
import type { RuntimeRepository } from './repository.js'
import {
  acceptSongRequest,
  cancelSongRequest,
  completeSongRequest,
  markSongRequestPaid,
  markSongRequestRefunded,
  rejectSongRequest,
  startSongPerformance,
  submitSongRequest,
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
  idempotencyKey,
})

const actionSchema = z.object({
  action: z.enum(['accept', 'start', 'complete', 'reject', 'cancel', 'refund']),
  reason: z.string().trim().max(300).default(''),
  refundReference: z.string().trim().max(128).default(''),
  idempotencyKey,
})

function mutateSong(state: RuntimeState, operation: () => SongRequest) {
  const idempotencyCount = state.songState.idempotencyRecords.length
  const result = operation()
  if (state.songState.idempotencyRecords.length !== idempotencyCount) state.revision += 1
  return result
}

export function registerSongRoutes(app: FastifyInstance, repository: RuntimeRepository) {
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
          actor: { actorId: actor.actorId, role: 'manager' },
          occurredAt: new Date().toISOString(),
          idempotencyKey: input.idempotencyKey,
        })
      })
    })
  })

  app.post<{ Params: { requestId: string } }>('/api/songs/requests/:requestId/actions', async (request) => {
    const input = actionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'song.manage')
      const command = {
        requestId: request.params.requestId,
        actor: { actorId: actor.actorId, role: 'manager' as const },
        occurredAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      }
      return mutateSong(state, () => {
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
