import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { StaffPermissionDeploymentChange } from '../../src/shared/normalized-contracts.js'
import { IdempotencyConflictError, IdempotencyInProgressError } from './command-executor.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import { StaffAccessDeniedError, StaffNotFoundError } from './staff-access-repository.js'
import { StaffAccessManagementService } from './staff-access-management-service.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import type { StoreScope } from './transaction-runner.js'

interface Context {
  scope: StoreScope
  employeeId: string
  businessDate: string
}

export const staffAccessManagementApiPlugin: FastifyPluginAsync<{
  service: StaffAccessManagementService
  resolveContext(request: FastifyRequest): Promise<Context>
}> = async (app, options) => {
  app.get('/staff-access/overview', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    const data = await options.service.getOverview({ scope: context.scope, actorEmployeeId: context.employeeId })
    return reply.send({ data, meta: { generatedAt: data.generatedAt } })
  }))

  app.post('/staff-access/deploy', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    const body = object(request.body)
    const changes = changeArray(body.changes)
    const reason = text(body.reason, '发布原因', 200, 2)
    const idempotencyKey = idempotency(request)
    const data = await options.service.deployPermissions({
      scope: context.scope,
      actorEmployeeId: context.employeeId,
      businessDate: context.businessDate,
      idempotencyKey,
      requestFingerprint: JSON.stringify({ actorEmployeeId: context.employeeId, reason, changes }),
      reason,
      changes,
    })
    return reply.send({ data, meta: { generatedAt: data.verifiedAt } })
  }))
}

async function handle(reply: FastifyReply, operation: () => Promise<FastifyReply>) {
  try { return await operation() } catch (error) {
    if (error instanceof NormalizedAuthenticationRequiredError || error instanceof StaffSessionNotFoundError) {
      return reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: '登录状态已失效，请重新登录', retryable: false } })
    }
    if (error instanceof StaffAccessDeniedError || error instanceof StaffNotFoundError) {
      return reply.code(403).send({ error: { code: 'STAFF_ACCESS_FORBIDDEN', message: '当前账号没有权限管理授权配置', retryable: false } })
    }
    if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) {
      return reply.code(409).send({ error: { code: 'PERMISSION_DEPLOYMENT_CONFLICT', message: '这次发布正在处理或与另一项修改冲突，请刷新确认', retryable: true } })
    }
    if (error instanceof TypeError || error instanceof RequestError) {
      return reply.code(400).send({ error: { code: 'PERMISSION_DEPLOYMENT_INVALID', message: error.message, retryable: false } })
    }
    requestLog(reply, error)
    return reply.code(500).send({ error: { code: 'PERMISSION_DEPLOYMENT_FAILED', message: '权限没有发布成功，原配置保持不变，请重试', retryable: true } })
  }
}

class RequestError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RequestError('请求内容格式无效')
  return value as Record<string, unknown>
}

function changeArray(value: unknown): StaffPermissionDeploymentChange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new RequestError('每次需发布1至100项权限修改')
  return value.map((entry) => {
    const item = object(entry)
    if (item.kind === 'role_permission') {
      const permissionCode = code(item.permissionCode, '权限代码')
      if (typeof item.enabled !== 'boolean') throw new RequestError('岗位权限开关格式无效')
      return { kind: item.kind, roleId: text(item.roleId, '岗位', 64, 8), permissionCode, enabled: item.enabled }
    }
    if (item.kind === 'employee_override') {
      const permissionCode = code(item.permissionCode, '权限代码')
      if (item.effect !== 'grant' && item.effect !== 'deny' && item.effect !== null) throw new RequestError('员工例外类型无效')
      return { kind: item.kind, employeeId: text(item.employeeId, '员工', 64, 8), permissionCode, effect: item.effect }
    }
    if (item.kind === 'role_data_scope') {
      const effect = item.effect
      if (effect !== 'include' && effect !== 'exclude') throw new RequestError('数据范围方式无效')
      if (typeof item.enabled !== 'boolean') throw new RequestError('数据范围开关格式无效')
      const scopeValue = jsonValue(item.scopeValue, '数据范围')
      return {
        kind: item.kind, roleId: text(item.roleId, '岗位', 64, 8),
        scopeKey: code(item.scopeKey, '数据范围代码'), effect, scopeValue, enabled: item.enabled,
      }
    }
    if (item.kind === 'role_approval_limit') {
      if (typeof item.enabled !== 'boolean') throw new RequestError('审批规则开关格式无效')
      const amountMinor = item.amountMinor === null ? null : integer(item.amountMinor, '审批金额', 0, 100_000_000_000)
      const currency = text(item.currency, '币种', 3, 3)
      if (!/^[A-Z]{3}$/.test(currency)) throw new RequestError('币种格式无效')
      return {
        kind: item.kind, roleId: text(item.roleId, '岗位', 64, 8),
        approvalCode: code(item.approvalCode, '审批规则代码'), amountMinor, currency,
        rules: jsonObject(item.rules, '审批规则'), enabled: item.enabled,
      }
    }
    if (item.kind === 'role_navigation') {
      if (typeof item.enabled !== 'boolean') throw new RequestError('岗位入口开关格式无效')
      const route = text(item.route, '入口路径', 120, 2)
      if (!/^\/staff\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(route)) throw new RequestError('入口路径不属于员工系统')
      const icon = item.icon === null ? null : optionalText(item.icon, '入口图标', 64)
      return {
        kind: item.kind, roleId: text(item.roleId, '岗位', 64, 8),
        navigationCode: code(item.navigationCode, '入口代码'), label: text(item.label, '入口名称', 30, 1),
        route, icon, sortOrder: integer(item.sortOrder, '入口顺序', 0, 999), enabled: item.enabled,
        displayConfig: jsonObject(item.displayConfig, '入口显示设置'),
      }
    }
    throw new RequestError('权限修改类型无效')
  })
}

function text(value: unknown, label: string, maximum: number, minimum: number) {
  if (typeof value !== 'string') throw new RequestError(`${label}格式无效`)
  const result = value.trim()
  if (result.length < minimum || result.length > maximum) throw new RequestError(`${label}格式无效`)
  return result
}

function code(value: unknown, label: string) {
  const result = text(value, label, 128, 3)
  if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(result)) throw new RequestError(`${label}格式无效`)
  return result
}

function optionalText(value: unknown, label: string, maximum: number) {
  if (value === undefined || value === '') return null
  return text(value, label, maximum, 1)
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RequestError(`${label}格式无效`)
  }
  return value
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RequestError(`${label}格式无效`)
  JSON.stringify(value)
  return value as Record<string, unknown>
}

function jsonValue(value: unknown, label: string): unknown {
  if (value === null || value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new RequestError(`${label}格式无效`)
  }
  try { JSON.stringify(value) } catch { throw new RequestError(`${label}格式无效`) }
  return value
}

function idempotency(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'] ?? request.headers['x-idempotency-key']
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(value)) throw new RequestError('缺少有效的发布请求标识')
  return value
}

function requestLog(reply: FastifyReply, error: unknown) {
  reply.log.error({ err: error }, 'staff permission deployment failed')
}
