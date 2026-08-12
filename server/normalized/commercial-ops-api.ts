import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  type JsonCodec,
  type JsonObject,
  type JsonValue,
  type NormalizedCommandExecutor,
} from './command-executor.js'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import {
  CommercialIntegrityError,
  CommercialOpsRepository,
  CommercialRecordNotFoundError,
  CostAlreadyCorrectedError,
  SalesAttributionNotAllowedError,
  SalesRuleOverlapError,
  VoucherAlreadyRedeemedError,
  voucherCodeDigest,
  type CostAllocationPeriod,
  type CostCategory,
  type CostRecognitionState,
  type CostSourceType,
  type EmployeeSalesAttributionEvent,
  type EmployeeSalesRule,
  type GroupVoucherRedemption,
  type OperatingCostEntry,
  type SalesAttributionMode,
  type WriteOperatingCostInput,
} from './commercial-ops-repository.js'
import {
  ProfitQueryService,
  type CostSummaryRow,
  type EmployeeSalesRow,
  type ProfitPeriod,
  type VoucherSummaryRow,
} from './profit-query-service.js'
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
  StaffNotFoundError,
  type EffectiveStaffAccess,
} from './staff-access-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
} from './transaction-runner.js'

type CommandExecutorPort = Pick<NormalizedCommandExecutor, 'execute'>
type TransactionRunnerPort = Pick<ScopedPostgresTransactionRunner, 'run'>
type ProfitQueryPort = Pick<
  ProfitQueryService,
  'getProfitReport' | 'listEmployeeSales' | 'listCosts' | 'listVouchers'
>

export interface CommercialOpsApiOptions {
  transactions: TransactionRunnerPort
  commandExecutor: CommandExecutorPort
  queryService: ProfitQueryPort
  resolveContext(request: FastifyRequest): Promise<NormalizedOperationsRequestContext>
    | NormalizedOperationsRequestContext
  createRepository?(transaction: ScopedTransaction): CommercialOpsRepository
  createStaffAccessRepository?(transaction: ScopedTransaction): StaffAccessRepository
  createPublicId?(kind: 'cost' | 'sales-rule' | 'voucher'): string
}

interface CostResult extends JsonObject {
  id: string
  publicId: string
  category: string
  recognitionState: string
  allocationPeriod: string
  serviceStartDate: string
  serviceEndDate: string
  cashPaidOn: string | null
  netAmountMinor: number
  taxAmountMinor: number
  grossAmountMinor: number
  currency: string
  sourceType: string
  correctsCostEntryId: string | null
  correctionReason: string | null
  recordedBusinessDate: string
  recordedAt: string
}

interface SalesRuleResult extends JsonObject {
  id: string
  productId: string
  attributionMode: string
  salesCreditBps: number
  costSource: string
  effectiveFrom: string
  effectiveUntil: string
  reason: string
  createdAt: string
}

interface AttributionResult extends JsonObject {
  id: string
  eventType: string
  orderItemId: string
  businessDate: string
  quantityDelta: string
  salesAmountDeltaMinor: number
  costAmountDeltaMinor: number | null
  currency: string
}

interface ReversalResult extends JsonObject {
  refundId: string
  reversals: JsonValue[]
}

interface VoucherResult extends JsonObject {
  id: string
  publicId: string
  platform: string
  campaignName: string
  voucherCodeMasked: string
  faceValueMinor: number
  settlementAmountMinor: number
  currency: string
  isSettled: boolean
  redeemedBusinessDate: string
  redeemedAt: string
}

export const commercialOpsApiPlugin: FastifyPluginAsync<CommercialOpsApiOptions> = async (
  app,
  options,
) => {
  const createRepository = options.createRepository ?? ((transaction) => new CommercialOpsRepository(transaction))
  const createAccess = options.createStaffAccessRepository ?? ((transaction) => new StaffAccessRepository(transaction))
  const createPublicId = options.createPublicId ?? defaultPublicId

  app.get('/commercial-ops/profit', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    await assertLivePermission(options.transactions, createAccess, context, 'commercial.profit.view')
    const query = readObject(request.query ?? {})
    const period = readPeriod(query.period)
    const anchor = readDate(query.anchor ?? context.businessDate, 'anchor')
    return reply.send({ data: await options.queryService.getProfitReport(context.scope, period, anchor) })
  }))

  app.get('/commercial-ops/costs', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    await assertLivePermission(options.transactions, createAccess, context, 'commercial.cost.view')
    const range = readRange(request.query, context.businessDate)
    const rows = await options.queryService.listCosts(context.scope, range.startDate, range.endDate)
    return reply.send({ data: rows.map(toCostSummaryDto) })
  }))

  app.post('/commercial-ops/costs', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const input = readCostInput(body, context, createPublicId('cost'))
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.commandExecutor.execute({
      scope: context.scope,
      operationScope: 'commercial.cost.create',
      idempotencyKey,
      requestFingerprint: fingerprint({ input, actor: context.employeeId }),
      resultCodec: jsonCodec<CostResult>(),
    }, async (transaction) => {
      await createAccess(transaction).assertPermission(context.employeeId, 'commercial.cost.manage')
      const cost = await createRepository(transaction).createCost(input)
      const result = toCostResult(cost)
      return {
        result,
        auditEvents: [{
          actor: { type: 'employee', employeeId: context.employeeId },
          action: 'commercial.cost.created', objectType: 'operating_cost', objectId: cost.id,
          businessDate: context.businessDate,
          afterData: auditCost(result),
        }],
        outboxMessages: [{
          aggregateType: 'operating_cost', aggregateId: cost.id, aggregateVersion: 1,
          eventType: 'commercial.cost.created.v1', payload: auditCost(result),
        }],
      }
    })
    return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, replayed: execution.replayed })
  }))

  app.post<{ Params: { costId: string } }>(
    '/commercial-ops/costs/:costId/corrections',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await options.resolveContext(request)
      const costId = readUuid(request.params.costId, 'costId')
      const body = readObject(request.body)
      const reason = readString(body.correctionReason, 'correctionReason', 1000, 2)
      const input = readCostInput(body, context, createPublicId('cost'))
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.commandExecutor.execute({
        scope: context.scope, operationScope: 'commercial.cost.correct', idempotencyKey,
        requestFingerprint: fingerprint({ costId, input, reason, actor: context.employeeId }),
        resultCodec: jsonCodec<CostResult>(),
      }, async (transaction) => {
        await createAccess(transaction).assertPermission(context.employeeId, 'commercial.cost.manage')
        const cost = await createRepository(transaction).correctCost(costId, input, reason)
        const result = toCostResult(cost)
        return {
          result,
          auditEvents: [{
            actor: { type: 'employee', employeeId: context.employeeId },
            action: 'commercial.cost.corrected', objectType: 'operating_cost', objectId: cost.id,
            businessDate: context.businessDate, reason,
            metadata: { correctedCostEntryId: costId }, afterData: auditCost(result),
          }],
          outboxMessages: [{
            aggregateType: 'operating_cost', aggregateId: cost.id, aggregateVersion: 1,
            eventType: 'commercial.cost.corrected.v1',
            payload: { ...auditCost(result), correctedCostEntryId: costId },
          }],
        }
      })
      return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, replayed: execution.replayed })
    }),
  )

  app.post('/commercial-ops/sales-rules', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const idempotencyKey = readIdempotencyKey(request)
    const input = {
      productId: readUuid(body.productId, 'productId'),
      attributionMode: readAttributionMode(body.attributionMode),
      salesCreditBps: readInteger(body.salesCreditBps, 'salesCreditBps', 0, 10_000),
      costSource: readCostSource(body.costSource),
      effectiveFrom: readTimestamp(body.effectiveFrom, 'effectiveFrom'),
      effectiveUntil: readTimestamp(body.effectiveUntil, 'effectiveUntil'),
      ruleSnapshot: readSafeSnapshot(body.ruleSnapshot),
      reason: readString(body.reason, 'reason', 1000, 2),
      configuredByEmployeeId: context.employeeId,
    } as const
    const execution = await options.commandExecutor.execute({
      scope: context.scope, operationScope: 'commercial.sales-rule.create', idempotencyKey,
      requestFingerprint: fingerprint({ input, actor: context.employeeId }),
      resultCodec: jsonCodec<SalesRuleResult>(),
    }, async (transaction) => {
      await createAccess(transaction).assertPermission(context.employeeId, 'commercial.sales.rule.manage')
      const rule = await createRepository(transaction).createSalesRule(input)
      const result = toSalesRuleResult(rule)
      return {
        result,
        auditEvents: [{
          actor: { type: 'employee', employeeId: context.employeeId },
          action: 'commercial.sales_rule.created', objectType: 'employee_sales_rule', objectId: rule.id,
          businessDate: context.businessDate, reason: rule.reason, afterData: result,
        }],
        outboxMessages: [{
          aggregateType: 'employee_sales_rule', aggregateId: rule.id, aggregateVersion: 1,
          eventType: 'commercial.sales_rule.created.v1', payload: result,
        }],
      }
    })
    return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, replayed: execution.replayed })
  }))

  app.post('/commercial-ops/sales-attributions', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const input = {
      orderItemId: readUuid(body.orderItemId, 'orderItemId'),
      explicitEmployeeId: body.employeeId === undefined ? null : readUuid(body.employeeId, 'employeeId'),
      recordedByEmployeeId: context.employeeId,
    }
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.commandExecutor.execute({
      scope: context.scope, operationScope: 'commercial.sales-attribution.record', idempotencyKey,
      requestFingerprint: fingerprint({ input, actor: context.employeeId }),
      resultCodec: jsonCodec<AttributionResult>(),
    }, async (transaction) => {
      await createAccess(transaction).assertPermission(context.employeeId, 'commercial.sales.attribute')
      const event = await createRepository(transaction).recordSaleAttribution(input)
      const result = toAttributionResult(event)
      return {
        result,
        auditEvents: [{
          actor: { type: 'employee', employeeId: context.employeeId },
          action: 'commercial.sales_attribution.recorded', objectType: 'sales_attribution', objectId: event.id,
          businessDate: context.businessDate, afterData: result,
        }],
        outboxMessages: [{
          aggregateType: 'sales_attribution', aggregateId: event.id, aggregateVersion: 1,
          eventType: 'commercial.sales_attribution.recorded.v1', payload: result,
        }],
      }
    })
    return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, replayed: execution.replayed })
  }))

  app.post<{ Params: { refundId: string } }>(
    '/commercial-ops/refunds/:refundId/sales-reversal',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await options.resolveContext(request)
      const refundId = readUuid(request.params.refundId, 'refundId')
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.commandExecutor.execute({
        scope: context.scope, operationScope: 'commercial.sales-attribution.refund-reversal', idempotencyKey,
        requestFingerprint: fingerprint({ refundId, actor: context.employeeId }),
        resultCodec: jsonCodec<ReversalResult>(),
      }, async (transaction) => {
        await createAccess(transaction).assertPermission(context.employeeId, 'commercial.sales.attribute')
        const events = await createRepository(transaction).reverseSalesForRefund(refundId, context.employeeId)
        const result: ReversalResult = {
          refundId,
          reversals: events.map((event) => toAttributionResult(event)),
        }
        return {
          result,
          auditEvents: [{
            actor: { type: 'employee', employeeId: context.employeeId },
            action: 'commercial.sales_attribution.refund_reversed', objectType: 'refund', objectId: refundId,
            businessDate: context.businessDate,
            afterData: { reversalCount: events.length },
          }],
          outboxMessages: events.map((event) => ({
            aggregateType: 'sales_attribution', aggregateId: event.id, aggregateVersion: 1,
            eventType: 'commercial.sales_attribution.refund_reversed.v1',
            payload: toAttributionResult(event),
          })),
        }
      })
      return reply.send({ data: execution.value, replayed: execution.replayed })
    }),
  )

  app.get('/commercial-ops/employee-sales', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    const range = readRange(request.query, context.businessDate)
    const requested = readObject(request.query ?? {})
    const requestedEmployeeId = requested.employeeId === undefined
      ? undefined : readUuid(requested.employeeId, 'employeeId')
    const productId = requested.productId === undefined ? undefined : readUuid(requested.productId, 'productId')
    const access = await resolveLiveAccess(options.transactions, createAccess, context)
    const employeeIds = resolveEmployeeScope(access, context.employeeId, requestedEmployeeId)
    const rows = await options.queryService.listEmployeeSales(context.scope, {
      ...range, employeeIds, productId,
    })
    return reply.send({ data: rows.map(toEmployeeSalesDto) })
  }))

  app.get('/commercial-ops/vouchers', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    await assertLivePermission(options.transactions, createAccess, context, 'commercial.voucher.view')
    const range = readRange(request.query, context.businessDate)
    const rows = await options.queryService.listVouchers(context.scope, range.startDate, range.endDate)
    return reply.send({ data: rows.map(toVoucherSummaryDto) })
  }))

  app.post('/commercial-ops/vouchers/redeem', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const voucherCode = readString(body.voucherCode, 'voucherCode', 256, 4)
    const input = {
      publicId: readOptionalString(body.publicId, 'publicId', 128, 8) ?? createPublicId('voucher'),
      platform: readString(body.platform, 'platform', 64),
      campaignName: readString(body.campaignName, 'campaignName', 128),
      voucherCode,
      faceValueMinor: readInteger(body.faceValueMinor, 'faceValueMinor', 0),
      settlementAmountMinor: readInteger(body.settlementAmountMinor, 'settlementAmountMinor', 0),
      currency: readCurrency(body.currency),
      orderId: body.orderId === undefined ? null : readUuid(body.orderId, 'orderId'),
      tableSessionId: body.tableSessionId === undefined ? null : readUuid(body.tableSessionId, 'tableSessionId'),
      reconciliationEntryId: body.reconciliationEntryId === undefined
        ? null : readUuid(body.reconciliationEntryId, 'reconciliationEntryId'),
      redeemedByEmployeeId: context.employeeId,
      redeemedBusinessDate: context.businessDate,
    }
    const voucherHash = voucherCodeDigest(voucherCode)
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.commandExecutor.execute({
      scope: context.scope, operationScope: 'commercial.voucher.redeem', idempotencyKey,
      requestFingerprint: fingerprint({ ...input, voucherCode: voucherHash, actor: context.employeeId }),
      resultCodec: jsonCodec<VoucherResult>(),
    }, async (transaction) => {
      await createAccess(transaction).assertPermission(context.employeeId, 'commercial.voucher.redeem')
      const voucher = await createRepository(transaction).redeemVoucher(input)
      const result = toVoucherResult(voucher)
      return {
        result,
        auditEvents: [{
          actor: { type: 'employee', employeeId: context.employeeId },
          action: 'commercial.voucher.redeemed', objectType: 'group_voucher', objectId: voucher.id,
          businessDate: context.businessDate,
          afterData: { ...result, voucherCodeHashPrefix: voucherHash.slice(0, 12) },
        }],
        outboxMessages: [{
          aggregateType: 'group_voucher', aggregateId: voucher.id, aggregateVersion: 1,
          eventType: 'commercial.voucher.redeemed.v1', payload: result,
        }],
      }
    })
    return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, replayed: execution.replayed })
  }))
}

async function assertLivePermission(
  transactions: TransactionRunnerPort,
  createAccess: (transaction: ScopedTransaction) => StaffAccessRepository,
  context: NormalizedOperationsRequestContext,
  permission: string,
): Promise<void> {
  await transactions.run(context.scope, async (transaction) => {
    await createAccess(transaction).assertPermission(context.employeeId, permission)
  }, { readOnly: true })
}

async function resolveLiveAccess(
  transactions: TransactionRunnerPort,
  createAccess: (transaction: ScopedTransaction) => StaffAccessRepository,
  context: NormalizedOperationsRequestContext,
): Promise<EffectiveStaffAccess> {
  return transactions.run(context.scope, async (transaction) => createAccess(transaction).resolve(context.employeeId), {
    readOnly: true,
  })
}

function resolveEmployeeScope(
  access: EffectiveStaffAccess,
  actorEmployeeId: string,
  requestedEmployeeId?: string,
): string[] | undefined {
  if (access.permissions.includes('commercial.sales.view_all')) {
    return requestedEmployeeId ? [requestedEmployeeId] : undefined
  }
  if (!access.permissions.includes('commercial.sales.view')) throw new StaffAccessDeniedError('Employee sales permission is required')
  const included = new Set<string>([actorEmployeeId])
  const excluded = new Set<string>()
  for (const scope of access.dataScopes.filter((value) => value.key === 'commercial.employee_ids')) {
    const ids = readScopeIds(scope.value)
    for (const id of ids) (scope.effect === 'include' ? included : excluded).add(id)
  }
  for (const id of excluded) included.delete(id)
  if (requestedEmployeeId) {
    if (!included.has(requestedEmployeeId)) throw new StaffAccessDeniedError('Employee is outside the current data scope')
    return [requestedEmployeeId]
  }
  return [...included].toSorted()
}

function readScopeIds(value: JsonValue): string[] {
  if (typeof value === 'string') return isUuid(value) ? [value] : []
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && isUuid(item))
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const ids = value.employeeIds
    return Array.isArray(ids) ? ids.filter((item): item is string => typeof item === 'string' && isUuid(item)) : []
  }
  return []
}

function readCostInput(
  body: Record<string, unknown>,
  context: NormalizedOperationsRequestContext,
  defaultPublicIdValue: string,
): WriteOperatingCostInput {
  return {
    publicId: readOptionalString(body.publicId, 'publicId', 128, 8) ?? defaultPublicIdValue,
    category: readEnum(body.category, COST_CATEGORIES, 'category'),
    recognitionState: readEnum(body.recognitionState, RECOGNITION_STATES, 'recognitionState'),
    allocationPeriod: readEnum(body.allocationPeriod, ALLOCATION_PERIODS, 'allocationPeriod'),
    serviceStartDate: readDate(body.serviceStartDate, 'serviceStartDate'),
    serviceEndDate: readDate(body.serviceEndDate, 'serviceEndDate'),
    cashPaidOn: body.cashPaidOn === undefined || body.cashPaidOn === null
      ? null : readDate(body.cashPaidOn, 'cashPaidOn'),
    netAmountMinor: readInteger(body.netAmountMinor, 'netAmountMinor', 0),
    taxAmountMinor: body.taxAmountMinor === undefined ? 0 : readInteger(body.taxAmountMinor, 'taxAmountMinor', 0),
    currency: readCurrency(body.currency),
    sourceType: readEnum(body.sourceType, SOURCE_TYPES, 'sourceType'),
    purchaseReceiptLineId: body.purchaseReceiptLineId === undefined
      ? null : readUuid(body.purchaseReceiptLineId, 'purchaseReceiptLineId'),
    employeeId: body.employeeId === undefined ? null : readUuid(body.employeeId, 'employeeId'),
    scheduleId: body.scheduleId === undefined ? null : readUuid(body.scheduleId, 'scheduleId'),
    sourceReference: readOptionalString(body.sourceReference, 'sourceReference', 256),
    sourceSnapshot: readSafeSnapshot(body.sourceSnapshot),
    recordedBusinessDate: context.businessDate,
    recordedByEmployeeId: context.employeeId,
  }
}

function readSafeSnapshot(value: unknown): JsonObject {
  if (value === undefined) return {}
  const snapshot = readObject(value)
  const serialized = JSON.stringify(snapshot)
  if (serialized.length > 16_384) throw new CommercialApiRequestError('snapshot is too large')
  return JSON.parse(serialized) as JsonObject
}

function toCostResult(cost: OperatingCostEntry): CostResult {
  return {
    id: cost.id, publicId: cost.publicId, category: cost.category,
    recognitionState: cost.recognitionState, allocationPeriod: cost.allocationPeriod,
    serviceStartDate: cost.serviceStartDate, serviceEndDate: cost.serviceEndDate,
    cashPaidOn: cost.cashPaidOn, netAmountMinor: cost.netAmountMinor,
    taxAmountMinor: cost.taxAmountMinor, grossAmountMinor: cost.grossAmountMinor,
    currency: cost.currency, sourceType: cost.sourceType,
    correctsCostEntryId: cost.correctsCostEntryId,
    correctionReason: cost.correctionReason, recordedBusinessDate: cost.recordedBusinessDate,
    recordedAt: cost.recordedAt,
  }
}

function auditCost(value: CostResult): JsonObject {
  return {
    category: value.category, recognitionState: value.recognitionState,
    allocationPeriod: value.allocationPeriod, serviceStartDate: value.serviceStartDate,
    serviceEndDate: value.serviceEndDate, cashPaidOn: value.cashPaidOn,
    netAmountMinor: value.netAmountMinor, taxAmountMinor: value.taxAmountMinor,
    grossAmountMinor: value.grossAmountMinor, currency: value.currency,
    sourceType: value.sourceType,
  }
}

function toSalesRuleResult(rule: EmployeeSalesRule): SalesRuleResult {
  return {
    id: rule.id, productId: rule.productId, attributionMode: rule.attributionMode,
    salesCreditBps: rule.salesCreditBps, costSource: rule.costSource,
    effectiveFrom: rule.effectiveFrom, effectiveUntil: rule.effectiveUntil,
    reason: rule.reason, createdAt: rule.createdAt,
  }
}

function toAttributionResult(event: EmployeeSalesAttributionEvent): AttributionResult {
  return {
    id: event.id, eventType: event.eventType, orderItemId: event.orderItemId,
    businessDate: event.businessDate,
    quantityDelta: event.quantityDelta, salesAmountDeltaMinor: event.salesAmountDeltaMinor,
    costAmountDeltaMinor: event.costAmountDeltaMinor, currency: event.currency,
  }
}

function toVoucherResult(value: GroupVoucherRedemption): VoucherResult {
  return {
    id: value.id, publicId: value.publicId, platform: value.platform,
    campaignName: value.campaignName, voucherCodeMasked: value.voucherCodeMasked,
    faceValueMinor: value.faceValueMinor, settlementAmountMinor: value.settlementAmountMinor,
    currency: value.currency, isSettled: value.reconciliationEntryId !== null,
    redeemedBusinessDate: value.redeemedBusinessDate, redeemedAt: value.redeemedAt,
  }
}

function toCostSummaryDto(value: CostSummaryRow) { return value }
function toVoucherSummaryDto(value: VoucherSummaryRow) { return value }
function toEmployeeSalesDto(value: EmployeeSalesRow) {
  return {
    employeeCode: value.employeeCode, employeeDisplayName: value.employeeDisplayName,
    productCode: value.productCode, productName: value.productName,
    categoryCode: value.categoryCode, quantity: value.quantity,
    salesAmountMinor: value.salesAmountMinor, costAmountMinor: value.costAmountMinor,
    contributionProfitMinor: value.contributionProfitMinor,
    refundReversalAmountMinor: value.refundReversalAmountMinor,
    costCoverageComplete: value.costCoverageComplete, currency: value.currency,
  }
}

function readRange(value: unknown, fallbackDate: string) {
  const query = readObject(value ?? {})
  const startDate = readDate(query.startDate ?? fallbackDate, 'startDate')
  const endDate = readDate(query.endDate ?? fallbackDate, 'endDate')
  if (endDate < startDate) throw new CommercialApiRequestError('date range is invalid')
  return { startDate, endDate }
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CommercialApiRequestError('request object is invalid')
  }
  return value as Record<string, unknown>
}

function readString(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== 'string') throw new CommercialApiRequestError(`${label} is invalid`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) throw new CommercialApiRequestError(`${label} is invalid`)
  return normalized
}

function readOptionalString(value: unknown, label: string, max: number, min = 1): string | null {
  if (value === undefined || value === null || value === '') return null
  return readString(value, label, max, min)
}

function readInteger(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new CommercialApiRequestError(`${label} must be an integer between ${min} and ${max}`)
  }
  return Number(value)
}

function readUuid(value: unknown, label: string): string {
  const id = readString(value, label, 36, 36)
  if (!isUuid(id)) throw new CommercialApiRequestError(`${label} is invalid`)
  return id
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function readDate(value: unknown, label: string): string {
  const date = readString(value, label, 10, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new CommercialApiRequestError(`${label} must use YYYY-MM-DD`)
  }
  return date
}

function readTimestamp(value: unknown, label: string): string {
  const timestamp = readString(value, label, 64, 10)
  if (Number.isNaN(Date.parse(timestamp))) throw new CommercialApiRequestError(`${label} is invalid`)
  return new Date(timestamp).toISOString()
}

function readCurrency(value: unknown): string {
  const currency = readString(value, 'currency', 3, 3)
  if (!/^[A-Z]{3}$/.test(currency)) throw new CommercialApiRequestError('currency is invalid')
  return currency
}

function readPeriod(value: unknown): ProfitPeriod {
  return readEnum(value ?? 'day', PROFIT_PERIODS, 'period')
}

function readAttributionMode(value: unknown): SalesAttributionMode {
  return readEnum(value, ATTRIBUTION_MODES, 'attributionMode')
}

function readCostSource(value: unknown): 'order_item_snapshot' | 'none' {
  return readEnum(value ?? 'order_item_snapshot', COST_SOURCES, 'costSource')
}

function readEnum<Value extends string>(value: unknown, values: readonly Value[], label: string): Value {
  const parsed = readString(value, label, 64)
  if (!values.includes(parsed as Value)) throw new CommercialApiRequestError(`${label} is invalid`)
  return parsed as Value
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'] ?? request.headers['x-idempotency-key']
  if (Array.isArray(value) || typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) {
    throw new CommercialApiRequestError('valid idempotency key is required')
  }
  return value
}

function fingerprint(value: unknown): string { return JSON.stringify(value) }

function jsonCodec<Value>(): JsonCodec<Value> {
  return {
    encode: (value) => JSON.parse(JSON.stringify(value)) as JsonValue,
    decode: (value) => value as Value,
  }
}

function defaultPublicId(kind: 'cost' | 'sales-rule' | 'voucher'): string {
  return `${kind}-${randomUUID()}`
}

class CommercialApiRequestError extends Error {}

async function handleRoute(reply: FastifyReply, operation: () => Promise<FastifyReply>) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof StaffAccessDeniedError) {
      return reply.code(403).send({ error: { code: 'COMMERCIAL_FORBIDDEN', message: '当前员工没有执行此操作的权限' } })
    }
    if (error instanceof StaffNotFoundError) {
      return reply.code(401).send({ error: { code: 'COMMERCIAL_SESSION_INVALID', message: '员工登录状态无效' } })
    }
    if (error instanceof CommercialRecordNotFoundError) {
      return reply.code(404).send({ error: { code: 'COMMERCIAL_NOT_FOUND', message: error.message } })
    }
    if (error instanceof CostAlreadyCorrectedError
      || error instanceof SalesRuleOverlapError
      || error instanceof VoucherAlreadyRedeemedError
      || error instanceof IdempotencyConflictError
      || error instanceof IdempotencyInProgressError) {
      return reply.code(409).send({ error: { code: 'COMMERCIAL_CONFLICT', message: error.message } })
    }
    if (error instanceof CommercialApiRequestError
      || error instanceof CommercialIntegrityError
      || error instanceof SalesAttributionNotAllowedError
      || error instanceof TypeError
      || error instanceof RangeError) {
      return reply.code(400).send({ error: { code: 'COMMERCIAL_REQUEST_INVALID', message: error.message } })
    }
    if (error instanceof IdempotencyRecordError) {
      return reply.code(503).send({ error: { code: 'COMMERCIAL_TEMPORARILY_UNAVAILABLE', message: '经营数据服务暂时不可用' } })
    }
    return reply.code(500).send({ error: { code: 'COMMERCIAL_INTERNAL_ERROR', message: '经营数据服务暂时不可用' } })
  }
}

const COST_CATEGORIES = [
  'beverage_purchase', 'personnel', 'performer', 'band',
  'rent', 'utilities', 'miscellaneous',
] as const satisfies readonly CostCategory[]
const RECOGNITION_STATES = ['known', 'accrual', 'actual'] as const satisfies readonly CostRecognitionState[]
const ALLOCATION_PERIODS = ['day', 'week', 'month', 'quarter', 'year'] as const satisfies readonly CostAllocationPeriod[]
const SOURCE_TYPES = [
  'inventory_purchase', 'payroll', 'performance', 'lease', 'utility_bill', 'manual',
] as const satisfies readonly CostSourceType[]
const ATTRIBUTION_MODES = ['explicit', 'order_creator', 'table_primary', 'disabled'] as const
const COST_SOURCES = ['order_item_snapshot', 'none'] as const
const PROFIT_PERIODS = ['day', 'week', 'month', 'quarter', 'year'] as const
