export type WasteType = 'mixing_failure' | 'discarded' | 'expired' | 'tasting' | 'complimentary' | 'count_difference' | 'other'
export const wasteTypeLabels: Record<WasteType, string> = {mixing_failure:'调酒失败',discarded:'报废',expired:'过期',tasting:'试饮',complimentary:'赠送',count_difference:'盘点差异',other:'其他'}
export type WasteRequest = {
  id:string; itemName:string; quantity:string; baseUnit:string; wasteType:WasteType; reason:string;
  requestedByEmployeeId:string; requestedByName:string; createdAt:string; status:'pending'|'approved'|'rejected';
  decidedByName:string|null; decisionReason:string|null; canReview:boolean;
}
export type WasteResult = {id:string;status:'pending'} | {
  status:'recorded'; movementId:string;remainingQuantity:string;baseUnit:string;wasteCostMinor?:string|null;
}
