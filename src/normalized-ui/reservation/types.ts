export type ReservationStep = 'schedule' | 'details' | 'confirm' | 'complete'
export type BookingMode = 'direct'
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
  policyVersion: number
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
  acceptingReservations: boolean
  depositRule: DepositRule
  areas: ReservationArea[]
}

export type PublicPerformancePhase = 'no_schedule' | 'upcoming' | 'live' | 'between' | 'ended'

export interface PublicPerformanceSchedule {
  id: string
  performerStageName: string
  performerProfile: {
    bio?: string
    imageUrl?: string
    genres?: string[]
    styles?: string[]
    highlights?: string[]
  }
  startsAt: string
  endsAt: string
  status: 'scheduled' | 'performing' | 'completed' | 'cancelled'
  sortOrder: number
}

export interface PublicDailyPerformance {
  timezone: string
  localDate: string
  phase: PublicPerformancePhase
  current: PublicPerformanceSchedule | null
  next: PublicPerformanceSchedule | null
  startsInSeconds: number | null
  remainingSeconds: number | null
  schedules: PublicPerformanceSchedule[]
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
  arrivalGraceEndsAt: string
  reservationPolicyVersion: number
  preferredScheduleId: string | null
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
