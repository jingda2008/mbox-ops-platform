import type {
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
}

export interface PublicReservationView {
  id: string
  customerName: string
  partySize: number
  areaPreferenceCode: string | null
  occasionCode: ReservationOccasionCode | null
  occasionNote: string
  scheduledAt: string
  status: ReservationStatus
  tableCode: string | null
  requestedAt: string
  updatedAt: string
}

export interface PublicReservationListResponse {
  config: PublicReservationConfigView
  reservations: PublicReservationView[]
}

export interface PublicReservationCreateInput {
  customerName: string
  partySize: number
  areaPreferenceCode?: string
  occasionCode?: ReservationOccasionCode
  occasionNote?: string
  scheduledAt: string
  idempotencyKey: string
}
