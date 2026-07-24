import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type {
  CommercialOpsConfig,
  CommercialOpsState,
  OperatingCostEntry,
  ProcurementBatch,
  RecurringCostTemplate,
  ScanCodeBinding,
} from '../src/shared/commercial-ops-contracts.js'
import { operatingCostCategoryIds } from '../src/shared/commercial-ops-contracts.js'
import type { RuntimeState, StaffPermissionId } from '../src/shared/contracts.js'
import { effectivePermissionIdsForEmployee } from '../src/shared/staff-access.js'
import { requireRequestActor } from './auth-context.js'
import { AuthorizationError, requireConfiguredOperation } from './authorization.js'
import {
  commercialOpsFor,
  fingerprint,
  idempotentResult,
  recordCommercialMutation,
  salesByEmployeeCategory,
} from './commercial-ops.js'
import { convertIngredientQuantityToBase, receiveInventory } from './inventory-domain.js'
import { ensureInventoryDomainState } from './inventory-api.js'
import { buildProfitCenterReport, recurringOccurrenceRange } from './profit-center.js'
import type { RuntimeRepository } from './repository.js'

const identifier = z.string().trim().min(1).max(128)
const reason = z.string().trim().min(2).max(500)
const occurredAt = z.string().datetime({ offset: true })
const idempotencyKey = z.string().trim().min(8).max(128)
const money = z.number().int().nonnegative().max(1_000_000_000)
const positiveQuantity = z.number().positive().max(1_000_000_000)
const positiveMoney = z.number().int().positive().max(1_000_000_000)
const unitCode = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/)
const dateKey = z.iso.date()

const printerSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(80),
  connectionMode: z.enum(['network', 'android_bridge', 'browser']),
  endpointReference: z.string().trim().max(256),
  enabled: z.boolean(),
}).strict()

const printerRouteSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(80),
  stationIds: z.array(identifier).max(30),
  categoryIds: z.array(identifier).max(30),
  printerId: identifier,
  copies: z.number().int().min(1).max(3),
  enabled: z.boolean(),
}).strict()

const configSchema = z.object({
  orderSafety: z.object({
    enabled: z.boolean(),
    duplicateWindowSeconds: z.number().int().min(5).max(300),
    maxOrdersPerMinute: z.number().int().min(1).max(20),
    requireSubmitConfirmation: z.boolean(),
    requireContinuationConfirmationSeconds: z.number().int().min(0).max(900),
  }).strict(),
  inventoryControl: z.object({
    cocktailAllowedLossBps: z.number().int().min(0).max(5000),
    snackCountMode: z.enum(['integer', 'decimal']),
  }).strict(),
  printers: z.array(printerSchema).max(20),
  printerRoutes: z.array(printerRouteSchema).max(50),
  tipping: z.object({
    enabled: z.boolean(),
    recipientModes: z.array(z.enum(['team', 'singer', 'staff'])).min(1).max(3),
    presetAmounts: z.array(money).min(1).max(10),
    customAmountEnabled: z.boolean(),
    minimumAmount: money,
    maximumAmount: money,
  }).strict(),
  reason,
  idempotencyKey,
}).strict().superRefine((value, context) => {
  const printerIds = new Set(value.printers.map((printer) => printer.id))
  if (printerIds.size !== value.printers.length) context.addIssue({ code: 'custom', path: ['printers'], message: '打印机编号不能重复' })
  if (value.printerRoutes.some((route) => !printerIds.has(route.printerId))) context.addIssue({ code: 'custom', path: ['printerRoutes'], message: '打印分流引用了不存在的打印机' })
  if (value.tipping.minimumAmount > value.tipping.maximumAmount) context.addIssue({ code: 'custom', path: ['tipping'], message: '打赏最小金额不能大于最大金额' })
})

const scanBindingSchema = z.object({
  bindingId: identifier.optional(),
  code: z.string().trim().min(3).max(256),
  symbology: z.enum(['qr', 'ean13', 'code128', 'custom']),
  targetType: z.enum(['product', 'ingredient']),
  targetId: identifier,
  countMode: z.enum(['integer', 'decimal']),
  enabled: z.boolean(),
  reason,
  occurredAt,
  idempotencyKey,
}).strict()

const procurementSchema = z.object({
  targetType: z.enum(['product', 'ingredient']),
  targetId: identifier,
  scanCode: z.string().trim().min(3).max(256).optional(),
  supplierName: z.string().trim().min(1).max(120),
  supplierReference: z.string().trim().max(120).default(''),
  quantity: positiveQuantity,
  unitCode,
  unitCostAmount: money,
  reason,
  occurredAt,
  idempotencyKey,
}).strict()

const voucherSchema = z.object({
  platform: z.string().trim().min(1).max(60),
  campaignName: z.string().trim().min(1).max(120),
  voucherCode: z.string().trim().min(4).max(256),
  faceValueAmount: money,
  settlementAmount: money,
  tableSessionId: identifier.optional(),
  orderId: identifier.optional(),
  reason,
  occurredAt,
  idempotencyKey,
}).strict()

const memberTagsSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(40)).max(30),
  reason,
  occurredAt,
  idempotencyKey,
}).strict()

const printDecisionSchema = z.object({
  status: z.enum(['queued', 'printed', 'failed']),
  error: z.string().trim().max(300).default(''),
  occurredAt,
  idempotencyKey,
}).strict()

const costEntrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: z.enum(operatingCostCategoryIds),
  amount: positiveMoney,
  status: z.enum(['estimated', 'actual']),
  recognitionMode: z.enum(['on_start', 'spread_daily']),
  recognitionStartDate: dateKey,
  recognitionEndDate: dateKey,
  counterparty: z.string().trim().max(120).default(''),
  reference: z.string().trim().max(120).default(''),
  note: z.string().trim().max(500).default(''),
  replacesEntryId: identifier.optional(),
  sourceTemplateId: identifier.optional(),
  sourceOccurrenceDate: dateKey.optional(),
  reason,
  occurredAt,
  idempotencyKey,
}).strict().superRefine((value, context) => {
  if (value.recognitionEndDate < value.recognitionStartDate) {
    context.addIssue({ code: 'custom', path: ['recognitionEndDate'], message: '费用结束日期不能早于开始日期' })
  }
  if (value.recognitionMode === 'on_start' && value.recognitionEndDate !== value.recognitionStartDate) {
    context.addIssue({ code: 'custom', path: ['recognitionEndDate'], message: '一次确认费用的开始和结束日期应相同' })
  }
  if (value.replacesEntryId && value.status !== 'actual') {
    context.addIssue({ code: 'custom', path: ['replacesEntryId'], message: '只有实际账单可以替代预估费用' })
  }
  if (Boolean(value.sourceTemplateId) !== Boolean(value.sourceOccurrenceDate)) {
    context.addIssue({ code: 'custom', path: ['sourceTemplateId'], message: '关联周期费用时必须同时指定账期' })
  }
})

const costVoidSchema = z.object({
  reason,
  occurredAt,
  idempotencyKey,
}).strict()

const recurringCostTemplateSchema = z.object({
  templateId: identifier.optional(),
  name: z.string().trim().min(1).max(120),
  categoryId: z.enum(operatingCostCategoryIds),
  amount: positiveMoney,
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
  recognitionMode: z.enum(['on_start', 'spread_daily']),
  startDate: dateKey,
  endDate: dateKey.nullable().default(null),
  counterparty: z.string().trim().max(120).default(''),
  note: z.string().trim().max(500).default(''),
  enabled: z.boolean(),
  reason,
  occurredAt,
  idempotencyKey,
}).strict().superRefine((value, context) => {
  if (value.endDate && value.endDate < value.startDate) {
    context.addIssue({ code: 'custom', path: ['endDate'], message: '周期费用结束日期不能早于开始日期' })
  }
})

const recurringCostStatusSchema = z.object({
  enabled: z.boolean(),
  reason,
  occurredAt,
  idempotencyKey,
}).strict()

const profitQuerySchema = z.object({
  period: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('month'),
  anchor: dateKey,
}).strict()

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function requireAnyPermission(request: FastifyRequest, state: RuntimeState, allowed: StaffPermissionId[]) {
  const actor = requireRequestActor(request)
  const permissions = effectivePermissionIdsForEmployee(state, actor.actorId)
  if (!allowed.some((permission) => permissions.includes(permission))) {
    throw new AuthorizationError('当前岗位无权查看经营工具', 'commercial_ops.view')
  }
  return actor
}

function mutateCommercial<T>(state: RuntimeState, operation: (domain: CommercialOpsState) => T) {
  const domain = commercialOpsFor(state)
  const before = domain.idempotencyRecords.length
  const value = operation(domain)
  if (domain.idempotencyRecords.length !== before) state.revision += 1
  return value
}

function maskedVoucher(code: string) {
  return code.length <= 8 ? `${code.slice(0, 2)}****${code.slice(-2)}` : `${code.slice(0, 4)}******${code.slice(-4)}`
}

function applyProcurementWeightedAverage(
  state: RuntimeState,
  input: {
    targetType: 'product' | 'ingredient'
    targetId: string
    quantity: number
    unitCostAmount: number
    occurredAt: string
    actorId: string
    reason: string
    idempotencyKey: string
  },
  converted: ReturnType<typeof convertIngredientQuantityToBase> | null,
) {
  const inventory = ensureInventoryDomainState(state)
  const incomingCost = Math.round(input.quantity * input.unitCostAmount)
  const balanceBeforeReceipt = inventory.balances.find((balance) => balance.productId === input.targetId)?.onHandQuantity ?? 0
  const previousQuantity = Math.max(0, balanceBeforeReceipt)
  if (input.targetType === 'ingredient' && converted) {
    const ingredient = inventory.ingredientSkus.find((item) => item.id === input.targetId)
    if (!ingredient || converted.baseQuantity <= 0) return null
    const previousCost = ingredient.costAmountPerBaseUnit
    const nextCost = Math.round(
      (previousQuantity * previousCost + incomingCost) / (previousQuantity + converted.baseQuantity),
    )
    ingredient.costAmountPerBaseUnit = nextCost
    ingredient.revision += 1
    ingredient.updatedAt = input.occurredAt
    ingredient.updatedBy = input.actorId
    inventory.auditEvents.push({
      tenantId: inventory.tenantId,
      storeId: inventory.storeId,
      id: deterministicId('inventory_cost_audit', input.idempotencyKey),
      action: 'inventory.ingredient.weighted_cost_updated.v1',
      objectType: 'ingredient_sku',
      objectId: ingredient.id,
      actorId: input.actorId,
      approvalId: null,
      tableSessionId: null,
      orderId: null,
      reason: input.reason,
      occurredAt: input.occurredAt,
      details: {
        previousCostAmountPerBaseUnit: previousCost,
        nextCostAmountPerBaseUnit: nextCost,
        previousQuantity,
        incomingBaseQuantity: converted.baseQuantity,
        incomingCost,
      },
    })
    return { previousUnitCostAmount: previousCost, nextUnitCostAmount: nextCost }
  }
  const product = state.products.find((item) => item.id === input.targetId)
  if (!product || input.quantity <= 0) return null
  const previousCost = product.costAmount
  const nextCost = Math.round(
    (previousQuantity * previousCost + incomingCost) / (previousQuantity + input.quantity),
  )
  product.costAmount = nextCost
  product.configVersion += 1
  state.auditEntries.push({
    id: deterministicId('product_cost_audit', input.idempotencyKey),
    actorId: input.actorId,
    action: 'product.weighted_cost_updated.v1',
    objectType: 'product',
    objectId: product.id,
    occurredAt: input.occurredAt,
    details: {
      reason: input.reason,
      previousCostAmount: previousCost,
      nextCostAmount: nextCost,
      previousQuantity,
      incomingQuantity: input.quantity,
      incomingCost,
    },
  })
  return { previousUnitCostAmount: previousCost, nextUnitCostAmount: nextCost }
}

export function registerCommercialOpsRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.get('/api/commercial-ops', async (request) => {
    const state = await repository.read()
    const actor = requireAnyPermission(request, state, [
      'config.manage', 'inventory.view', 'inventory.manage', 'inventory.approve',
      'payment.collect', 'finance.view', 'benefit.view', 'benefit.manage', 'order.view', 'kds.prepare',
    ])
    const permissions = new Set(effectivePermissionIdsForEmployee(state, actor.actorId))
    const domain = structuredClone(commercialOpsFor(state))
    domain.idempotencyRecords = []
    if (!permissions.has('finance.view')) {
      domain.costEntries = []
      domain.recurringCostTemplates = []
    }
    if (!permissions.has('config.manage')) {
      domain.config.printers = domain.config.printers.map((printer) => ({ ...printer, endpointReference: '' }))
      domain.auditEvents = []
    }
    if (!permissions.has('inventory.view') && !permissions.has('inventory.manage') && !permissions.has('inventory.approve')) {
      domain.scanCodeBindings = []
      domain.procurementBatches = []
    }
    if (!permissions.has('payment.collect') && !permissions.has('finance.view')) {
      domain.voucherRedemptions = []
      domain.tipRecords = []
    }
    return {
      state: domain,
      salesByEmployeeCategory: permissions.has('order.view') || permissions.has('finance.view')
        ? salesByEmployeeCategory(state)
        : [],
    }
  })

  app.get('/api/commercial-ops/profit-center', async (request) => {
    const state = await repository.read()
    requireAnyPermission(request, state, ['finance.view'])
    const query = profitQuerySchema.parse(request.query)
    const domain = commercialOpsFor(state)
    return {
      report: buildProfitCenterReport(state, query.period, query.anchor),
      costEntries: structuredClone(domain.costEntries).toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
      recurringCostTemplates: structuredClone(domain.recurringCostTemplates).toSorted((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    }
  })

  app.put('/api/commercial-ops/config', async (request) => {
    const input = configSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'config.write')
      return mutateCommercial(state, (domain) => {
        const inputFingerprint = fingerprint(input)
        const replay = idempotentResult(domain, input.idempotencyKey, 'commercial.config.update', inputFingerprint)
        if (replay) return domain.config
        const now = new Date().toISOString()
        const config: CommercialOpsConfig = {
          version: domain.config.version + 1,
          orderSafety: structuredClone(input.orderSafety),
          inventoryControl: structuredClone(input.inventoryControl),
          printers: structuredClone(input.printers),
          printerRoutes: structuredClone(input.printerRoutes),
          tipping: structuredClone(input.tipping),
          updatedAt: now,
          updatedBy: actor.actorId,
        }
        domain.config = config
        recordCommercialMutation(domain, {
          key: input.idempotencyKey, operation: 'commercial.config.update', inputFingerprint,
          resultId: `commercial-config-v${config.version}`, actorId: actor.actorId,
          action: 'commercial.config.updated.v1', objectType: 'commercial_config', reason: input.reason,
          occurredAt: now, details: { version: config.version },
        })
        return config
      })
    })
  })

  app.post('/api/commercial-ops/scan-bindings', async (request, reply) => {
    const input = scanBindingSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'inventory.approve')
      const inventory = ensureInventoryDomainState(state)
      const targetExists = input.targetType === 'product'
        ? state.products.some((product) => product.id === input.targetId)
        : inventory.ingredientSkus.some((ingredient) => ingredient.id === input.targetId)
      if (!targetExists) throw new Error('商品码关联的货品或原料不存在')
      return mutateCommercial(state, (domain) => {
        const inputFingerprint = fingerprint(input)
        const replay = idempotentResult(domain, input.idempotencyKey, 'commercial.scan_binding.upsert', inputFingerprint)
        if (replay) return domain.scanCodeBindings.find((binding) => binding.id === replay)!
        const duplicate = domain.scanCodeBindings.find((binding) => binding.code === input.code && binding.id !== input.bindingId)
        if (duplicate) throw new Error(`这个码已绑定${duplicate.targetId}，请先核对再修改`)
        const existing = domain.scanCodeBindings.find((binding) => binding.id === input.bindingId)
        const binding: ScanCodeBinding = existing ?? {
          id: input.bindingId ?? deterministicId('scan_binding', input.idempotencyKey),
          code: input.code,
          symbology: input.symbology,
          targetType: input.targetType,
          targetId: input.targetId,
          countMode: input.countMode,
          enabled: input.enabled,
          updatedAt: input.occurredAt,
          updatedBy: actor.actorId,
        }
        Object.assign(binding, {
          code: input.code, symbology: input.symbology, targetType: input.targetType,
          targetId: input.targetId, countMode: input.countMode, enabled: input.enabled,
          updatedAt: input.occurredAt, updatedBy: actor.actorId,
        })
        if (!existing) domain.scanCodeBindings.push(binding)
        recordCommercialMutation(domain, {
          key: input.idempotencyKey, operation: 'commercial.scan_binding.upsert', inputFingerprint,
          resultId: binding.id, actorId: actor.actorId, action: existing ? 'commercial.scan_binding.updated.v1' : 'commercial.scan_binding.created.v1',
          objectType: 'scan_binding', reason: input.reason, occurredAt: input.occurredAt,
          details: { code: input.code, targetType: input.targetType, targetId: input.targetId },
        })
        return binding
      })
    })
    return reply.status(201).send(result)
  })

  app.post('/api/commercial-ops/procurement-batches', async (request, reply) => {
    const input = procurementSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'inventory.manage')
      const inventory = ensureInventoryDomainState(state)
      const ingredient = inventory.ingredientSkus.find((item) => item.id === input.targetId)
      if (input.targetType === 'ingredient' && !ingredient) throw new Error('采购原料不存在')
      if (input.targetType === 'product' && !state.products.some((product) => product.id === input.targetId)) throw new Error('采购商品不存在')
      const commercial = commercialOpsFor(state)
      const inputFingerprint = fingerprint(input)
      const replay = idempotentResult(commercial, input.idempotencyKey, 'commercial.procurement.receive', inputFingerprint)
      if (replay) return commercial.procurementBatches.find((batch) => batch.id === replay)!
      if (input.scanCode) {
        const binding = commercial.scanCodeBindings.find((candidate) => candidate.code === input.scanCode && candidate.enabled)
        if (!binding || binding.targetId !== input.targetId || binding.targetType !== input.targetType) throw new Error('扫描码与本次采购货品不匹配')
        if (binding.countMode === 'integer' && !Number.isInteger(input.quantity)) throw new Error('这个货品按整数入库，请输入整件数量')
      }
      const targetProduct = input.targetType === 'product' ? state.products.find((product) => product.id === input.targetId) : null
      if (targetProduct?.categoryId === 'food' && commercial.config.inventoryControl.snackCountMode === 'integer' && !Number.isInteger(input.quantity)) {
        throw new Error('小吃库存统一按整数入库和盘点')
      }
      const converted = ingredient
        ? convertIngredientQuantityToBase(inventory, input.targetId, input.unitCode, input.quantity)
        : null
      const weightedCost = applyProcurementWeightedAverage(state, {
        targetType: input.targetType,
        targetId: input.targetId,
        quantity: input.quantity,
        unitCostAmount: input.unitCostAmount,
        occurredAt: input.occurredAt,
        actorId: actor.actorId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      }, converted)
      receiveInventory(inventory, {
        movementId: deterministicId('inventory_movement', input.idempotencyKey),
        productId: input.targetId,
        unitCode: converted?.ingredient.baseUnitCode ?? input.unitCode,
        quantity: converted?.baseQuantity ?? input.quantity,
        actorId: actor.actorId,
        reason: `${input.reason}；供应商：${input.supplierName}`,
        businessDate: state.store.businessDate,
        occurredAt: input.occurredAt,
        idempotencyKey: `${input.idempotencyKey}:inventory`,
        configurationSnapshot: converted ? {
          kind: 'unit_conversion', inputQuantity: input.quantity, inputUnitCode: input.unitCode,
          conversion: structuredClone(converted.conversion), ingredient: structuredClone(converted.ingredient),
        } : null,
      })
      const batch: ProcurementBatch = {
        id: deterministicId('procurement_batch', input.idempotencyKey),
        targetType: input.targetType,
        targetId: input.targetId,
        scanCode: input.scanCode ?? null,
        supplierName: input.supplierName,
        supplierReference: input.supplierReference,
        quantity: input.quantity,
        unitCode: input.unitCode,
        unitCostAmount: input.unitCostAmount,
        totalCostAmount: Math.round(input.quantity * input.unitCostAmount),
        receivedAt: input.occurredAt,
        receivedBy: actor.actorId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      }
      commercial.procurementBatches.push(batch)
      recordCommercialMutation(commercial, {
        key: input.idempotencyKey, operation: 'commercial.procurement.receive', inputFingerprint,
        resultId: batch.id, actorId: actor.actorId, action: 'commercial.procurement.received.v1',
        objectType: 'procurement_batch', reason: input.reason, occurredAt: input.occurredAt,
        details: {
          targetId: input.targetId,
          supplierName: input.supplierName,
          totalCostAmount: batch.totalCostAmount,
          weightedCost,
        },
      })
      state.revision += 1
      return batch
    })
    return reply.status(201).send(result)
  })

  app.post('/api/commercial-ops/cost-entries', async (request, reply) => {
    const input = costEntrySchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'finance.cost.manage')
      return mutateCommercial(state, (domain) => {
        const inputFingerprint = fingerprint(input)
        const replay = idempotentResult(domain, input.idempotencyKey, 'commercial.cost_entry.create', inputFingerprint)
        if (replay) return domain.costEntries.find((entry) => entry.id === replay)!
        const replaced = input.replacesEntryId
          ? domain.costEntries.find((entry) => entry.id === input.replacesEntryId)
          : null
        if (input.replacesEntryId && (!replaced || replaced.status !== 'estimated')) {
          throw new Error('要替代的预估费用不存在或已不是预估状态')
        }
        if (replaced && domain.costEntries.some((entry) => entry.status === 'actual' && entry.replacesEntryId === replaced.id)) {
          throw new Error('这笔预估费用已经录入实际账单')
        }
        const template = input.sourceTemplateId
          ? domain.recurringCostTemplates.find((item) => item.id === input.sourceTemplateId)
          : null
        if (input.sourceTemplateId && !template) throw new Error('关联的周期费用不存在')
        if (input.sourceTemplateId && input.status !== 'actual') throw new Error('周期费用账期只需要录入实际账单')
        if (template && input.sourceOccurrenceDate) {
          const occurrenceRange = recurringOccurrenceRange(template, input.sourceOccurrenceDate)
          if (!occurrenceRange) throw new Error('所选日期不是这个周期费用的有效账期')
          if (input.recognitionMode !== template.recognitionMode
            || input.recognitionStartDate !== occurrenceRange.startDate
            || input.recognitionEndDate !== occurrenceRange.endDate) {
            throw new Error(`周期费用应归属 ${occurrenceRange.startDate} 至 ${occurrenceRange.endDate}`)
          }
        }
        if (input.sourceTemplateId && domain.costEntries.some((entry) => (
          entry.status === 'actual'
          && entry.sourceTemplateId === input.sourceTemplateId
          && entry.sourceOccurrenceDate === input.sourceOccurrenceDate
        ))) throw new Error('这个周期费用账期已经录入实际账单')
        const entry: OperatingCostEntry = {
          id: deterministicId('cost_entry', input.idempotencyKey),
          name: input.name,
          categoryId: input.categoryId,
          amount: input.amount,
          currency: 'CNY',
          status: input.status,
          recognitionMode: input.recognitionMode,
          recognitionStartDate: input.recognitionStartDate,
          recognitionEndDate: input.recognitionEndDate,
          counterparty: input.counterparty,
          reference: input.reference,
          note: input.note,
          replacesEntryId: input.replacesEntryId ?? null,
          sourceTemplateId: input.sourceTemplateId ?? null,
          sourceOccurrenceDate: input.sourceOccurrenceDate ?? null,
          createdAt: input.occurredAt,
          createdBy: actor.actorId,
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
          idempotencyKey: input.idempotencyKey,
        }
        domain.costEntries.push(entry)
        recordCommercialMutation(domain, {
          key: input.idempotencyKey,
          operation: 'commercial.cost_entry.create',
          inputFingerprint,
          resultId: entry.id,
          actorId: actor.actorId,
          action: input.status === 'actual' ? 'commercial.cost_entry.actual_recorded.v1' : 'commercial.cost_entry.estimated_recorded.v1',
          objectType: 'operating_cost_entry',
          reason: input.reason,
          occurredAt: input.occurredAt,
          details: {
            categoryId: entry.categoryId,
            amount: entry.amount,
            recognitionStartDate: entry.recognitionStartDate,
            recognitionEndDate: entry.recognitionEndDate,
            replacesEntryId: entry.replacesEntryId,
            sourceTemplateId: entry.sourceTemplateId,
            sourceOccurrenceDate: entry.sourceOccurrenceDate,
          },
        })
        return entry
      })
    })
    return reply.status(201).send(result)
  })

  app.post<{ Params: { entryId: string } }>('/api/commercial-ops/cost-entries/:entryId/void', async (request) => {
    const input = costVoidSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'finance.cost.manage')
      return mutateCommercial(state, (domain) => {
        const entry = domain.costEntries.find((candidate) => candidate.id === request.params.entryId)
        if (!entry) throw new Error('费用记录不存在')
        const inputFingerprint = fingerprint({ entryId: entry.id, ...input })
        const replay = idempotentResult(domain, input.idempotencyKey, 'commercial.cost_entry.void', inputFingerprint)
        if (replay) return entry
        if (entry.status === 'voided') throw new Error('费用记录已经作废')
        const previousStatus = entry.status
        entry.status = 'voided'
        entry.voidedAt = input.occurredAt
        entry.voidedBy = actor.actorId
        entry.voidReason = input.reason
        recordCommercialMutation(domain, {
          key: input.idempotencyKey,
          operation: 'commercial.cost_entry.void',
          inputFingerprint,
          resultId: entry.id,
          actorId: actor.actorId,
          action: 'commercial.cost_entry.voided.v1',
          objectType: 'operating_cost_entry',
          reason: input.reason,
          occurredAt: input.occurredAt,
          details: { previousStatus, amount: entry.amount, categoryId: entry.categoryId },
        })
        return entry
      })
    })
  })

  app.post('/api/commercial-ops/cost-templates', async (request, reply) => {
    const input = recurringCostTemplateSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'finance.cost.manage')
      return mutateCommercial(state, (domain) => {
        const inputFingerprint = fingerprint(input)
        const replay = idempotentResult(domain, input.idempotencyKey, 'commercial.cost_template.upsert', inputFingerprint)
        if (replay) return domain.recurringCostTemplates.find((template) => template.id === replay)!
        const existing = input.templateId
          ? domain.recurringCostTemplates.find((template) => template.id === input.templateId)
          : null
        if (input.templateId && !existing) throw new Error('周期费用模板不存在')
        const template: RecurringCostTemplate = existing ?? {
          id: deterministicId('cost_template', input.idempotencyKey),
          name: input.name,
          categoryId: input.categoryId,
          amount: input.amount,
          currency: 'CNY',
          frequency: input.frequency,
          recognitionMode: input.recognitionMode,
          startDate: input.startDate,
          endDate: input.endDate,
          counterparty: input.counterparty,
          note: input.note,
          enabled: input.enabled,
          revision: 0,
          createdAt: input.occurredAt,
          createdBy: actor.actorId,
          updatedAt: input.occurredAt,
          updatedBy: actor.actorId,
        }
        Object.assign(template, {
          name: input.name,
          categoryId: input.categoryId,
          amount: input.amount,
          frequency: input.frequency,
          recognitionMode: input.recognitionMode,
          startDate: input.startDate,
          endDate: input.endDate,
          counterparty: input.counterparty,
          note: input.note,
          enabled: input.enabled,
          revision: template.revision + 1,
          updatedAt: input.occurredAt,
          updatedBy: actor.actorId,
        })
        if (!existing) domain.recurringCostTemplates.push(template)
        recordCommercialMutation(domain, {
          key: input.idempotencyKey,
          operation: 'commercial.cost_template.upsert',
          inputFingerprint,
          resultId: template.id,
          actorId: actor.actorId,
          action: existing ? 'commercial.cost_template.updated.v1' : 'commercial.cost_template.created.v1',
          objectType: 'recurring_cost_template',
          reason: input.reason,
          occurredAt: input.occurredAt,
          details: {
            revision: template.revision,
            categoryId: template.categoryId,
            amount: template.amount,
            frequency: template.frequency,
          },
        })
        return template
      })
    })
    return reply.status(input.templateId ? 200 : 201).send(result)
  })

  app.post<{ Params: { templateId: string } }>('/api/commercial-ops/cost-templates/:templateId/status', async (request) => {
    const input = recurringCostStatusSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'finance.cost.manage')
      return mutateCommercial(state, (domain) => {
        const template = domain.recurringCostTemplates.find((candidate) => candidate.id === request.params.templateId)
        if (!template) throw new Error('周期费用模板不存在')
        const inputFingerprint = fingerprint({ templateId: template.id, ...input })
        const replay = idempotentResult(domain, input.idempotencyKey, 'commercial.cost_template.status', inputFingerprint)
        if (replay) return template
        if (template.enabled === input.enabled) throw new Error(input.enabled ? '周期费用已经启用' : '周期费用已经停用')
        template.enabled = input.enabled
        template.revision += 1
        template.updatedAt = input.occurredAt
        template.updatedBy = actor.actorId
        recordCommercialMutation(domain, {
          key: input.idempotencyKey,
          operation: 'commercial.cost_template.status',
          inputFingerprint,
          resultId: template.id,
          actorId: actor.actorId,
          action: input.enabled ? 'commercial.cost_template.enabled.v1' : 'commercial.cost_template.disabled.v1',
          objectType: 'recurring_cost_template',
          reason: input.reason,
          occurredAt: input.occurredAt,
          details: { enabled: template.enabled, revision: template.revision },
        })
        return template
      })
    })
  })

  app.post('/api/commercial-ops/vouchers/redeem', async (request, reply) => {
    const input = voucherSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'payment.intent.create')
      return mutateCommercial(state, (domain) => {
        const codeHash = createHash('sha256').update(input.voucherCode).digest('base64url')
        const used = domain.voucherRedemptions.find((item) => item.voucherCodeHash === codeHash && item.status === 'redeemed')
        if (used) throw new Error(`这张团购券已于${new Date(used.redeemedAt).toLocaleString('zh-CN', { timeZone: state.store.timezone })}核销`)
        if (input.tableSessionId && !state.songState.tableSessions.some((session) => session.id === input.tableSessionId)) throw new Error('关联桌次不存在')
        if (input.orderId && !state.orderDomain.orders.some((order) => order.id === input.orderId)) throw new Error('关联订单不存在')
        const inputFingerprint = fingerprint({ ...input, voucherCode: codeHash })
        const replay = idempotentResult(domain, input.idempotencyKey, 'commercial.voucher.redeem', inputFingerprint)
        if (replay) return domain.voucherRedemptions.find((item) => item.id === replay)!
        const redemption = {
          id: deterministicId('voucher_redemption', input.idempotencyKey),
          platform: input.platform,
          campaignName: input.campaignName,
          voucherCodeMasked: maskedVoucher(input.voucherCode),
          voucherCodeHash: codeHash,
          faceValueAmount: input.faceValueAmount,
          settlementAmount: input.settlementAmount,
          tableSessionId: input.tableSessionId ?? null,
          orderId: input.orderId ?? null,
          status: 'redeemed' as const,
          redeemedAt: input.occurredAt,
          redeemedBy: actor.actorId,
          voidedAt: null,
          voidedBy: null,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        }
        domain.voucherRedemptions.push(redemption)
        recordCommercialMutation(domain, {
          key: input.idempotencyKey, operation: 'commercial.voucher.redeem', inputFingerprint,
          resultId: redemption.id, actorId: actor.actorId, action: 'commercial.voucher.redeemed.v1',
          objectType: 'group_voucher', reason: input.reason, occurredAt: input.occurredAt,
          details: { platform: input.platform, voucherCodeMasked: redemption.voucherCodeMasked, settlementAmount: input.settlementAmount },
        })
        return redemption
      })
    })
    return reply.status(201).send(result)
  })

  app.put<{ Params: { memberId: string } }>('/api/commercial-ops/members/:memberId/tags', async (request) => {
    const input = memberTagsSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'benefit.manage')
      const member = state.members.find((candidate) => candidate.id === request.params.memberId)
      if (!member) throw new Error('会员不存在')
      return mutateCommercial(state, (domain) => {
        const normalizedTags = [...new Set(input.tags.map((tag) => tag.trim()))]
        const inputFingerprint = fingerprint({ memberId: member.id, tags: normalizedTags, reason: input.reason })
        const replay = idempotentResult(domain, input.idempotencyKey, 'commercial.member_tags.update', inputFingerprint)
        if (replay) return member
        member.tags = normalizedTags
        recordCommercialMutation(domain, {
          key: input.idempotencyKey, operation: 'commercial.member_tags.update', inputFingerprint,
          resultId: member.id, actorId: actor.actorId, action: 'commercial.member_tags.updated.v1',
          objectType: 'member', reason: input.reason, occurredAt: input.occurredAt,
          details: { tags: normalizedTags },
        })
        return member
      })
    })
  })

  app.post<{ Params: { jobId: string } }>('/api/commercial-ops/print-jobs/:jobId/result', async (request) => {
    const input = printDecisionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireAnyPermission(request, state, ['kds.prepare', 'config.manage'])
      return mutateCommercial(state, (domain) => {
        const job = domain.printJobs.find((candidate) => candidate.id === request.params.jobId)
        if (!job) throw new Error('打印任务不存在')
        const inputFingerprint = fingerprint({ jobId: job.id, ...input })
        const replay = idempotentResult(domain, input.idempotencyKey, 'commercial.print_job.result', inputFingerprint)
        if (replay) return job
        const previousStatus = job.status
        if (previousStatus === 'printed') throw new Error('打印任务已经完成，无需重复操作')
        if (input.status === previousStatus) throw new Error(input.status === 'queued' ? '打印任务已经在队列中' : '打印任务状态没有变化')
        if (input.status === 'queued' && previousStatus !== 'failed') throw new Error('只有打印失败的任务可以重新加入队列')
        if (input.status === 'failed' && previousStatus !== 'queued') throw new Error('只有待打印任务可以登记故障')
        job.status = input.status
        if (input.status !== 'queued') job.attempts += 1
        job.updatedAt = input.occurredAt
        job.lastError = input.status === 'failed' ? input.error || '打印桥接端未返回原因' : null
        recordCommercialMutation(domain, {
          key: input.idempotencyKey, operation: 'commercial.print_job.result', inputFingerprint,
          resultId: job.id, actorId: actor.actorId, action: `commercial.print_job.${input.status}.v1`,
          objectType: 'print_job', reason: input.error || '打印桥接端回执', occurredAt: input.occurredAt,
          details: { previousStatus, status: job.status, attempts: job.attempts },
        })
        return job
      })
    })
  })
}
