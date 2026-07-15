import type {
  BootstrapResponse,
  Area,
  AreaWriteInput,
  AwaitingOrderIntent,
  ConfigDraftInput,
  CreateTaskInput,
  Employee,
  EmployeeWriteInput,
  MenuProduct,
  ProductWriteInput,
  ServiceTask,
  ShiftAssignment,
  ShiftWriteInput,
  StoreConfig,
  Table,
  TableCombinationInput,
  TableCombinationRecord,
  TableOperationsConfig,
  TableOperationsConfigInput,
  TableSessionSummary,
  TableTransferRecord,
  TransferTableSessionInput,
  TableWriteInput,
  TaskActionInput,
  SalesAttributionInput,
  SalesAttributionRecord,
  WalkInOpenInput,
} from './shared/contracts'
import type { Reservation } from './shared/reservation-contracts'
import type {
  AssistedPaymentLink,
  AssistedPaymentLinkInput,
  CartOrderInput,
  KdsActionInput,
  KdsExceptionDecisionInput,
  KdsExceptionReportInput,
  QuickOrderInput,
} from './shared/commerce-api'
import type { AuthorityWriteInput } from './shared/commerce-api'
import type { KdsExceptionEvent, KdsTask, Order } from './shared/order-contracts'
import type { OrderAuthorizationAuthority } from './shared/order-contracts'
import type { PaymentIntent, PhysicalPosReport, Refund } from './shared/payment-contracts'
import type {
  BenefitCampaign,
  BenefitCampaignInput,
  BenefitDecisionInput,
  BenefitGrantInput,
  BenefitGrantRequest,
  BenefitGrantPolicy,
  BenefitPolicyWriteInput,
  BenefitTemplate,
  BenefitTemplateWriteInput,
  CustomerNotification,
} from './shared/benefit-contracts'
import type {
  BenefitRedemption,
  BenefitRedemptionCancelInput,
  BenefitRedemptionConfirmInput,
  BenefitRedemptionLockInput,
} from './shared/benefit-redemption-contracts'
import type { PilotLoginResponse } from './shared/auth-contracts'
import type { ConfigVersionRecord } from './shared/config-versioning-contracts'
import type { SongRequest } from './shared/song-contracts'
import type {
  GuestSessionResponse,
  GuestCartOrderInput,
  GuestCheckoutInput,
  GuestCheckoutResponse,
  GuestTaskCreateInput,
  GuestTaskFeedbackInput,
  GuestTaskView,
} from './shared/guest-contracts'
import {
  isHighRiskOfflineWrite,
  getOfflineStatus,
  queueTaskAction,
  reportNetworkAvailable,
  reportNetworkUnavailable,
  type QueuedTaskAction,
} from './offline'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export class OfflineWriteBlockedError extends Error {
  constructor() {
    super('当前处于离线状态，此操作涉及支付、退款或运营配置，已禁止提交')
    this.name = 'OfflineWriteBlockedError'
  }
}

export function getPilotEmployees(accessCode: string) {
  return request<PilotLoginResponse>('/api/auth/pilot-login', {
    method: 'POST',
    body: JSON.stringify({ accessCode }),
  })
}

export function createPilotSession(accessCode: string, actorId: string, employeePin: string) {
  return request<PilotLoginResponse>('/api/auth/pilot-login', {
    method: 'POST',
    body: JSON.stringify({ accessCode, actorId, employeePin }),
  })
}

export function getCurrentActorId() {
  if (typeof window === 'undefined') return ''
  const sessionToken = window.localStorage.getItem('mbox.auth.token')?.trim()
  if (sessionToken) return actorIdFromSessionToken(sessionToken)
  const selectedActorId = window.localStorage.getItem('mbox.actor.id')?.trim()
  if (selectedActorId) return selectedActorId
  if (!import.meta.env.DEV) return ''
  return String(import.meta.env.VITE_MBOX_LOCAL_ACTOR_ID ?? '').trim()
}

function actorIdFromSessionToken(token: string) {
  try {
    const payload = token.split('.')[0]
    if (!payload) return ''
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const claims = JSON.parse(window.atob(padded)) as { actorId?: unknown }
    return typeof claims.actorId === 'string' ? claims.actorId.trim() : ''
  } catch {
    return ''
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  const highRiskWrite = isHighRiskOfflineWrite(path, method)
  if (highRiskWrite && !browserIsOnline()) throw new OfflineWriteBlockedError()

  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('Content-Type', 'application/json')
  const sessionToken = window.localStorage.getItem('mbox.auth.token')
  if (sessionToken) {
    headers.set('Authorization', `Bearer ${sessionToken}`)
  } else {
    const actorId = getCurrentActorId()
    if (actorId) headers.set('x-mbox-actor-id', actorId)
    headers.set('x-mbox-store-id', 'mbox-lujiazui')
  }
  let response: Response
  try {
    response = await fetch(path, { ...init, headers })
  } catch (error) {
    reportNetworkUnavailable()
    if (highRiskWrite) throw new OfflineWriteBlockedError()
    throw error
  }
  reportNetworkAvailable()

  let body: T & { message?: string }
  try {
    body = (await response.json()) as T & { message?: string }
  } catch {
    throw new ApiError('系统返回了无法识别的响应', response.status)
  }
  if (!response.ok) throw new ApiError(body.message ?? '系统请求失败', response.status)
  return body
}

async function guestRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(path, { ...init, headers })
  } catch (error) {
    reportNetworkUnavailable()
    throw error
  }
  reportNetworkAvailable()

  let body: T & { message?: string }
  try {
    body = (await response.json()) as T & { message?: string }
  } catch {
    throw new ApiError('系统返回了无法识别的响应', response.status)
  }
  if (!response.ok) throw new ApiError(body.message ?? '系统请求失败', response.status)
  return body
}

export function getGuestSession(tableToken: string, localTableCode = '') {
  const query = tableToken
    ? `token=${encodeURIComponent(tableToken)}`
    : `table=${encodeURIComponent(localTableCode)}`
  return guestRequest<GuestSessionResponse>(`/api/guest/session?${query}`)
}

export function createGuestTask(input: GuestTaskCreateInput) {
  return guestRequest<GuestTaskView>('/api/guest/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function submitGuestTaskFeedback(taskId: string, input: GuestTaskFeedbackInput) {
  return guestRequest<GuestTaskView>(`/api/guest/tasks/${encodeURIComponent(taskId)}/feedback`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function createGuestOrder(input: GuestCartOrderInput) {
  return guestRequest<Order>('/api/guest/orders', { method: 'POST', body: JSON.stringify(input) })
}

export function checkoutGuestOrder(input: GuestCheckoutInput) {
  return guestRequest<GuestCheckoutResponse>('/api/guest/checkout', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getBootstrap() {
  return request<BootstrapResponse>('/api/bootstrap')
}

export function createTask(input: CreateTaskInput) {
  return request<ServiceTask>('/api/tasks', { method: 'POST', body: JSON.stringify(input) })
}

export async function actOnTask(
  taskId: string,
  input: Omit<TaskActionInput, 'idempotencyKey'> & { idempotencyKey?: string },
): Promise<ServiceTask | null> {
  const actionInput: TaskActionInput = {
    ...input,
    idempotencyKey: input.idempotencyKey ?? `task-action-${crypto.randomUUID()}`,
  }

  if (!browserIsOnline()) {
    await queueTaskAction(taskId, actionInput)
    return null
  }

  try {
    return await request<ServiceTask>(`/api/tasks/${taskId}/actions`, {
      method: 'POST',
      body: JSON.stringify(actionInput),
    })
  } catch (error) {
    if (!isNetworkFailure(error)) throw error
    await queueTaskAction(taskId, actionInput)
    return null
  }
}

export function replayQueuedTaskAction(item: QueuedTaskAction) {
  return request<ServiceTask>(`/api/tasks/${item.taskId}/actions`, {
    method: 'POST',
    body: JSON.stringify(item.input),
  })
}

export function startAwaitingOrder(tableId: string, actorId: string) {
  return request<AwaitingOrderIntent>(`/api/tables/${tableId}/awaiting-order/start`, {
    method: 'POST',
    body: JSON.stringify({ actorId, idempotencyKey: `awaiting-order-${crypto.randomUUID()}`, reason: '' }),
  })
}

export function stopAwaitingOrder(tableId: string, actorId: string, reason: string) {
  return request<AwaitingOrderIntent>(`/api/tables/${tableId}/awaiting-order/stop`, {
    method: 'POST',
    body: JSON.stringify({ actorId, idempotencyKey: `stop-awaiting-order-${crypto.randomUUID()}`, reason }),
  })
}

export function closeTableSession(tableId: string, reason: string, minimumSpendWaiverReason?: string) {
  return request<Table>(`/api/tables/${encodeURIComponent(tableId)}/close`, {
    method: 'POST',
    body: JSON.stringify({
      reason,
      minimumSpendWaiver: minimumSpendWaiverReason ? { reason: minimumSpendWaiverReason } : undefined,
      idempotencyKey: `table-close-${crypto.randomUUID()}`,
    }),
  })
}

export function transferTableSession(tableId: string, input: Omit<TransferTableSessionInput, 'idempotencyKey'>) {
  return request<TableTransferRecord>(`/api/tables/${encodeURIComponent(tableId)}/transfer`, {
    method: 'POST',
    body: JSON.stringify({ ...input, idempotencyKey: `table-transfer-${crypto.randomUUID()}` }),
  })
}

export function updateTableOperationsConfig(input: Omit<TableOperationsConfigInput, 'idempotencyKey'>) {
  return request<TableOperationsConfig>('/api/table-operations/config', {
    method: 'PUT',
    body: JSON.stringify({ ...input, idempotencyKey: `table-ops-config-${crypto.randomUUID()}` }),
  })
}

export function openWalkInTable(tableId: string, input: Omit<WalkInOpenInput, 'idempotencyKey'>) {
  return request<{ table: Table; reservation: Reservation; summary: TableSessionSummary }>(
    `/api/tables/${encodeURIComponent(tableId)}/walk-in-open`,
    {
      method: 'POST',
      body: JSON.stringify({ ...input, idempotencyKey: `walk-in-open-${crypto.randomUUID()}` }),
    },
  )
}

export function getTableSessionSummary(tableId: string) {
  return request<TableSessionSummary>(`/api/tables/${encodeURIComponent(tableId)}/session-summary`)
}

export function assignTableSessionSales(sessionId: string, input: Omit<SalesAttributionInput, 'idempotencyKey'>) {
  return request<SalesAttributionRecord>(`/api/table-sessions/${encodeURIComponent(sessionId)}/sales-attribution`, {
    method: 'POST',
    body: JSON.stringify({ ...input, idempotencyKey: `table-sales-${crypto.randomUUID()}` }),
  })
}

type TableCombinationClientInput =
  | Omit<Extract<TableCombinationInput, { action: 'merge' | 'add_table' }>, 'idempotencyKey'>
  | Omit<Extract<TableCombinationInput, { action: 'split_back' }>, 'idempotencyKey'>

export function operateTableCombination(tableId: string, input: TableCombinationClientInput) {
  return request<TableCombinationRecord>(`/api/tables/${encodeURIComponent(tableId)}/combinations`, {
    method: 'POST',
    body: JSON.stringify({ ...input, idempotencyKey: `table-combination-${crypto.randomUUID()}` }),
  })
}

export function grantMemberBenefit(input: BenefitGrantInput) {
  return request<BenefitGrantRequest>('/api/benefits/grants', { method: 'POST', body: JSON.stringify(input) })
}

export function decideMemberBenefit(requestId: string, input: BenefitDecisionInput) {
  return request<BenefitGrantRequest>(`/api/benefits/grants/${requestId}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function launchMemberCampaign(input: BenefitCampaignInput) {
  return request<BenefitCampaign>('/api/benefits/campaigns', { method: 'POST', body: JSON.stringify(input) })
}

export interface BenefitCampaignPreview {
  eligibleCount: number
  issuableCount: number
  skippedCount: number
  reachableCount: number
  estimatedCostAmount: number
  withinDailyBudget: boolean
}

export function previewMemberCampaign(input: BenefitCampaignInput) {
  return request<BenefitCampaignPreview>('/api/benefits/campaigns/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateBenefitTemplate(templateId: string, input: BenefitTemplateWriteInput) {
  return request<BenefitTemplate>(`/api/benefits/templates/${templateId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function updateBenefitPolicy(policyId: string, input: BenefitPolicyWriteInput) {
  return request<BenefitGrantPolicy>(`/api/benefits/policies/${policyId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function retryCustomerNotification(notificationId: string) {
  return request<CustomerNotification>(`/api/notifications/${notificationId}/retry`, { method: 'POST' })
}

export interface SubmitSongRequestInput {
  performanceSessionId: string
  appearanceId: string
  tableSessionId: string
  singerId: string
  songId: string
  requestedBy: string
  customerNote: string
}

export function submitPaidSongRequest(input: SubmitSongRequestInput) {
  return request<SongRequest>('/api/songs/requests', {
    method: 'POST',
    body: JSON.stringify({ ...input, idempotencyKey: `song-submit-${crypto.randomUUID()}` }),
  })
}

export function reportSongPayment(requestId: string, paymentReference: string) {
  return request<SongRequest>(`/api/songs/requests/${requestId}/payment`, {
    method: 'POST',
    body: JSON.stringify({ paymentReference, idempotencyKey: `song-payment-${crypto.randomUUID()}` }),
  })
}

export function actOnSongRequest(
  requestId: string,
  action: 'accept' | 'start' | 'complete' | 'reject' | 'cancel' | 'refund',
  reason = '',
  refundReference = '',
) {
  return request<SongRequest>(`/api/songs/requests/${requestId}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action, reason, refundReference, idempotencyKey: `song-${action}-${crypto.randomUUID()}` }),
  })
}

export function lockMemberBenefit(input: BenefitRedemptionLockInput) {
  return request<BenefitRedemption>('/api/benefits/redemptions/locks', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function confirmMemberBenefitRedemption(redemptionId: string, input: BenefitRedemptionConfirmInput) {
  return request<BenefitRedemption>(`/api/benefits/redemptions/${redemptionId}/confirm`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function cancelMemberBenefitRedemption(redemptionId: string, input: BenefitRedemptionCancelInput) {
  return request<BenefitRedemption>(`/api/benefits/redemptions/${redemptionId}/cancel`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function saveConfigDraft(input: ConfigDraftInput) {
  return request<StoreConfig>('/api/config/draft', { method: 'PUT', body: JSON.stringify(input) })
}

export function publishConfig(reason = '运营配置发布') {
  return request<StoreConfig>('/api/config/publish', {
    method: 'POST',
    body: JSON.stringify({ reason, idempotencyKey: `config-publish-${crypto.randomUUID()}` }),
  })
}

export function getConfigVersions() {
  return request<ConfigVersionRecord[]>('/api/config/versions')
}

export function rollbackConfig(version: number, reason: string) {
  return request<StoreConfig>(`/api/config/versions/${version}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ reason, idempotencyKey: `config-rollback-${crypto.randomUUID()}` }),
  })
}

export function resetDemo() {
  return request<BootstrapResponse>('/api/dev/reset', { method: 'POST' })
}

export function createEmployee(input: EmployeeWriteInput) {
  return request<Employee>('/api/master-data/employees', { method: 'POST', body: JSON.stringify(input) })
}

export function updateEmployee(employeeId: string, input: EmployeeWriteInput) {
  return request<Employee>(`/api/master-data/employees/${employeeId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function updateTable(tableId: string, input: TableWriteInput) {
  return request<Table>(`/api/master-data/tables/${tableId}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function createShift(input: ShiftWriteInput) {
  return request<ShiftAssignment>('/api/master-data/shifts', { method: 'POST', body: JSON.stringify(input) })
}

export function updateShift(shiftId: string, input: ShiftWriteInput) {
  return request<ShiftAssignment>(`/api/master-data/shifts/${shiftId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function updateArea(areaId: string, input: AreaWriteInput) {
  return request<Area>(`/api/master-data/areas/${areaId}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function createProduct(input: ProductWriteInput) {
  return request<MenuProduct>('/api/master-data/products', { method: 'POST', body: JSON.stringify(input) })
}

export function updateProduct(productId: string, input: ProductWriteInput) {
  return request<MenuProduct>(`/api/master-data/products/${productId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function createCommerceAuthority(input: AuthorityWriteInput) {
  return request<OrderAuthorizationAuthority>('/api/master-data/commerce-authorities', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateCommerceAuthority(authorityId: string, input: AuthorityWriteInput) {
  return request<OrderAuthorizationAuthority>(`/api/master-data/commerce-authorities/${authorityId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function createQuickOrder(input: QuickOrderInput) {
  return request<Order>('/api/commerce/quick-orders', { method: 'POST', body: JSON.stringify(input) })
}

export function createCartOrder(input: CartOrderInput) {
  return request<Order>('/api/commerce/orders', { method: 'POST', body: JSON.stringify(input) })
}

export function createAssistedPaymentLink(orderId: string, input: AssistedPaymentLinkInput) {
  return request<AssistedPaymentLink>(`/api/commerce/orders/${encodeURIComponent(orderId)}/payment-link`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function actOnKdsTask(taskId: string, input: KdsActionInput) {
  return request<KdsTask>(`/api/commerce/kds/${taskId}/actions`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function reportKdsException(taskId: string, input: KdsExceptionReportInput) {
  return request<KdsExceptionEvent>(`/api/commerce/kds/${taskId}/exceptions`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function decideKdsException(exceptionId: string, input: KdsExceptionDecisionInput) {
  return request<KdsExceptionEvent>(`/api/commerce/kds/exceptions/${exceptionId}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

export function createTablePaymentIntent(tableSessionId: string, channel: 'wechat_mock' | 'physical_pos') {
  return request<PaymentIntent>('/api/payments/table-intents', {
    method: 'POST',
    body: JSON.stringify({
      tableSessionId,
      channel,
      deviceId: 'cashier-web',
      idempotencyKey: idempotencyKey('payment-intent'),
    }),
  })
}

export function simulatePaymentSuccess(paymentIntentId: string) {
  return request<PaymentIntent>(`/api/payments/${paymentIntentId}/dev-simulate-success`, {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: idempotencyKey('payment-simulate') }),
  })
}

export function reportPhysicalPos(
  paymentIntentId: string,
  terminalId: string,
  terminalTransactionId: string,
  paymentMethod: string,
  receiptReference: string,
) {
  return request<PhysicalPosReport>(`/api/payments/${paymentIntentId}/physical-pos-reports`, {
    method: 'POST',
    body: JSON.stringify({
      terminalId,
      terminalTransactionId,
      paymentMethod,
      receiptReference,
      deviceId: 'cashier-web',
      idempotencyKey: idempotencyKey('pos-report'),
    }),
  })
}

export function requestItemRefund(
  paymentIntentId: string,
  orderId: string,
  orderItemId: string,
  quantity: number,
  reason: string,
) {
  return request<Refund>(`/api/payments/${paymentIntentId}/refunds`, {
    method: 'POST',
    body: JSON.stringify({
      orderId,
      orderItemId,
      quantity,
      reason,
      idempotencyKey: idempotencyKey('refund-request'),
    }),
  })
}

export function approveAndCompleteRefund(refundId: string) {
  return request<Refund>(`/api/payments/refunds/${refundId}/dev-approve-complete`, {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: idempotencyKey('refund-complete'),
    }),
  })
}

export function completePhysicalPosRefund(
  refundId: string,
  terminalRefundTransactionId: string,
  reason: string,
) {
  return request<Refund>(`/api/payments/refunds/${refundId}/physical-pos-complete`, {
    method: 'POST',
    body: JSON.stringify({
      terminalRefundTransactionId,
      reason,
      idempotencyKey: idempotencyKey('physical-pos-refund'),
    }),
  })
}

function browserIsOnline() {
  return typeof navigator === 'undefined' || getOfflineStatus().online
}

function isNetworkFailure(error: unknown) {
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'NetworkError')
}
