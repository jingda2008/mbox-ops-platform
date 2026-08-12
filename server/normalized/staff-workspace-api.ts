import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type {
  NormalizedApiErrorBody,
  NormalizedApiSuccessBody,
  StaffBootstrapView,
} from '../../src/shared/normalized-contracts.js'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import { StaffAccessDeniedError, StaffNotFoundError } from './staff-access-repository.js'
import type { StaffBootstrapQuery } from './staff-bootstrap-query.js'
import { StaffBootstrapStoreNotFoundError } from './staff-bootstrap-query.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'

type StaffBootstrapQueryPort = Pick<StaffBootstrapQuery, 'get'>

export interface StaffWorkspaceApiOptions {
  query: StaffBootstrapQueryPort
  resolveContext(request: FastifyRequest): Promise<NormalizedOperationsRequestContext>
    | NormalizedOperationsRequestContext
}

export const staffWorkspaceApiPlugin: FastifyPluginAsync<StaffWorkspaceApiOptions> = async (app, options) => {
  app.get('/staff/workspace', async (request, reply) => handle(reply, request, async () => {
    const context = await options.resolveContext(request)
    const result = await options.query.get(context.scope, context.employeeId, context.businessDate)
    reply.header('etag', result.etag)
    reply.header('cache-control', 'private, no-cache')
    reply.header('vary', 'Cookie, Authorization')
    if (etagMatches(request.headers['if-none-match'], result.etag)) {
      return reply.code(304).send()
    }
    const body: NormalizedApiSuccessBody<StaffBootstrapView> = {
      data: result.view,
      meta: { requestId: request.id, generatedAt: result.view.generatedAt },
    }
    return reply.send(body)
  }))
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  return header.split(',').some((candidate) => {
    const normalized = candidate.trim()
    return normalized === '*' || normalized === etag || normalized === `W/${etag}`
  })
}

async function handle(
  reply: FastifyReply,
  request: FastifyRequest,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error, request.id)
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function mapError(error: unknown, requestId: string): { statusCode: number; body: NormalizedApiErrorBody } {
  if (
    error instanceof NormalizedAuthenticationRequiredError
    || error instanceof StaffSessionNotFoundError
  ) return apiError(401, 'AUTH_REQUIRED', '登录信息已过期，请重新登录', false, requestId)
  if (error instanceof StaffAccessDeniedError || error instanceof StaffNotFoundError) {
    return apiError(403, 'STAFF_ACCESS_FORBIDDEN', '当前员工无权查看工作台', false, requestId)
  }
  if (
    error instanceof TrustedStoreScopeError
    || error instanceof NormalizedStoreUnavailableError
    || error instanceof StaffBootstrapStoreNotFoundError
  ) return apiError(403, 'STORE_ACCESS_FORBIDDEN', '当前门店不可用', false, requestId)
  return apiError(503, 'STAFF_WORKSPACE_UNAVAILABLE', '工作台暂时不可用，请稍后重试', true, requestId)
}

function apiError(
  statusCode: number,
  code: string,
  message: string,
  retryable: boolean,
  requestId: string,
) {
  return { statusCode, body: { error: { code, message, retryable }, meta: { requestId } } }
}
