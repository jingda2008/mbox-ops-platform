import { ApiError, OfflineWriteBlockedError, getBootstrap } from './api'
import {
  getOfflineStatus,
  reportNetworkAvailable,
  reportNetworkUnavailable,
} from './offline'
import type { BootstrapResponse } from './shared/contracts'
import type {
  BottleOwner,
  BottleStorageBatch,
  BottleStorageEvent,
  InventoryApprovalAction,
  InventoryApprovalRequest,
  InventoryDomainState,
  InventoryIngredientSku,
  InventoryMovement,
  InventoryOperationPolicy,
  InventoryRecipeLine,
  InventoryRecipeVersion,
  StockCount,
} from './shared/inventory-contracts'

export interface InventoryWorkspace {
  inventory: InventoryDomainState
  context: BootstrapResponse
}

export interface InventoryReceiptInput {
  productId: string
  unitCode: string
  quantity: number
  reason: string
}

export interface StockCountInput {
  productId: string
  unitCode: string
  countedQuantity: number
  approvalId?: string
}

export interface StockCountDecisionInput {
  decision: 'confirm' | 'reject'
  approvalId: string
  reason: string
}

export interface BottleDepositInput {
  productId: string
  skuSnapshot: string
  productNameSnapshot: string
  owner: BottleOwner
  capacityQuantity: number
  unitCode: string
  expiresAt: string
  tableSessionId: string
  orderId: string
  orderItemId: string
  reason: string
}

export interface BottleUseInput {
  quantity: number
  tableSessionId: string
  orderId: string
  orderItemId?: string
  reason: string
}

export interface BottleTransferInput {
  recipientOwner: BottleOwner
  tableSessionId: string
  orderId?: string
  reason: string
}

export interface BottleVoidInput {
  tableSessionId?: string
  orderId?: string
  reason: string
}

export interface IngredientSkuInput {
  ingredientSkuId?: string
  sku: string
  name: string
  baseUnitCode: string
  costAmountPerBaseUnit: number
  conversions: Array<{ unitCode: string; baseQuantity: number }>
  enabled: boolean
  reason: string
}

export interface RecipeVersionInput {
  productId: string
  lines: InventoryRecipeLine[]
  reason: string
}

export interface RemakeConsumptionInput {
  orderId: string
  orderItemId: string
  quantity: number
  reason: string
}

async function inventoryRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  if (method !== 'GET' && !getOfflineStatus().online) throw new OfflineWriteBlockedError()

  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('Content-Type', 'application/json')
  const sessionToken = window.localStorage.getItem('mbox.auth.token')
  if (sessionToken) {
    headers.set('Authorization', `Bearer ${sessionToken}`)
  } else {
    headers.set('x-mbox-actor-id', window.localStorage.getItem('mbox.actor.id') ?? 'emp-chen')
    headers.set('x-mbox-store-id', 'mbox-lujiazui')
  }

  let response: Response
  try {
    response = await fetch(path, { ...init, headers })
  } catch (error) {
    reportNetworkUnavailable()
    if (method !== 'GET') throw new OfflineWriteBlockedError()
    throw error
  }
  reportNetworkAvailable()

  let body: T & { message?: string }
  try {
    body = (await response.json()) as T & { message?: string }
  } catch {
    throw new ApiError('系统返回了无法识别的库存响应', response.status)
  }
  if (!response.ok) throw new ApiError(body.message ?? '库存操作失败', response.status)
  return body
}

function operationEnvelope<T extends object>(input: T, prefix: string) {
  return {
    ...input,
    occurredAt: new Date().toISOString(),
    idempotencyKey: `${prefix}-${crypto.randomUUID()}`,
  }
}

export async function getInventoryWorkspace(): Promise<InventoryWorkspace> {
  const [inventory, context] = await Promise.all([
    inventoryRequest<InventoryDomainState>('/api/inventory'),
    getBootstrap(),
  ])
  return { inventory, context }
}

export function receiveInventory(input: InventoryReceiptInput) {
  return inventoryRequest<InventoryMovement>('/api/inventory/receipts', {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, 'inventory-receipt')),
  })
}

export function upsertIngredientSku(input: IngredientSkuInput) {
  return inventoryRequest<InventoryIngredientSku>('/api/inventory/ingredients', {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, 'inventory-ingredient')),
  })
}

export function publishRecipeVersion(input: RecipeVersionInput) {
  return inventoryRequest<InventoryRecipeVersion>('/api/inventory/recipes', {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, 'inventory-recipe')),
  })
}

export function recordRemakeConsumption(input: RemakeConsumptionInput) {
  return inventoryRequest<InventoryMovement[]>('/api/inventory/remakes', {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, 'inventory-remake')),
  })
}

export function submitStockCount(input: StockCountInput) {
  return inventoryRequest<StockCount>('/api/inventory/stock-counts', {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, 'inventory-count')),
  })
}

export function decideStockCount(countId: string, input: StockCountDecisionInput) {
  return inventoryRequest<StockCount>(`/api/inventory/stock-counts/${encodeURIComponent(countId)}/decision`, {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, `inventory-count-${input.decision}`)),
  })
}

export function depositBottle(input: BottleDepositInput) {
  return inventoryRequest<BottleStorageBatch>('/api/inventory/bottles', {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, 'inventory-bottle-deposit')),
  })
}

export function useBottle(batchId: string, input: BottleUseInput) {
  return inventoryRequest<BottleStorageEvent>(`/api/inventory/bottles/${encodeURIComponent(batchId)}/use`, {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, 'inventory-bottle-use')),
  })
}

export function transferBottle(batchId: string, input: BottleTransferInput) {
  return inventoryRequest<InventoryApprovalRequest>(`/api/inventory/bottles/${encodeURIComponent(batchId)}/transfer`, {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, 'inventory-bottle-transfer')),
  })
}

export function voidBottle(batchId: string, input: BottleVoidInput) {
  return inventoryRequest<InventoryApprovalRequest>(`/api/inventory/bottles/${encodeURIComponent(batchId)}/void`, {
    method: 'POST',
    body: JSON.stringify(operationEnvelope(input, 'inventory-bottle-void')),
  })
}

export function decideApproval(
  approvalId: string,
  action: InventoryApprovalAction,
  decision: 'approve' | 'reject',
  reason: string,
) {
  const prefix = action === 'store_import' ? '/api/store-import/approvals' : '/api/inventory/approvals'
  return inventoryRequest<InventoryApprovalRequest | { approval: InventoryApprovalRequest }>(
    `${prefix}/${encodeURIComponent(approvalId)}/decision`,
    {
      method: 'POST',
      body: JSON.stringify(operationEnvelope({ decision, reason }, `inventory-approval-${decision}`)),
    },
  )
}

export function updateInventoryPolicy(policy: InventoryOperationPolicy, reason: string) {
  return inventoryRequest<InventoryOperationPolicy>('/api/inventory/policy', {
    method: 'PUT',
    body: JSON.stringify({
      policy,
      reason,
      idempotencyKey: `inventory-policy-${crypto.randomUUID()}`,
    }),
  })
}
