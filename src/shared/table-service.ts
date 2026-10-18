export interface ServiceEmployee { id: string; name: string; code: string }
export interface ServiceTable { id: string; code: string; name: string; area: string; sessionId: string|null; primaryName: string|null }
export interface ServiceSession { id: string; tableId: string; tableCode: string; openedAt: string; closedAt: string|null; status: string; openedBy: string|null; primaryId: string|null; primaryName: string|null; primaryCode: string|null; primaryStatus: string|null; revision: number }
export interface ServiceChange { id: string; revision: number; fromName: string|null; toName: string; actorName: string; fromCode: string|null; toCode: string; actorCode: string; reason: string; occurredAt: string }
export interface ServiceActivity { id: string; kind: string; title: string; actorId: string|null; actorName: string|null; actorCode: string|null; occurredAt: string; event: string }
export interface ServiceDetail {
 session: ServiceSession;
 helpers: Array<{id:string; name:string; type:string}>;
 changes: ServiceChange[]; changesHasMore: boolean;
 activities: ServiceActivity[]; activitiesHasMore: boolean;
}
export interface ServiceOptions { employees: ServiceEmployee[]; suggestedPrimaryId: string|null }
