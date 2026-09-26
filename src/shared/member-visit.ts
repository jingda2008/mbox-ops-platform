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
  visit: MemberVisit | null
}
