import { ApiError, OfflineWriteBlockedError } from './api'
import {
  getOfflineStatus,
  reportNetworkAvailable,
  reportNetworkUnavailable,
} from './offline'
import type {
  Reservation,
  ReservationConfig,
  ReservationOccasionCode,
  ReservationStatus,
} from './shared/reservation-contracts'

export interface ReservationListResponse {
  config: ReservationConfig | null
  reservations: Reservation[]
}

export type ReservationConfigWriteInput = Omit<ReservationConfig, 'version'>

export interface UpdateReservationConfigInput {
  config: ReservationConfigWriteInput
  reason: string
  idempotencyKey: string
}

export interface CreateReservationInput {
  customerReference: string
  customerName: string
  contactReference: string
  sourceCode: string
  partySize: number
  areaPreferenceCode?: string
  occasionCode?: ReservationOccasionCode
  occasionNote?: string
  scheduledAt: string
  depositRequiredAmount: number
  depositCurrency: string
  idempotencyKey: string
}

export type ReservationActionInput =
  | { action: 'confirm'; idempotencyKey: string }
  | { action: 'arrive'; idempotencyKey: string }
  | { action: 'seat'; tableId: string; tableCode: string; tableSessionId: string; idempotencyKey: string }
  | { action: 'cancel'; reason: string; idempotencyKey: string }
  | { action: 'no_show'; reason: string; idempotencyKey: string }

interface DepositIntentInput {
  paymentIntentReference: string
  idempotencyKey: string
}

interface DepositConfirmationInput {
  paymentIntentReference: string
  paymentConfirmationReference: string
  confirmedAmount: number
  currency: string
  idempotencyKey: string
}

interface DepositRefundStartInput {
  refundRequestReference: string
  idempotencyKey: string
}

interface DepositRefundConfirmationInput {
  refundRequestReference: string
  refundConfirmationReference: string
  refundedAmount: number
  currency: string
  idempotencyKey: string
}

interface DepositRefundFailureInput {
  refundRequestReference: string
  reason: string
  idempotencyKey: string
}

async function reservationRequest<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw error
  }
  reportNetworkAvailable()

  let body: T & { message?: string }
  try {
    body = (await response.json()) as T & { message?: string }
  } catch {
    throw new ApiError('系统返回了无法识别的响应', response.status)
  }
  if (!response.ok) throw new ApiError(body.message ?? '预约操作失败', response.status)
  return body
}

export function listReservations(status?: ReservationStatus) {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return reservationRequest<ReservationListResponse>(`/api/reservations${query}`)
}

export function createReservation(input: CreateReservationInput) {
  return reservationRequest<Reservation>('/api/reservations', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateReservationConfig(input: UpdateReservationConfigInput) {
  return reservationRequest<ReservationConfig>('/api/reservations/config', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function actOnReservation(reservationId: string, input: ReservationActionInput) {
  return reservationRequest<Reservation>(`/api/reservations/${encodeURIComponent(reservationId)}/actions`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function recordDepositIntent(reservationId: string, input: DepositIntentInput) {
  return reservationRequest<Reservation>(`/api/reservations/${encodeURIComponent(reservationId)}/deposit-intent`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function confirmDeposit(reservationId: string, input: DepositConfirmationInput) {
  return reservationRequest<Reservation>(`/api/reservations/${encodeURIComponent(reservationId)}/deposit-confirmation`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function startDepositRefund(reservationId: string, input: DepositRefundStartInput) {
  return reservationRequest<Reservation>(`/api/reservations/${encodeURIComponent(reservationId)}/deposit-refunds`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function confirmDepositRefund(reservationId: string, input: DepositRefundConfirmationInput) {
  return reservationRequest<Reservation>(`/api/reservations/${encodeURIComponent(reservationId)}/deposit-refund-confirmation`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function failDepositRefund(reservationId: string, input: DepositRefundFailureInput) {
  return reservationRequest<Reservation>(`/api/reservations/${encodeURIComponent(reservationId)}/deposit-refund-failure`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
