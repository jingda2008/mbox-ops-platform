import type {
  ReservationAssignmentMode,
  ReservationOccasionCode,
  ReservationStatus,
} from './reservation-contracts.js'

export interface PublicReservationSessionResponse {
  accessToken: string
  expiresAt: string
}

export interface PublicReservationConfigView {
  version: number
  minimumPartySize: number
  maximumPartySize: number
  areaPreferences: Array<{ code: string; name: string }>
  occasions: Array<{ code: ReservationOccasionCode; name: string }>
  businessHours: {
    timeZone: string
    openingTime: string
    closingTime: string
    slotMinutes: number
    closedWeekdays: number[]
  }
  capacity: {
    defaultDailyCapacity: number
    defaultSlotCapacity: number
    dateOverrides: Array<{
      date: string
      enabled: boolean
      totalCapacity: number
      slotCapacities: Array<{ time: string; capacity: number }>
    }>
  }
  publicRules: {
    minimumLeadMinutes: number
    maximumAdvanceDays: number
    acceptedContactMethods: Array<'phone' | 'wechat'>
  }
  depositPolicy: {
    enabled: boolean
    currency: string
    defaultDepositAmount: number
    defaultMinimumSpendAmount: number
    defaultDeductibleRateBps: number
    customerNotice: string
    areaRules: Array<{
      areaPreferenceCode: string
      depositAmount: number
      minimumSpendAmount: number
      deductibleRateBps: number
      customerNotice: string
    }>
  }
}

export interface PublicReservationView {
  id: string
  customerName: string
  partySize: number
  assignmentMode: ReservationAssignmentMode
  requestedTableCode: string | null
  areaPreferenceCode: string | null
  occasionCode: ReservationOccasionCode | null
  occasionNote: string
  scheduledAt: string
  status: ReservationStatus
  tableCode: string | null
  requestedAt: string
  updatedAt: string
  phone: string | null
  wechatId: string | null
}

export interface PublicReservationListResponse {
  config: PublicReservationConfigView
  reservations: PublicReservationView[]
}

export interface PublicReservationCreateInput {
  customerName: string
  phone?: string
  wechatId?: string
  partySize: number
  assignmentMode: ReservationAssignmentMode
  requestedTableCode?: string
  areaPreferenceCode?: string
  occasionCode?: ReservationOccasionCode
  occasionNote?: string
  scheduledAt: string
  idempotencyKey: string
}

export interface PublicReservationUpdateInput {
  customerName: string
  phone?: string
  wechatId?: string
  partySize: number
  assignmentMode: ReservationAssignmentMode
  requestedTableCode?: string
  areaPreferenceCode?: string
  occasionCode?: ReservationOccasionCode | null
  occasionNote?: string
  scheduledAt: string
  idempotencyKey: string
}

export interface PublicReservationCancelInput {
  reason?: string
  idempotencyKey: string
}

export interface PublicReservationTableView {
  id: string
  code: string
  displayName: string
  areaId: string
  areaPreferenceCode: string
  capacity: number
  status: 'available' | 'reserved' | 'locked'
  statusReason: string
  depositAmount: number
  minimumSpendAmount: number
  deductibleRateBps: number
  customerNotice: string
}

export interface PublicReservationAvailabilityResponse {
  scheduledAt: string
  partySize: number
  tables: PublicReservationTableView[]
}
