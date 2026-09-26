/** Identification only. Every subsequent command must recheck its own authority. */
export interface MemberParticipation {
  memberNo: string
  displayName: string | null
  checkedAt: string
  activitiesVisible: boolean
  activities: Array<{ publicId: string; title: string; startsAt: string; guidance: string }>
  registrations: Array<{
    publicId: string; activityPublicId: string; title: string; startsAt: string
    partySize: number; guidance: string; readyForCheckIn: boolean
  }>
  benefits: Array<{ id: string; title: string; quantity: number; validUntil: string | null; guidance: string }>
}
