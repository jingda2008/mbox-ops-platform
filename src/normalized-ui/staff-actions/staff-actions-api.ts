import type {
  StaffFulfillmentData,
  StaffMemberBenefitTasks,
  StaffOperationsData,
  RecommendationStaffModificationReason,
  StaffRecommendationModification,
  StaffRecommendationSession,
  StaffReservation,
  StaffReservationIntakeEntry,
  StaffTableAssignment,
  StaffTableAssignmentOptions,
  StaffTableAssignmentType,
  StaffTableParticipant,
  StaffParticipantMovementPreview,
} from './types'
import type { OnlinePaymentAction } from '../../shared/online-payment-contracts'

export class StaffActionsApiError extends Error {
  readonly code: string
  readonly status: number | null
  readonly partialMutation: boolean
  readonly referenceId: string | null

  constructor(
    message: string,
    code: string,
    status: number | null,
    partialMutation = false,
    referenceId: string | null = null,
  ) {
    super(message)
    this.name = 'StaffActionsApiError'
    this.code = code
    this.status = status
    this.partialMutation = partialMutation
    this.referenceId = referenceId
  }
}

export interface AssistedOrderAccess {
  canCreateOrder: boolean
  canInitiatePayment: boolean
  paymentInitiationBlockReason: 'permission_required' | 'provider_not_configured' | 'online_payment_unavailable' | null
  canQueryOnlinePayment: boolean
  onlinePaymentProvider: 'postar' | 'simulation' | null
  manualCollection: {
    canRecordCash: boolean
    canRecordPos: boolean
    canRecordExternal: boolean
  }
  gift: null | {
    enabled: boolean
    maximumAmountMinor: number | null
    currency: string
  }
}

/** A deliberately small read model for a server to collect only on one owned table. */
export interface StaffTablePaymentOrder {
  id: string
  publicId: string
  currency: string
  paymentStatus: string
  outstandingAmountMinor: number
  hasOnlinePaymentInProgress: boolean
}

export interface AssistedOrderCatalogProduct {
  id: string
  code: string
  name: string
  categoryCode: string
  fulfillmentStation: 'bar' | 'kitchen' | 'cashier' | 'none'
  productKind: 'single' | 'bundle'
  bundleComponents: Array<{
    productId: string
    code: string
    name: string
    quantity: number
    sortOrder: number
    note: string | null
  }>
  productSnapshot: Record<string, unknown>
  allowedChannels: Array<'guest_qr' | 'staff_assisted' | 'cashier' | 'reservation' | 'integration'>
  guestVisible: boolean
  recommendationEnabled: boolean
  recommendationMinGuests: number
  recommendationMaxGuests: number
  recommendationPriority: number
  recommendationSceneTags: string[]
  recommendationIntentTags: string[]
  recommendationTasteTags: string[]
  recommendationDwellTags: string[]
  recommendationSingleWaveEligible: boolean
  recommendationExpectedPrepMinutes: number
  recommendationHoldMinutes: number
  recommendationUpgradeProductId: string | null
  menuSortOrder: number
  availableFrom: string | null
  availableUntil: string | null
  maxOrderQuantity: number
  costAmountMinor: number | null
  status: 'active' | 'sold_out' | 'inactive'
  isAvailable: boolean
  inventoryConfigurationComplete: boolean
  inventoryAvailable: boolean
  standardPrice: null | {
    amountMinor: string | null
    currency: string | null
  }
}

export interface AssistedOrderResult {
  id: string
  orderMode: 'paid' | 'gift'
  totalAmountMinor: number
  currency: string
  amounts: {
    grossAmount: number
    discountAmount: number
    giftAmount: number
    payableAmount: number
  }
  paymentNextStep: {
    status: 'required' | 'deferred'
    action: 'create_payment_intent' | 'settle_table_later'
    orderId: string
    amountMinor: number
    currency: string
    paymentStatus: string
  }
}

export interface ObservationCandidate {
  id: string
  mentionIndex: number
  rawMention: string
  orderItemId: string
  productId: string
  productName: string
  rank: number
  confidence: number
  matchKind: 'exact_name' | 'search_text' | 'order_context' | 'manual'
}

export interface ObservationDraft {
  publicId: string
  status: 'draft'
  inputKind: 'text' | 'voice_transcript'
  rawContent: string
  parseConfidence: number
  needsImmediateAction: boolean
  serviceTaskId: string | null
  candidates: ObservationCandidate[]
  clarificationRequired: boolean
  clarificationPrompt: string | null
}

export type ObservationExpressionKind = 'objective_fact' | 'customer_quote' | 'staff_judgement' | 'system_inference'
export type ObservationScopeKind = 'table' | 'seat' | 'customer' | 'product'
export type ObservationEventType = 'remaining' | 'consumed_little' | 'praise' | 'complaint' | 'too_sweet'
  | 'too_cold' | 'served_late' | 'presentation' | 'portion' | 'other'
export type ObservationDegree = 'little' | 'half' | 'most' | 'almost_untouched' | 'unknown'

export interface ObservationEvent {
  id: string
  eventGroupId: string
  revision: number
  expressionKind: ObservationExpressionKind
  scopeKind: ObservationScopeKind
  eventType: ObservationEventType
  degree: ObservationDegree | null
  reasonCode: string | null
  seatLabel: string | null
  customerId: string | null
  productId: string | null
  productName: string | null
  orderItemId: string | null
  selectedCandidateId: string | null
  confidence: number
  rawExcerpt: string | null
  needsImmediateAction: boolean
  serviceTaskId: string | null
  createdAt: string
}

export interface ObservationRevision {
  id: string
  reason: string
  correctedBy: string
  createdAt: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

export interface ObservationHistoryItem {
  publicId: string
  inputKind: 'text' | 'voice_transcript'
  rawContent: string | null
  parseConfidence: number
  needsImmediateAction: boolean
  serviceTaskId: string | null
  serviceTaskStatus: string | null
  recordedBy: string
  confirmedBy: string
  confirmedAt: string
  events: ObservationEvent[]
  revisions: ObservationRevision[]
}

export interface ObservationHistory {
  items: ObservationHistoryItem[]
  permissions: { canCorrect: boolean; canViewRaw: boolean }
}

export interface ObservationEventReplacement {
  expressionKind: ObservationExpressionKind
  scopeKind: ObservationScopeKind
  eventType: ObservationEventType
  degree: ObservationDegree | null
  reasonCode: string | null
  seatLabel: string | null
  customerId: string | null
  candidateId: string | null
  productId: string | null
  confidence: number
  rawExcerpt: string
}

export interface VoiceTranscriptionResult {
  transcript: string
  confidence: number | null
  alternatives: Array<{ transcript: string; confidence: number | null }>
}

export interface StaffActionsApiPort {
  loadOperations(signal?: AbortSignal): Promise<StaffOperationsData>
  loadFulfillment(signal?: AbortSignal): Promise<StaffFulfillmentData>
  loadMemberBenefitTasks?(tableSessionId?: string | null, signal?: AbortSignal): Promise<StaffMemberBenefitTasks>
  redeemAnnualGift?(input: Readonly<{
    reservationId: string; benefitId: string; customerId: string; tableSessionId: string
    selectedProductId: string; substitutionReason: string | null
  }>): Promise<void>
  cancelAnnualGift?(input: Readonly<{
    reservationId:string;customerId:string;tableSessionId:string;reason:string
  }>):Promise<void>
  redeemDailySnack?(claimCode: string): Promise<void>
  cancelDailySnack?(claimCode: string, reason: string): Promise<void>
  loadReservations(options?: StaffReservationListOptions, signal?: AbortSignal): Promise<StaffReservation[]>
  loadReservationIntake?(signal?: AbortSignal): Promise<StaffReservationIntakeEntry[]>
  overrideReservationPriority?(input: Readonly<{ kind: 'reservation' | 'waitlist'; publicId: string; mode: 'promote' | 'demote' | 'clear'; reason: string }>): Promise<void>
  loadTableAssignments(signal?: AbortSignal): Promise<StaffTableAssignment[]>
  loadTableAssignmentOptions(signal?: AbortSignal): Promise<StaffTableAssignmentOptions>
  assignTables(input: Readonly<{
    tableIds: string[]
    employeeId: string
    roleId: string
    assignmentType: StaffTableAssignmentType
    startsAt: string
    endsAt?: string | null
    reason: string
  }>): Promise<void>
  endTableAssignment(assignmentId: string, reason: string): Promise<void>
  openTable(input: Readonly<{
    tableId: string
    guestCount: number
    capacityOverrideReason?: string
  }>): Promise<void>
  closeTable(sessionId: string, sessionStatus?: 'open' | 'closing'): Promise<void>
  setGuestCartFreeze(sessionId: string, frozen: boolean, reason?: string): Promise<void>
  transferTable(input: Readonly<{
    tableSessionId: string
    targetTableId: string
    capacityOverrideReason?: string
  }>): Promise<void>
  loadTableParticipants(tableSessionId:string,signal?:AbortSignal):Promise<StaffTableParticipant[]>
  previewParticipantMovement(input:Readonly<{
    sourceTableSessionId:string
    movementKind:'participant_split'|'participant_merge'
    targetTableId:string
    targetTableSessionId:string|null
    movedGuestCount:number
    participantPublicIds:string[]
    capacityOverrideReason?:string
  }>):Promise<StaffParticipantMovementPreview>
  moveParticipants(input:Readonly<{
    sourceTableSessionId:string
    movementKind:'participant_split'|'participant_merge'
    targetTableId:string
    targetTableSessionId:string|null
    movedGuestCount:number
    participantPublicIds:string[]
    reason:string
    capacityOverrideReason?:string
  }>):Promise<void>
  completeServiceTask(taskId: string, note?: string): Promise<void>
  runKdsAction(taskId: string, action: 'complete' | 'deliver' | 'remake'): Promise<void>
  cancelKdsTask(taskId: string, reasonNote: string): Promise<void>
  actOnReservation(reservationId: string, action: 'confirm' | 'arrive' | 'complete'): Promise<void>
  loadAssistedOrderAccess(signal?: AbortSignal): Promise<AssistedOrderAccess>
  loadTablePaymentOrders?(tableSessionId: string, signal?: AbortSignal): Promise<StaffTablePaymentOrder[]>
  loadAssistedOrderCatalog(signal?: AbortSignal): Promise<AssistedOrderCatalogProduct[]>
  issueAssistedOrderContext(input: Readonly<{
    tableSessionId: string
  }>): Promise<string>
  submitAssistedOrder(input: Readonly<{
    tableSessionId: string
    assistedOrderContextToken: string
    orderMode: 'paid' | 'gift'
    items: ReadonlyArray<{ productId: string; quantity: number }>
    fulfillmentNote?: string
    giftReason?: string
    settlementMode: 'immediate_payment' | 'table_tab'
  }>): Promise<AssistedOrderResult>
  createOnlinePayment(input: Readonly<{
    orderId: string
    provider: 'postar' | 'simulation'
    method: 'native_qr' | 'auth_code'
    customerAuthCode?: string
  }>): Promise<OnlinePaymentAction>
  recordManualPayment(input: Readonly<{
    orderId: string
    provider: 'cash' | 'physical_pos' | 'external_manual'
    receiptReference: string
    terminalId?: string
    externalMethodCode?: 'bank_transfer' | 'mobile_wallet' | 'stored_value_voucher' | 'corporate_account' | 'other'
    collectionNote?: string
  }>): Promise<void>
  loadOnlinePaymentStatus(
    paymentId: string,
    signal?: AbortSignal,
  ): Promise<'pending' | 'succeeded' | 'failed' | 'closed'>
  queryOnlinePayment(paymentId: string): Promise<'pending' | 'succeeded' | 'failed' | 'closed'>
  transcribeObservationAudio(input: Readonly<{
    audioBase64: string
    mimeType: 'audio/webm' | 'audio/webm;codecs=opus' | 'audio/ogg' | 'audio/ogg;codecs=opus'
    phrases: string[]
  }>): Promise<VoiceTranscriptionResult>
  parseObservation(input: Readonly<{
    tableSessionId: string
    rawContent: string
    needsImmediateAction: boolean
    inputKind?: 'text' | 'voice_transcript'
  }>): Promise<ObservationDraft>
  confirmObservation(input: Readonly<{
    observationPublicId: string
    candidateId: string | null
    confidence: number
    rawExcerpt: string
    expressionKind: ObservationExpressionKind
    eventType: ObservationEventType
    degree: ObservationDegree | null
  }>): Promise<{ publicId: string; status: string; serviceTaskId: string | null }>
  loadRecentObservations(tableSessionId: string, signal?: AbortSignal): Promise<ObservationHistory>
  loadTableRecommendation(tableSessionId: string, signal?: AbortSignal): Promise<StaffRecommendationSession | null>
  modifyTableRecommendation(input: Readonly<{
    recommendationPublicId: string
    sourceProductId: string
    targetProductId: string
    reasonCode: RecommendationStaffModificationReason
  }>): Promise<StaffRecommendationModification>
  reviseObservation(input: Readonly<{
    observationPublicId: string
    eventId: string
    reason: string
    replacement: ObservationEventReplacement
  }>): Promise<ObservationEvent>
}

export interface StaffReservationListOptions {
  range?: 'current' | 'carryover' | 'history'
  from?: string
  to?: string
}

export interface StaffActionsApiOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  createIdempotencyKey?: () => string
}

export class StaffActionsApi implements StaffActionsApiPort {
  private readonly send: typeof fetch
  private readonly timeoutMs: number
  private readonly createIdempotencyKey: () => string

  constructor(options: Readonly<StaffActionsApiOptions> = {}) {
    this.send = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID())
  }

  loadOperations(signal?: AbortSignal): Promise<StaffOperationsData> {
    return this.getData('/api/operations', signal)
  }

  loadFulfillment(signal?: AbortSignal): Promise<StaffFulfillmentData> {
    return this.getData('/api/commerce/fulfillment', signal)
  }

  async loadMemberBenefitTasks(tableSessionId: string | null = null, signal?: AbortSignal): Promise<StaffMemberBenefitTasks> {
    const suffix = tableSessionId === null ? '' : `?tableSessionId=${encodeURIComponent(tableSessionId)}`
    const [annualGifts, dailySnacks] = await Promise.all([
      this.getData<StaffMemberBenefitTasks['annualGifts']>(`/api/staff/annual-benefit-reservations${suffix}`, signal),
      this.getData<StaffMemberBenefitTasks['dailySnacks']>(`/api/staff/annual-daily-snack-claims${suffix}`, signal),
    ])
    return { annualGifts, dailySnacks }
  }

  async redeemAnnualGift(input: Readonly<{
    reservationId: string; benefitId: string; customerId: string; tableSessionId: string
    selectedProductId: string; substitutionReason: string | null
  }>): Promise<void> {
    await this.command(`/api/benefit-reservations/${encodeURIComponent(input.reservationId)}/redeem`, {
      benefitId: input.benefitId, customerId: input.customerId, tableSessionId: input.tableSessionId,
      selectedProductId: input.selectedProductId, substitutionReason: input.substitutionReason,
    }, 'idempotency-key')
  }

  async cancelAnnualGift(input:Readonly<{
    reservationId:string;customerId:string;tableSessionId:string;reason:string
  }>):Promise<void> {
    await this.command(`/api/staff/annual-benefit-reservations/${encodeURIComponent(input.reservationId)}/cancel`,{
      customerId:input.customerId,tableSessionId:input.tableSessionId,reason:input.reason,
    },'idempotency-key')
  }

  async redeemDailySnack(claimCode: string): Promise<void> {
    await this.command(`/api/staff/annual-daily-snack-claims/${encodeURIComponent(claimCode)}/redeem`, {}, 'idempotency-key')
  }

  async cancelDailySnack(claimCode: string, reason: string): Promise<void> {
    await this.command(`/api/staff/annual-daily-snack-claims/${encodeURIComponent(claimCode)}/cancel`, { reason }, 'idempotency-key')
  }

  loadReservations(options: StaffReservationListOptions = {}, signal?: AbortSignal): Promise<StaffReservation[]> {
    const query = new URLSearchParams()
    if (options.range !== undefined && options.range !== 'current') query.set('range', options.range)
    if (options.from !== undefined) query.set('from', options.from)
    if (options.to !== undefined) query.set('to', options.to)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return this.getData(`/api/staff/reservations${suffix}`, signal)
  }

  loadReservationIntake(signal?: AbortSignal): Promise<StaffReservationIntakeEntry[]> {
    const window = shanghaiCalendarDay()
    return this.getData(`/api/staff/reservation-intake?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`, signal)
  }

  async overrideReservationPriority(input: Readonly<{ kind: 'reservation' | 'waitlist'; publicId: string; mode: 'promote' | 'demote' | 'clear'; reason: string }>): Promise<void> {
    await this.command(`/api/staff/reservation-intake/${input.kind}/${encodeURIComponent(input.publicId)}/priority-override`, {
      mode: input.mode, reason: input.reason,
    }, 'idempotency-key')
  }

  loadTableAssignments(signal?: AbortSignal): Promise<StaffTableAssignment[]> {
    return this.getData('/api/table-management/assignments', signal)
  }

  loadTableAssignmentOptions(signal?: AbortSignal): Promise<StaffTableAssignmentOptions> {
    return this.getData('/api/table-management/assignment-options', signal)
  }

  async assignTables(input: Readonly<{
    tableIds: string[]
    employeeId: string
    roleId: string
    assignmentType: StaffTableAssignmentType
    startsAt: string
    endsAt?: string | null
    reason: string
  }>): Promise<void> {
    await this.command('/api/table-management/assignments/batch', input, 'x-idempotency-key')
  }

  async endTableAssignment(assignmentId: string, reason: string): Promise<void> {
    await this.command(
      `/api/table-management/assignments/${encodeURIComponent(assignmentId)}/end`,
      { endsAt: new Date().toISOString(), reason },
      'x-idempotency-key',
    )
  }

  async openTable(input: Readonly<{
    tableId: string
    guestCount: number
    capacityOverrideReason?: string
  }>): Promise<void> {
    await this.command('/api/table-management/sessions/open', input, 'x-idempotency-key')
  }

  async closeTable(sessionId: string, sessionStatus: 'open' | 'closing' = 'open'): Promise<void> {
    const operationKey = `staff-close-${sessionId}`
    const beganClosing = sessionStatus === 'open'
    if (beganClosing) {
      await this.command(
        `/api/table-sessions/${encodeURIComponent(sessionId)}/begin-closing`,
        {},
        'idempotency-key',
        `${operationKey}-begin`,
      )
    }
    try {
      await this.command(
        `/api/table-sessions/${encodeURIComponent(sessionId)}/close`,
        {},
        'idempotency-key',
        `${operationKey}-complete`,
      )
    } catch (error) {
      if (!beganClosing) throw error
      const message = error instanceof Error ? error.message : '关台结果无法确认'
      throw new StaffActionsApiError(message, 'TABLE_CLOSE_PARTIAL', null, true)
    }
  }

  async setGuestCartFreeze(sessionId: string, frozen: boolean, reason?: string): Promise<void> {
    await this.command(
      `/api/table-sessions/${encodeURIComponent(sessionId)}/guest-cart-freeze`,
      { frozen, ...(frozen ? { reason: reason?.trim() || '服务人员核对本桌点单' } : {}) },
      'idempotency-key',
    )
  }

  async transferTable(input: Readonly<{
    tableSessionId: string
    targetTableId: string
    capacityOverrideReason?: string
  }>): Promise<void> {
    await this.command(
      `/api/table-management/sessions/${encodeURIComponent(input.tableSessionId)}/transfer`,
      { targetTableId: input.targetTableId, capacityOverrideReason: input.capacityOverrideReason },
      'x-idempotency-key',
    )
  }

  loadTableParticipants(tableSessionId:string,signal?:AbortSignal):Promise<StaffTableParticipant[]> {
    return this.getData(
      `/api/table-management/sessions/${encodeURIComponent(tableSessionId)}/participants`,signal,
    )
  }

  previewParticipantMovement(input:Readonly<{
    sourceTableSessionId:string
    movementKind:'participant_split'|'participant_merge'
    targetTableId:string
    targetTableSessionId:string|null
    movedGuestCount:number
    participantPublicIds:string[]
    capacityOverrideReason?:string
  }>):Promise<StaffParticipantMovementPreview> {
    return this.postData(
      `/api/table-management/sessions/${encodeURIComponent(input.sourceTableSessionId)}/participant-movements/preview`,
      input,'x-idempotency-key',
    )
  }

  async moveParticipants(input:Readonly<{
    sourceTableSessionId:string
    movementKind:'participant_split'|'participant_merge'
    targetTableId:string
    targetTableSessionId:string|null
    movedGuestCount:number
    participantPublicIds:string[]
    reason:string
    capacityOverrideReason?:string
  }>):Promise<void> {
    await this.command(
      `/api/table-management/sessions/${encodeURIComponent(input.sourceTableSessionId)}/participant-movements`,
      input,'x-idempotency-key',
    )
  }

  async completeServiceTask(taskId: string, note?: string): Promise<void> {
    await this.command(
      `/api/service-tasks/${encodeURIComponent(taskId)}/complete`,
      note === undefined ? {} : { note },
      'idempotency-key',
    )
  }

  async runKdsAction(taskId: string, action: 'complete' | 'deliver' | 'remake'): Promise<void> {
    if (action === 'remake') {
      await this.command(
        `/api/commerce/kds/${encodeURIComponent(taskId)}/remake`,
        { reasonCode: 'production_remake', reasonNote: '现场确认后重新制作' },
        'idempotency-key',
      )
      return
    }
    await this.command(`/api/commerce/kds/${encodeURIComponent(taskId)}/actions`, { action }, 'idempotency-key')
  }

  async cancelKdsTask(taskId: string, reasonNote: string): Promise<void> {
    await this.command(
      `/api/commerce/kds/${encodeURIComponent(taskId)}/manager-cancel`,
      { reasonCode: 'prior_business_day_cleanup', reasonNote },
      'idempotency-key',
    )
  }

  async actOnReservation(reservationId: string, action: 'confirm' | 'arrive' | 'complete'): Promise<void> {
    await this.command(
      `/api/staff/reservations/${encodeURIComponent(reservationId)}/${action}`,
      {},
      'idempotency-key',
      `staff-reservation-${action}-${reservationId}`,
    )
  }

  loadAssistedOrderAccess(signal?: AbortSignal): Promise<AssistedOrderAccess> {
    return this.getData('/api/commerce/assisted-order-access', signal)
  }

  loadTablePaymentOrders(tableSessionId: string, signal?: AbortSignal): Promise<StaffTablePaymentOrder[]> {
    return this.getData(`/api/commerce/table-sessions/${encodeURIComponent(tableSessionId)}/payment-orders`, signal)
  }

  loadAssistedOrderCatalog(signal?: AbortSignal): Promise<AssistedOrderCatalogProduct[]> {
    return this.getData('/api/catalog/products?status=active&limit=100', signal)
  }

  async issueAssistedOrderContext(input: Readonly<{ tableSessionId: string }>): Promise<string> {
    const response = await this.request('/api/commerce/assisted-order-contexts', {
      method: 'POST',
      headers: new Headers({ accept: 'application/json', 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    })
    const body = await readJson(response)
    if (!isObject(body) || !isObject(body.data) || typeof body.data.token !== 'string') {
      throw new StaffActionsApiError('协助点单授权无法识别，请重新进入桌台', 'INVALID_RESPONSE', response.status)
    }
    return body.data.token
  }

  async submitAssistedOrder(input: Readonly<{
    tableSessionId: string
    assistedOrderContextToken: string
    orderMode: 'paid' | 'gift'
    items: ReadonlyArray<{ productId: string; quantity: number }>
    fulfillmentNote?: string
    giftReason?: string
    settlementMode: 'immediate_payment' | 'table_tab'
  }>): Promise<AssistedOrderResult> {
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': `staff-order-${this.createIdempotencyKey()}`,
      'x-assisted-order-context': input.assistedOrderContextToken,
    })
    const response = await this.request('/api/commerce/orders', {
      method: 'POST', headers, body: JSON.stringify(input),
    })
    const body = await readJson(response)
    if (!isObject(body) || typeof body.id !== 'string') {
      throw new StaffActionsApiError('订单结果无法识别，请到订单列表核对', 'INVALID_RESPONSE', response.status)
    }
    return body as unknown as AssistedOrderResult
  }

  async createOnlinePayment(input: Readonly<{
    orderId: string
    provider: 'postar' | 'simulation'
    method: 'native_qr' | 'auth_code'
    customerAuthCode?: string
  }>): Promise<OnlinePaymentAction> {
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': `staff-payment-${this.createIdempotencyKey()}`,
    })
    const response = await this.request('/api/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        orderId: input.orderId,
        provider: input.provider,
        method: input.method,
        ...(input.customerAuthCode === undefined ? {} : { customerAuthCode: input.customerAuthCode }),
      }),
    })
    const body = await readJson(response)
    if (!isObject(body) || !isObject(body.data) || !isOnlinePaymentAction(body.data.providerAction)) {
      throw new StaffActionsApiError('支付结果无法识别，请到收银页面核对', 'INVALID_PAYMENT_RESPONSE', response.status)
    }
    return body.data.providerAction
  }

  async recordManualPayment(input: Readonly<{
    orderId: string
    provider: 'cash' | 'physical_pos' | 'external_manual'
    receiptReference: string
    terminalId?: string
    externalMethodCode?: 'bank_transfer' | 'mobile_wallet' | 'stored_value_voucher' | 'corporate_account' | 'other'
    collectionNote?: string
  }>): Promise<void> {
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': `staff-manual-payment-${this.createIdempotencyKey()}`,
    })
    await this.request('/api/payments/manual', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        orderId: input.orderId,
        provider: input.provider,
        method: input.provider === 'cash' ? 'cash' : input.provider === 'physical_pos' ? 'card' : 'manual',
        receiptReference: input.receiptReference.trim(),
        ...(input.terminalId?.trim() ? { terminalId: input.terminalId.trim() } : {}),
        ...(input.provider === 'external_manual' ? {
          externalMethodCode: input.externalMethodCode,
          collectionNote: input.collectionNote?.trim(),
        } : {}),
      }),
    })
  }

  async queryOnlinePayment(paymentId: string): Promise<'pending' | 'succeeded' | 'failed' | 'closed'> {
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': `staff-payment-query-${this.createIdempotencyKey()}`,
    })
    const response = await this.request(`/api/payments/${encodeURIComponent(paymentId)}/provider-query`, {
      method: 'POST', headers, body: '{}',
    })
    const body = await readJson(response)
    const status = isObject(body) && isObject(body.data) ? body.data.status : undefined
    if (status !== 'pending' && status !== 'succeeded' && status !== 'failed' && status !== 'closed') {
      throw new StaffActionsApiError('查单结果无法识别，请到收银页面核对', 'INVALID_PAYMENT_QUERY_RESPONSE', response.status)
    }
    return status
  }

  async loadOnlinePaymentStatus(
    paymentId: string,
    signal?: AbortSignal,
  ): Promise<'pending' | 'succeeded' | 'failed' | 'closed'> {
    const body = await this.getData<{ id: string; status: unknown }>(
      `/api/payments/${encodeURIComponent(paymentId)}/status`,
      signal,
    )
    if (body.status !== 'pending' && body.status !== 'succeeded'
      && body.status !== 'failed' && body.status !== 'closed') {
      throw new StaffActionsApiError('支付状态无法识别，请到收银页面核对', 'INVALID_PAYMENT_STATUS_RESPONSE', null)
    }
    return body.status
  }

  async parseObservation(input: Readonly<{
    tableSessionId: string
    rawContent: string
    needsImmediateAction: boolean
    inputKind?: 'text' | 'voice_transcript'
  }>): Promise<ObservationDraft> {
    const response = await this.request(
      `/api/staff/table-sessions/${encodeURIComponent(input.tableSessionId)}/observations/parse`,
      {
        method: 'POST',
        headers: new Headers({
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': `staff-observation-parse-${this.createIdempotencyKey()}`,
        }),
        body: JSON.stringify({
          inputKind: input.inputKind ?? 'text',
          rawContent: input.rawContent,
          needsImmediateAction: input.needsImmediateAction,
        }),
      },
    )
    const body = await readJson(response)
    if (!isObject(body) || !isObject(body.data) || typeof body.data.publicId !== 'string') {
      throw new StaffActionsApiError('桌台记录解析结果无法识别，请保留原话后重试', 'INVALID_OBSERVATION_RESPONSE', response.status)
    }
    return observationDraft(body.data, response.status)
  }

  async transcribeObservationAudio(input: Readonly<{
    audioBase64: string
    mimeType: 'audio/webm' | 'audio/webm;codecs=opus' | 'audio/ogg' | 'audio/ogg;codecs=opus'
    phrases: string[]
  }>): Promise<VoiceTranscriptionResult> {
    const response = await this.request('/api/voice/transcribe', {
      method: 'POST',
      headers: new Headers({ accept: 'application/json', 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    })
    const body = await readJson(response)
    if (!isObject(body) || typeof body.transcript !== 'string'
      || (body.confidence !== null && typeof body.confidence !== 'number')
      || (body.alternatives !== undefined && !Array.isArray(body.alternatives))) {
      throw new StaffActionsApiError('语音转写结果无法识别，可以直接输入文字', 'INVALID_VOICE_TRANSCRIPTION', response.status)
    }
    const alternatives = (body.alternatives ?? []).map((item) => {
      if (!isObject(item) || typeof item.transcript !== 'string'
        || (item.confidence !== null && typeof item.confidence !== 'number')) {
        throw new StaffActionsApiError('语音候选结果无法识别，可以直接输入文字', 'INVALID_VOICE_TRANSCRIPTION', response.status)
      }
      return { transcript: item.transcript, confidence: item.confidence as number | null }
    })
    return {
      transcript: body.transcript,
      confidence: body.confidence as number | null,
      alternatives,
    }
  }

  async confirmObservation(input: Readonly<{
    observationPublicId: string
    candidateId: string | null
    confidence: number
    rawExcerpt: string
    expressionKind: ObservationExpressionKind
    eventType: ObservationEventType
    degree: ObservationDegree | null
  }>): Promise<{ publicId: string; status: string; serviceTaskId: string | null }> {
    const response = await this.request(
      `/api/staff/observations/${encodeURIComponent(input.observationPublicId)}/confirm`,
      {
        method: 'POST',
        headers: new Headers({
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': `staff-observation-confirm-${this.createIdempotencyKey()}`,
        }),
        body: JSON.stringify({
          events: [{
            expressionKind: input.expressionKind,
            scopeKind: input.candidateId === null ? 'table' : 'product',
            eventType: input.eventType,
            degree: input.degree,
            reasonCode: null,
            candidateId: input.candidateId,
            confidence: input.confidence,
            rawExcerpt: input.rawExcerpt,
          }],
        }),
      },
    )
    const body = await readJson(response)
    if (!isObject(body) || !isObject(body.data) || typeof body.data.publicId !== 'string') {
      throw new StaffActionsApiError('桌台记录确认结果无法识别，请到最近记录核对', 'INVALID_OBSERVATION_CONFIRMATION', response.status)
    }
    const taskId = body.data.serviceTaskId
    if (typeof body.data.status !== 'string' || (taskId !== null && typeof taskId !== 'string')) {
      throw new StaffActionsApiError('桌台记录确认结果无法识别，请到最近记录核对', 'INVALID_OBSERVATION_CONFIRMATION', response.status)
    }
    return { publicId: body.data.publicId, status: body.data.status, serviceTaskId: taskId }
  }

  async loadRecentObservations(tableSessionId: string, signal?: AbortSignal): Promise<ObservationHistory> {
    const response = await this.request(
      `/api/staff/table-sessions/${encodeURIComponent(tableSessionId)}/observations/recent`,
      { method: 'GET', signal },
    )
    const body = await readJson(response)
    if (!isObject(body) || !isObject(body.data)) {
      throw new StaffActionsApiError('最近桌台记录无法识别，请刷新后重试', 'INVALID_OBSERVATION_HISTORY', response.status)
    }
    return observationHistory(body.data, response.status)
  }

  async loadTableRecommendation(
    tableSessionId: string,
    signal?: AbortSignal,
  ): Promise<StaffRecommendationSession | null> {
    const response = await this.request(
      `/api/staff/customer-experience/recommendations?tableSessionId=${encodeURIComponent(tableSessionId)}`,
      { method: 'GET',signal },
    )
    const body = await readJson(response)
    if (!isObject(body) || !('data' in body)) throw new StaffActionsApiError(
      '桌台推荐无法识别，请刷新后重试','INVALID_RECOMMENDATION_RESPONSE',response.status,
    )
    if (body.data === null) return null
    return staffRecommendationSession(body.data,response.status)
  }

  async modifyTableRecommendation(input: Readonly<{
    recommendationPublicId: string
    sourceProductId: string
    targetProductId: string
    reasonCode: RecommendationStaffModificationReason
  }>): Promise<StaffRecommendationModification> {
    const response = await this.request(
      `/api/staff/customer-experience/recommendations/${encodeURIComponent(input.recommendationPublicId)}/modifications`,
      {
        method: 'POST',
        headers: new Headers({
          accept: 'application/json','content-type': 'application/json',
          'idempotency-key': `staff-recommendation-modification-${this.createIdempotencyKey()}`,
        }),
        body: JSON.stringify({
          sourceProductId: input.sourceProductId,targetProductId: input.targetProductId,
          reasonCode: input.reasonCode,
        }),
      },
    )
    const body = await readJson(response)
    if (!isObject(body) || !isObject(body.data)) throw new StaffActionsApiError(
      '推荐调整结果无法识别，请刷新后核对','INVALID_RECOMMENDATION_MODIFICATION_RESPONSE',response.status,
    )
    return staffRecommendationModification(body.data,response.status)
  }

  async reviseObservation(input: Readonly<{
    observationPublicId: string
    eventId: string
    reason: string
    replacement: ObservationEventReplacement
  }>): Promise<ObservationEvent> {
    const response = await this.request(
      `/api/staff/observations/${encodeURIComponent(input.observationPublicId)}/events/${encodeURIComponent(input.eventId)}/revise`,
      {
        method: 'POST',
        headers: new Headers({
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': `staff-observation-revise-${this.createIdempotencyKey()}`,
        }),
        body: JSON.stringify({ reason: input.reason, replacement: input.replacement }),
      },
    )
    const body = await readJson(response)
    if (!isObject(body) || !isObject(body.data)) {
      throw new StaffActionsApiError('修正结果无法识别，请刷新最近记录核对', 'INVALID_OBSERVATION_REVISION', response.status)
    }
    return observationEvent(body.data, response.status)
  }

  private async getData<Data>(url: string, signal?: AbortSignal): Promise<Data> {
    const response = await this.request(url, { method: 'GET', signal })
    const body = await readJson(response)
    if (!isObject(body) || !('data' in body)) throw new StaffActionsApiError('服务返回内容无法识别', 'INVALID_RESPONSE', response.status)
    return body.data as Data
  }

  private async command(
    url: string,
    body: object,
    idempotencyHeader: 'idempotency-key' | 'x-idempotency-key',
    idempotencyKey = `staff-action-${this.createIdempotencyKey()}`,
  ): Promise<void> {
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' })
    headers.set(idempotencyHeader, idempotencyKey)
    await this.request(url, { method: 'POST', body: JSON.stringify(body), headers })
  }

  private async postData<Data>(
    url:string,body:object,idempotencyHeader:'idempotency-key'|'x-idempotency-key',
  ):Promise<Data> {
    const headers=new Headers({ accept:'application/json','content-type':'application/json' })
    headers.set(idempotencyHeader,`staff-action-${this.createIdempotencyKey()}`)
    const response=await this.request(url,{ method:'POST',body:JSON.stringify(body),headers })
    const value=await readJson(response)
    if (!isObject(value) || !('data' in value)) throw new StaffActionsApiError(
      '预检结果无法识别','INVALID_RESPONSE',response.status,
    )
    return value.data as Data
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    if (!url.startsWith('/api/')) throw new StaffActionsApiError('接口地址不受信任', 'UNTRUSTED_ENDPOINT', null)
    const controller = new AbortController()
    const callerSignal = init.signal
    const abort = () => controller.abort(callerSignal?.reason)
    if (callerSignal?.aborted) abort()
    else callerSignal?.addEventListener('abort', abort, { once: true })
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.send(url, { ...init, signal: controller.signal, credentials: 'include' })
      if (!response.ok) throw await apiError(response)
      return response
    } catch (error) {
      if (error instanceof StaffActionsApiError) throw error
      if (callerSignal?.aborted) throw new StaffActionsApiError('操作已取消', 'ABORTED', null)
      if (controller.signal.aborted) throw new StaffActionsApiError('请求超时，请重试', 'TIMEOUT', null)
      throw new StaffActionsApiError('网络连接失败，请检查网络后重试', 'NETWORK_ERROR', null)
    } finally {
      globalThis.clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abort)
    }
  }
}

async function apiError(response: Response): Promise<StaffActionsApiError> {
  const body = await readJson(response).catch(() => null)
  if (isObject(body) && isObject(body.error)) {
    const referenceId = typeof body.error.referenceId === 'string'
      && /^[A-Za-z0-9._:-]{1,64}$/.test(body.error.referenceId)
      ? body.error.referenceId
      : null
    const message = typeof body.error.message === 'string' ? body.error.message : '操作未完成'
    return new StaffActionsApiError(
      referenceId === null ? message : `${message}（编号：${referenceId}）`,
      typeof body.error.code === 'string' ? body.error.code : 'HTTP_ERROR',
      response.status,
      false,
      referenceId,
    )
  }
  return new StaffActionsApiError('操作未完成，请重试', 'HTTP_ERROR', response.status)
}

function observationDraft(value: Record<string, unknown>, status: number): ObservationDraft {
  const candidates = value.candidates
  if (value.status !== 'draft' || (value.inputKind !== 'text' && value.inputKind !== 'voice_transcript')
    || typeof value.rawContent !== 'string' || typeof value.parseConfidence !== 'number'
    || !Number.isFinite(value.parseConfidence) || value.parseConfidence < 0 || value.parseConfidence > 1
    || typeof value.needsImmediateAction !== 'boolean'
    || (value.serviceTaskId !== null && typeof value.serviceTaskId !== 'string')
    || typeof value.clarificationRequired !== 'boolean'
    || (value.clarificationPrompt !== null && typeof value.clarificationPrompt !== 'string')
    || !Array.isArray(candidates)) {
    throw new StaffActionsApiError('桌台记录解析结果无法识别，请保留原话后重试', 'INVALID_OBSERVATION_RESPONSE', status)
  }
  const normalizedCandidates = candidates.map((item) => {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.mentionIndex !== 'number'
      || typeof item.rawMention !== 'string' || typeof item.orderItemId !== 'string'
      || typeof item.productId !== 'string' || typeof item.productName !== 'string'
      || typeof item.rank !== 'number' || typeof item.confidence !== 'number'
      || !['exact_name', 'search_text', 'order_context', 'manual'].includes(String(item.matchKind))) {
      throw new StaffActionsApiError('桌台记录商品候选无法识别，请保留原话后重试', 'INVALID_OBSERVATION_RESPONSE', status)
    }
    return item as unknown as ObservationCandidate
  })
  return {
    publicId: String(value.publicId), status: 'draft', inputKind: value.inputKind,
    rawContent: value.rawContent, parseConfidence: value.parseConfidence,
    needsImmediateAction: value.needsImmediateAction, serviceTaskId: value.serviceTaskId as string | null,
    candidates: normalizedCandidates, clarificationRequired: value.clarificationRequired,
    clarificationPrompt: value.clarificationPrompt as string | null,
  }
}

function staffRecommendationSession(value: unknown,status: number): StaffRecommendationSession {
  if (!isObject(value) || typeof value.recommendationPublicId !== 'string'
    || typeof value.tableSessionId !== 'string' || typeof value.createdAt !== 'string'
    || !Array.isArray(value.options)) throw new StaffActionsApiError(
      '桌台推荐无法识别，请刷新后重试','INVALID_RECOMMENDATION_RESPONSE',status,
    )
  const options = value.options.map((option) => {
    if (!isObject(option) || typeof option.productId !== 'string' || typeof option.productName !== 'string'
      || !Number.isInteger(option.rank) || !['comfortable','enhanced','signature'].includes(String(option.tier))
      || !Number.isSafeInteger(option.amountMinor) || Number(option.amountMinor)<0
      || typeof option.currency !== 'string') throw new StaffActionsApiError(
        '推荐方案无法识别，请刷新后重试','INVALID_RECOMMENDATION_RESPONSE',status,
      )
    return option as unknown as StaffRecommendationSession['options'][number]
  })
  return { recommendationPublicId: value.recommendationPublicId,tableSessionId: value.tableSessionId,
    createdAt: value.createdAt,options }
}

function staffRecommendationModification(
  value: Record<string, unknown>,status: number,
): StaffRecommendationModification {
  const fields = [
    'eventId','recommendationPublicId','tableSessionId','sourceProductId','sourceProductName',
    'targetProductId','targetProductName','employeeId','occurredAt',
  ] as const
  const reasons: RecommendationStaffModificationReason[] = [
    'customer_request','availability_substitution','service_recovery','staff_judgement',
  ]
  if (fields.some((field) => typeof value[field] !== 'string')
    || !reasons.includes(value.reasonCode as RecommendationStaffModificationReason)) {
    throw new StaffActionsApiError(
      '推荐调整结果无法识别，请刷新后核对','INVALID_RECOMMENDATION_MODIFICATION_RESPONSE',status,
    )
  }
  return value as unknown as StaffRecommendationModification
}

function observationHistory(value: Record<string, unknown>, status: number): ObservationHistory {
  if (!Array.isArray(value.items) || !isObject(value.permissions)
    || typeof value.permissions.canCorrect !== 'boolean' || typeof value.permissions.canViewRaw !== 'boolean') {
    throw new StaffActionsApiError('最近桌台记录无法识别，请刷新后重试', 'INVALID_OBSERVATION_HISTORY', status)
  }
  const items = value.items.map((item) => {
    if (!isObject(item) || typeof item.publicId !== 'string'
      || (item.inputKind !== 'text' && item.inputKind !== 'voice_transcript')
      || (item.rawContent !== null && typeof item.rawContent !== 'string')
      || typeof item.parseConfidence !== 'number' || !Number.isFinite(item.parseConfidence)
      || item.parseConfidence < 0 || item.parseConfidence > 1 || typeof item.needsImmediateAction !== 'boolean'
      || (item.serviceTaskId !== null && typeof item.serviceTaskId !== 'string')
      || (item.serviceTaskStatus !== null && typeof item.serviceTaskStatus !== 'string')
      || typeof item.recordedBy !== 'string' || typeof item.confirmedBy !== 'string'
      || typeof item.confirmedAt !== 'string' || !Array.isArray(item.events) || !Array.isArray(item.revisions)) {
      throw new StaffActionsApiError('最近桌台记录无法识别，请刷新后重试', 'INVALID_OBSERVATION_HISTORY', status)
    }
    const events = item.events.map((event) => {
      if (!isObject(event) || typeof event.needsImmediateAction !== 'boolean'
        || (event.serviceTaskId !== null && typeof event.serviceTaskId !== 'string')
        || typeof event.createdAt !== 'string') {
        throw new StaffActionsApiError('观察事件无法识别，请刷新后重试', 'INVALID_OBSERVATION_HISTORY', status)
      }
      return observationEvent(event, status)
    })
    const revisions = item.revisions.map((revision) => {
      if (!isObject(revision) || typeof revision.id !== 'string' || typeof revision.reason !== 'string'
        || typeof revision.correctedBy !== 'string' || typeof revision.createdAt !== 'string'
        || !isObject(revision.before) || !isObject(revision.after)) {
        throw new StaffActionsApiError('修订记录无法识别，请刷新后重试', 'INVALID_OBSERVATION_HISTORY', status)
      }
      return revision as unknown as ObservationRevision
    })
    return { ...item, events, revisions } as unknown as ObservationHistoryItem
  })
  return {
    items,
    permissions: { canCorrect: value.permissions.canCorrect, canViewRaw: value.permissions.canViewRaw },
  }
}

function observationEvent(value: Record<string, unknown>, status: number): ObservationEvent {
  const expressionKinds: ObservationExpressionKind[] = ['objective_fact', 'customer_quote', 'staff_judgement', 'system_inference']
  const scopeKinds: ObservationScopeKind[] = ['table', 'seat', 'customer', 'product']
  const eventTypes: ObservationEventType[] = ['remaining', 'consumed_little', 'praise', 'complaint', 'too_sweet', 'too_cold', 'served_late', 'presentation', 'portion', 'other']
  const degrees: ObservationDegree[] = ['little', 'half', 'most', 'almost_untouched', 'unknown']
  if (typeof value.id !== 'string' || typeof value.eventGroupId !== 'string' || typeof value.revision !== 'number'
    || !expressionKinds.includes(value.expressionKind as ObservationExpressionKind)
    || !scopeKinds.includes(value.scopeKind as ObservationScopeKind)
    || !eventTypes.includes(value.eventType as ObservationEventType)
    || (value.degree !== null && !degrees.includes(value.degree as ObservationDegree))
    || (value.reasonCode !== null && typeof value.reasonCode !== 'string')
    || (value.seatLabel !== undefined && value.seatLabel !== null && typeof value.seatLabel !== 'string')
    || (value.customerId !== undefined && value.customerId !== null && typeof value.customerId !== 'string')
    || (value.productId !== null && typeof value.productId !== 'string')
    || (value.productName !== undefined && value.productName !== null && typeof value.productName !== 'string')
    || (value.orderItemId !== undefined && value.orderItemId !== null && typeof value.orderItemId !== 'string')
    || (value.selectedCandidateId !== null && typeof value.selectedCandidateId !== 'string')
    || typeof value.confidence !== 'number'
    || (value.rawExcerpt !== null && typeof value.rawExcerpt !== 'string')
    || (value.needsImmediateAction !== undefined && typeof value.needsImmediateAction !== 'boolean')
    || (value.serviceTaskId !== undefined && value.serviceTaskId !== null && typeof value.serviceTaskId !== 'string')
    || (value.createdAt !== undefined && typeof value.createdAt !== 'string')) {
    throw new StaffActionsApiError('观察事件无法识别，请刷新后重试', 'INVALID_OBSERVATION_HISTORY', status)
  }
  return {
    ...value,
    seatLabel: typeof value.seatLabel === 'string' ? value.seatLabel : null,
    customerId: typeof value.customerId === 'string' ? value.customerId : null,
    productName: typeof value.productName === 'string' ? value.productName : null,
    orderItemId: typeof value.orderItemId === 'string' ? value.orderItemId : null,
    needsImmediateAction: value.needsImmediateAction === true,
    serviceTaskId: typeof value.serviceTaskId === 'string' ? value.serviceTaskId : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  } as unknown as ObservationEvent
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOnlinePaymentAction(value: unknown): value is OnlinePaymentAction {
  return isObject(value)
    && typeof value.paymentId === 'string'
    && typeof value.paymentPublicId === 'string'
    && typeof value.orderPublicId === 'string'
    && (value.status === 'pending' || value.status === 'unknown' || value.status === 'failed')
    && (value.presentation === 'jsapi' || value.presentation === 'qr' || value.presentation === 'barcode')
    && typeof value.expiresAt === 'string'
    && (value.payload === null || isObject(value.payload))
}

function shanghaiCalendarDay(): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date())
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const date = `${value.year}-${value.month}-${value.day}`
  const from = new Date(`${date}T00:00:00.000+08:00`)
  const to = new Date(from); to.setUTCDate(to.getUTCDate() + 1)
  return { from: from.toISOString(), to: to.toISOString() }
}
