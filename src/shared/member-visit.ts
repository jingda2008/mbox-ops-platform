export interface MemberVisit {
  id: string
  businessDate: string
  checkedInAt: string
  employeeName: string
  status: 'checked_in' | 'cancelled'
}
export interface MemberVisitStatus {
  memberNo: string
  businessDate: string
  canCheckIn: boolean
  rewards?: import('./member-visit-reward.js').MemberVisitRewardProgress[]
  visit: MemberVisit | null
}
