import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  CustomerExperienceAnalyticsRepository,
  type CustomerExperienceAnalyticsFilter,
  type PerformancePhaseCode,
} from './customer-experience-analytics-repository.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface CustomerExperienceAnalyticsStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
}

export interface CustomerExperienceAnalyticsApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  resolveStaffContext(request: FastifyRequest):
    | CustomerExperienceAnalyticsStaffContext
    | Promise<CustomerExperienceAnalyticsStaffContext>
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository, 'assertPermission'>
  createAnalyticsRepository?(transaction: ScopedTransaction): Pick<
    CustomerExperienceAnalyticsRepository, 'dashboard' | 'recentObservations'
  >
}

const PHASES = ['before_show','acoustic','band_live','intermission','after_show'] as const
const OCCASIONS = ['business','friends','date','birthday','music','relax','other'] as const
const RECOMMENDATION_OUTCOMES = [
  'all','paid','refunded','complaint','follow_on_order','repeat_purchase','margin_unavailable',
] as const

export const customerExperienceAnalyticsApiPlugin: FastifyPluginAsync<
  CustomerExperienceAnalyticsApiOptions
> = async (app, options) => {
  app.get('/staff/customer-experience/analytics', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveStaffContext(request)
    const filter = analyticsFilter(request.query)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
      await access.assertPermission(context.employeeId, 'recommendation.analytics.view')
      await access.assertPermission(context.employeeId, 'product.observation.analytics.view')
      return (options.createAnalyticsRepository?.(transaction)
        ?? new CustomerExperienceAnalyticsRepository(transaction)).dashboard(filter)
    }, { readOnly: true })
    return reply.send({ data })
  }))
  app.get('/staff/customer-experience/analytics/observations', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveStaffContext(request)
    const query = object(request.query)
    const filter = analyticsFilter(query)
    const limit = optionalInteger(query.limit, '记录数量', 1, 200) ?? 50
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
      await access.assertPermission(context.employeeId, 'product.observation.analytics.view')
      await access.assertPermission(context.employeeId, 'observation.view.raw')
      return (options.createAnalyticsRepository?.(transaction)
        ?? new CustomerExperienceAnalyticsRepository(transaction)).recentObservations(filter,limit)
    }, { readOnly: true })
    return reply.send({ data })
  }))
}

function analyticsFilter(value: unknown): CustomerExperienceAnalyticsFilter {
  const query = object(value)
  if (query.customerSegment!==undefined && query.customerSegment!==null && query.customerSegment!=='') {
    throw new AnalyticsRequestError('客群筛选尚缺事件时点的版本化分群事实，当前不可用')
  }
  const until = timestamp(query.until ?? new Date().toISOString(), '结束时间')
  const defaultFrom = new Date(Date.parse(until)-7*24*60*60*1000).toISOString()
  return {
    from: timestamp(query.from ?? defaultFrom, '开始时间'),
    until,
    productId: optionalUuid(query.productId, '商品'),
    employeeId: optionalUuid(query.employeeId, '员工'),
    partySize: optionalInteger(query.partySize, '人数', 1, 100),
    occasion: optionalEnumeration(query.occasion, '场景', OCCASIONS),
    performancePhase: optionalEnumeration(query.performancePhase, '演出阶段', PHASES),
    tableCode: optionalTableCode(query.tableCode),
    packageProductId: optionalUuid(query.packageProductId, '套餐'),
    recommendationOutcome: optionalEnumeration(
      query.recommendationOutcome ?? 'all','推荐结果',RECOMMENDATION_OUTCOMES,
    ) ?? 'all',
  }
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) {
  try { return await execute() } catch (error) {
    if (isStaffAuthenticationRequiredError(error)) {
      return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    }
    if (error instanceof AnalyticsRequestError) {
      return reply.code(400).send({ error: { code: 'ANALYTICS_FILTER_INVALID', message: error.message } })
    }
    if (error instanceof StaffAccessDeniedError) {
      return reply.code(403).send({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有查看该经营分析的权限' } })
    }
    if (error instanceof TypeError && error.message.startsWith('analytics ')) {
      return reply.code(400).send({ error: { code: 'ANALYTICS_FILTER_INVALID', message: '分析时间范围不正确' } })
    }
    throw error
  }
}

class AnalyticsRequestError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (value===undefined || value===null) return {}
  if (typeof value!=='object' || Array.isArray(value)) throw new AnalyticsRequestError('筛选条件格式不正确')
  return value as Record<string, unknown>
}

function timestamp(value: unknown,label: string): string {
  if (typeof value!=='string' || !Number.isFinite(Date.parse(value))) throw new AnalyticsRequestError(`${label}格式不正确`)
  return new Date(value).toISOString()
}

function optionalUuid(value: unknown,label: string): string | null {
  if (value===undefined || value===null || value==='') return null
  if (typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AnalyticsRequestError(`${label}格式不正确`)
  }
  return value
}

function optionalInteger(value: unknown,label: string,minimum: number,maximum: number): number | null {
  if (value===undefined || value===null || value==='') return null
  const parsed = typeof value==='string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || (parsed as number)<minimum || (parsed as number)>maximum) {
    throw new AnalyticsRequestError(`${label}超出范围`)
  }
  return parsed as number
}

function optionalEnumeration<const Values extends readonly string[]>(
  value: unknown,label: string,values: Values,
): Values[number] | null {
  if (value===undefined || value===null || value==='') return null
  if (typeof value!=='string' || !values.includes(value)) throw new AnalyticsRequestError(`${label}不受支持`)
  return value as PerformancePhaseCode & Values[number]
}

function optionalTableCode(value: unknown): string | null {
  if (value===undefined || value===null || value==='') return null
  if (typeof value!=='string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value.trim())) {
    throw new AnalyticsRequestError('桌号格式不正确')
  }
  return value.trim()
}
