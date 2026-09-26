export interface MemberVisitRewardRule {
  id: string; name: string; required_visits: number; status: string; created_at: string
  products: string; quantity: number; campaign_status: string; available_until: string
}
export interface MemberVisitRewardRequest {
  id: string; name: string; member_no: string; earned_business_date: string
  required_visits: number; quantity: number; products: string; status: string
  decision_reason: string | null; cancelled_sources: number; benefit_status: string | null
  quantity_redeemed: number; visit_dates: string[]
}
export interface MemberVisitRewardProgress {
  name: string; requiredVisits: number; remainingVisits: number; pending: number; issued: number
}
