export interface MemberReportCard { name:string; kind:string; status:string; validUntil:string|null }
export interface MemberReportEntry { reference:string; kind:string; businessDate:string; firstPaidAt:string; lastPaidAt:string; lastRefundAt:string|null; paidMinor:number; refundMinor:number; netMinor:number }
export interface MemberReportRow {
 customerId:string; memberNo:string; name:string|null; status:string; joinedAt:string; phone:string|null;
 phoneStatus:'available'|'missing'|'unavailable'; gender:string|null; cards:MemberReportCard[]; hasInterestCard:boolean;
 paidMinor:number; refundMinor:number; netMinor:number; consumptionCount:number; orderCount:number;
 firstPaidAt:string|null; lastPaidAt:string|null;
}
export interface MemberReportView { generatedAt:string; timezone:string; cutoff:string; totalMembers:number; matchedMembers:number; page:number; pageSize:number; items:MemberReportRow[] }
export interface MemberReportDetail { items:MemberReportEntry[]; total:number; page:number; pageSize:number }
