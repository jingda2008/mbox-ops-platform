export interface ManualPointsRequest {memberNo:string;pointsDelta:number;reason:string}
export interface ManualPointsDecision {requestId:string;decision:'approve'|'reject';reason:string}
export interface ManualPointsResult {requestId:string;status:'requested'|'approved'|'rejected';pointsDelta:number;availableDelta:number;balance:number|null;pendingRecoveryPoints:number|null}
export interface ManualPointsRow {id:string;memberNo:string;pointsDelta:number;reason:string;requestedBy:string;requesterName:string;createdAt:string;status:'requested'|'approved'|'rejected';decisionReason:string|null;deciderName:string|null;expiresAt:string|null;availableDelta:number|null}
export interface ManualPointsBoard {scopeKey:string;employeeId:string;items:ManualPointsRow[];page:number;hasMore:boolean}
