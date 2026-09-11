import type { Client, PoolClient } from 'pg'
export const historicalPaymentDisplayAllowlist: Array<[string,string,number]>
export function repairHistoricalPaymentDisplays(client:Client|PoolClient,scope:{tenantId:string;storeId:string}):Promise<{before:Array<Record<string,unknown>>;changed:string[]}>
