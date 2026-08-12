export type ReservationStep = 'schedule' | 'confirm' | 'complete'
export type BookingMode = 'direct' | 'self_select'
export type ReservationTableStatus = 'available' | 'reserved' | 'locked'
export type ReservationZone = 'stage-front' | 'indoor-middle' | 'outdoor'
export type SeatPreference =
  | 'no_preference'
  | 'stage_atmosphere'
  | 'quiet_chat'
  | 'comfortable_booth'
  | 'outdoor_view'

export interface ReservationIdentity {
  provider: 'anonymous' | 'wechat'
  providerAssertion: string
  deviceFingerprint: string
}

export interface DepositRule {
  enabled: boolean
  mode: 'disabled' | 'flat' | 'minimum_spend_ratio'
  amountMinor: number
  ruleText: string | null
}

export interface ReservationTable {
  code: string
  name: string
  capacity: number
  minimumSpendMinor: number | null
  currency: string
  status: ReservationTableStatus
}

export interface ReservationArea {
  code: string
  name: string
  type: string
  zone: ReservationZone
  tables: ReservationTable[]
}

export interface ReservationAvailability {
  arrivalAt: string
  expectedEndAt: string
  guestCount: number
  holdMinutes: number
  depositRule: DepositRule
  areas: ReservationArea[]
}

export interface PublicReservation {
  publicId: string
  customerName: string
  maskedContact: string
  guestCount: number
  arrivalAt: string
  expectedEndAt: string
  status: string
  arrivalState: 'arrived' | 'not_arrived'
  note: string | null
  seatPreference: SeatPreference
  tableCodes: string[]
  holdExpiresAt: string | null
  cancellationPolicy: Record<string, unknown>
}

export interface PublicWaitlist {
  publicId: string
  customerName: string
  maskedContact: string
  guestCount: number
  desiredArrivalAt: string
  status: string
  arrivalState: 'arrived' | 'not_arrived'
  note: string | null
}

export interface ReservationDraft {
  date: string
  time: string
  guestCount: number
  mode: BookingMode
  tableCodes: string[]
  seatPreference: SeatPreference
  customerName: string
  contact: string
  note: string
}

export interface OperatingHours {
  openingMinute: number
  lastArrivalMinute: number
  slotMinutes: number
}

export interface ArrivalSlot {
  value: string
  label: string
  iso: string
  nextDay: boolean
}
