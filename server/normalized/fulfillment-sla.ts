export const DEFAULT_FULFILLMENT_SLA_SECONDS=Object.freeze({bar:300,kitchen:600,cashier:120,none:0})
/** Shared by order deadlines and read-only upgrade availability. */
export function fulfillmentDueAt(station:keyof typeof DEFAULT_FULFILLMENT_SLA_SECONDS,configuredSeconds:number|null,now=Date.now()):string|null{
 if(station==='none')return null
 return new Date(now+(configuredSeconds??DEFAULT_FULFILLMENT_SLA_SECONDS[station])*1000).toISOString()
}
