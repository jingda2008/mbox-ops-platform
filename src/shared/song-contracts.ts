/** Money is represented in the currency's smallest unit, for example fen. */
export type SongMoneyAmount = number

export type PerformanceSessionStatus = 'scheduled' | 'live' | 'completed' | 'cancelled'
export type SongTableSessionStatus = 'open' | 'closed'
export type SongRequestStatus =
  | 'pending_confirmation'
  | 'pending_payment'
  | 'paid'
  | 'accepted'
  | 'performing'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'refund_required'
  | 'refunded'

export type SongActorRole = 'guest' | 'singer' | 'staff' | 'manager' | 'system'
export type SongCollectionChannel = 'cash' | 'physical_pos'
export type SongRequestMode = 'standard' | 'advance_reservation' | 'extension_negotiation'

export interface Singer {
  id: string
  displayName: string
  actorId: string
  active: boolean
  photoUrl?: string
  headline?: string
  bio?: string
  styleTags?: string[]
}

export interface SingerProfileWriteInput {
  displayName: string
  photoUrl: string
  headline: string
  bio: string
  styleTags: string[]
  active: boolean
}

export interface SingerWriteInput extends SingerProfileWriteInput {
  actorId?: string
}

export interface RepertoireWriteInput {
  title: string
  artist: string
  durationSeconds: number
  priceAmount: number
  currency: string
  enabled: boolean
}

export type PerformanceSessionWriteInput = Omit<PerformanceSession, 'id' | 'configVersion'> & { expectedVersion?: number }

export interface SongCatalogItem {
  id: string
  title: string
  artist: string
  durationSeconds: number
  active: boolean
}

/** A singer-specific, versioned song offer. Prices may differ between singers. */
export interface SingerRepertoireEntry {
  id: string
  singerId: string
  songId: string
  priceAmount: SongMoneyAmount
  currency: string
  configVersion: number
  enabled: boolean
}

export interface SingerAppearance {
  id: string
  singerId: string
  startsAt: string
  endsAt: string
  requestOpensAt: string
  requestClosesAt: string
  acceptingRequests: boolean
  advanceBookingEnabled?: boolean
  extensionNegotiationEnabled?: boolean
  extensionThresholdMinutes?: number
}

export interface PerformanceSession {
  id: string
  businessDate: string
  title: string
  status: PerformanceSessionStatus
  startsAt: string
  endsAt: string
  appearances: SingerAppearance[]
  configVersion?: number
}

/** An open table visit. The ID must change whenever the table is reopened. */
export interface SongTableSession {
  id: string
  tableId: string
  tableCode: string
  status: SongTableSessionStatus
  openedAt: string
  closedAt: string | null
}

export interface SongPriceSnapshot {
  repertoireEntryId: string
  singerId: string
  songId: string
  songTitle: string
  songArtist: string
  singerName: string
  priceAmount: SongMoneyAmount
  currency: string
  configVersion: number
}

export interface PaidSongSnapshot {
  paymentReference: string
  paidAmount: SongMoneyAmount
  currency: string
  collectionChannel: SongCollectionChannel
  paidAt: string
}

export interface SongRequest {
  id: string
  performanceSessionId: string
  appearanceId: string
  tableSessionId: string
  tableId: string
  tableCode: string
  requestedBy: string
  customerNote: string
  requestMode: SongRequestMode
  scheduleVersion: number
  status: SongRequestStatus
  priceSnapshot: SongPriceSnapshot
  payment: PaidSongSnapshot | null
  confirmedBy: string | null
  confirmedAt: string | null
  acceptedBy: string | null
  acceptedAt: string | null
  performingAt: string | null
  completedAt: string | null
  rejectedBy: string | null
  rejectedAt: string | null
  rejectionReason: string | null
  cancelledBy: string | null
  cancelledAt: string | null
  refundReason: string | null
  refundReference: string | null
  refundedAt: string | null
  createdAt: string
  updatedAt: string
  revision: number
}

export interface SongAuditEvent {
  id: string
  requestId: string
  type:
    | 'song_request.submitted.v1'
    | 'song_request.confirmed.v1'
    | 'song_request.paid.v1'
    | 'song_request.accepted.v1'
    | 'song_request.performing.v1'
    | 'song_request.completed.v1'
    | 'song_request.rejected.v1'
    | 'song_request.cancelled.v1'
    | 'song_request.refund_required.v1'
    | 'song_request.refunded.v1'
  actorId: string
  actorRole: SongActorRole
  fromStatus: SongRequestStatus | null
  toStatus: SongRequestStatus
  occurredAt: string
  reason: string | null
  details: Record<string, string | number | boolean | null>
}

export interface SongIdempotencyRecord {
  key: string
  operation: string
  fingerprint: string
  requestId: string
}

export interface SongState {
  businessDate: string
  singers: Singer[]
  songs: SongCatalogItem[]
  repertoire: SingerRepertoireEntry[]
  performanceSessions: PerformanceSession[]
  tableSessions: SongTableSession[]
  managerActorIds: string[]
  requests: SongRequest[]
  auditEvents: SongAuditEvent[]
  idempotencyRecords: SongIdempotencyRecord[]
}

export interface SongActor {
  actorId: string
  role: SongActorRole
}

export interface SubmitSongRequestCommand {
  requestId: string
  performanceSessionId: string
  appearanceId: string
  tableSessionId: string
  singerId: string
  songId: string
  requestedBy: string
  customerNote: string
  occurredAt: string
  idempotencyKey: string
}

export interface MarkSongRequestPaidCommand {
  requestId: string
  paymentReference: string
  paidAmount: SongMoneyAmount
  currency: string
  collectionChannel: SongCollectionChannel
  actor: SongActor
  occurredAt: string
  idempotencyKey: string
}

export interface ConfirmSongRequestCommand extends AcceptSongRequestCommand {}

export interface AcceptSongRequestCommand {
  requestId: string
  actor: SongActor
  occurredAt: string
  idempotencyKey: string
}

export interface StartSongPerformanceCommand extends AcceptSongRequestCommand {}

export interface CompleteSongRequestCommand extends AcceptSongRequestCommand {}

export interface RejectSongRequestCommand extends AcceptSongRequestCommand {
  reason: string
}

export interface CancelSongRequestCommand extends AcceptSongRequestCommand {
  reason: string
}

export interface MarkSongRequestRefundedCommand extends AcceptSongRequestCommand {
  refundReference: string
}
