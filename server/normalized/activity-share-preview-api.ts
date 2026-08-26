import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { CustomerExperienceService } from './customer-experience-service.js'
import type { StoreScope } from './transaction-runner.js'

/**
 * A read-only acquisition preview for a Mini Program share recipient.
 *
 * This is intentionally separate from the member detail endpoint: it resolves
 * only the server-owned store scope, does not authenticate a reservation or
 * WeChat session, and never creates a customer/session as a side effect.
 */
export interface ActivitySharePreviewApiOptions {
  service: Pick<CustomerExperienceService, 'activitySharePreview'>
  resolveShareScope(request: FastifyRequest): Readonly<StoreScope> | Promise<Readonly<StoreScope>>
}

export const activitySharePreviewApiPlugin: FastifyPluginAsync<ActivitySharePreviewApiOptions> = async (app, options) => {
  app.get<{ Params: { activityPublicId: string } }>(
    '/public/mini/activity-previews/:activityPublicId',
    async (request, reply) => handle(reply, async () => {
      const publicId = shareActivityPublicId(request.params.activityPublicId)
      const data = await options.service.activitySharePreview(
        await options.resolveShareScope(request), publicId,
      )
      // The response is deliberately non-personal, but no-store prevents a
      // stale availability label from being treated as a current entitlement.
      reply.header('Cache-Control', 'no-store, max-age=0').header('Pragma', 'no-cache')
      return reply.send({ data, meta: { registrationRequiresMembership: true } })
    }),
  )
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) {
  try {
    return await execute()
  } catch (error) {
    if (error instanceof ActivitySharePreviewInputError) {
      return reply.code(404).send({ error: { code: 'ACTIVITY_NOT_FOUND', message: '活动暂不可查看' } })
    }
    if (error instanceof CustomerExperienceRequestError) {
      if (error.statusCode === 404) {
        return reply.code(404).send({ error: { code: 'ACTIVITY_NOT_FOUND', message: '活动暂不可查看' } })
      }
      return unavailable(reply)
    }
    return unavailable(reply)
  }
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: {
    code: 'ACTIVITY_SHARE_PREVIEW_UNAVAILABLE',
    message: '活动预览暂时无法读取，请稍后重试',
  } })
}

class ActivitySharePreviewInputError extends Error {}

function shareActivityPublicId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]+$/.test(value)) {
    throw new ActivitySharePreviewInputError()
  }
  return value
}
