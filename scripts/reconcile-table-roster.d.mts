import type {Client,PoolClient} from 'pg'
export interface DesiredTable {code:string;areaCode:string;capacity:number}
export function normalizedTableCode(code:string):string
export function reconcileTableRoster(client:Client|PoolClient,scope:{tenantId:string;storeId:string},roster:DesiredTable[]):Promise<{
 desiredCount:number;
 changes:Array<{id:string;action:string;beforeCode:string|null;code:string;beforeStatus:string|null;status:string}>;
 deferred:Array<{code:string;visits:number;reservations:number}>;
 desired:Array<{id:string;code:string;display_name:string;capacity:number;status:string}>;
}>
