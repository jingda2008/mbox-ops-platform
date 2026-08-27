import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { PublicCustomerExperienceContext } from './customer-experience-service.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { WechatLoyaltyNotificationRepository } from './wechat-loyalty-notification-repository.js'
import { WechatMemberServiceNotificationRepository } from './wechat-member-service-notification-repository.js'
import {
  decideWechatNotificationPrompt,
  WECHAT_NOTIFICATION_PROMPT_CONTEXTS,
  type WechatNotificationPromptContext,
} from './wechat-notification-prompt-decision-engine.js'

interface Options {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  channelConfigured: boolean
  resolvePublicContext(request: FastifyRequest): Promise<PublicCustomerExperienceContext> | PublicCustomerExperienceContext
}

export const wechatNotificationPromptApiPlugin: FastifyPluginAsync<Options> = async (app, options) => {
  app.get('/public/mini/wechat-notification-prompt', async (request, reply) => {
    let context: WechatNotificationPromptContext
    try { context = promptContext(request.query) } catch {
      return reply.status(400).send({
        code: 'WECHAT_NOTIFICATION_PROMPT_CONTEXT_INVALID', message: '提醒触发场景格式不正确',
      })
    }
    if (!options.channelConfigured) return reply.send({
      data: { available: false, context, authorizations: [] },
    })
    const customer = await options.resolvePublicContext(request)
    const authorizations = await options.transactions.run(customer.scope, async (transaction) => {
      const [loyaltyAuthorizations, memberServiceAuthorizations] = await Promise.all([
        new WechatLoyaltyNotificationRepository(transaction).authorizationOptions(customer.customerId, true),
        new WechatMemberServiceNotificationRepository(transaction).authorizationOptions(customer.customerId, true),
      ])
      return decideWechatNotificationPrompt({ context, loyaltyAuthorizations, memberServiceAuthorizations })
    }, { readOnly: true })
    return reply.send({ data: { available: authorizations.length > 0, context, authorizations } })
  })
}

function promptContext(value: unknown): WechatNotificationPromptContext {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).context : null
  if (typeof candidate !== 'string' || !WECHAT_NOTIFICATION_PROMPT_CONTEXTS.includes(candidate as WechatNotificationPromptContext)) {
    throw new TypeError('提醒触发场景格式不正确')
  }
  return candidate as WechatNotificationPromptContext
}
