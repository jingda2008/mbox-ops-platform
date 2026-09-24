export type ThreeScreenMode='bar'|'kitchen'|'pickup'
/** The pickup-only account cannot load the dashboard required by the legacy page. */
export function pickupOnlyEntry(pathname:string,search:string,permissions:readonly string[]):ThreeScreenMode|null {
  if(pathname!=='/staff/fulfillment'||new URLSearchParams(search).has('screen'))return null
  return permissions.includes('kds.deliver')&&!permissions.includes('dashboard.view')&&!permissions.includes('kds.prepare')?'pickup':null
}
export function productionEntry(search:string,actor:{roleCodes?:readonly string[];allowedStations:readonly string[];threeScreenWorkflowEnabled?:boolean;sharedPickupActive?:boolean}):'bar'|'kitchen'|null {
  if(new URLSearchParams(search).size>0||!(actor.threeScreenWorkflowEnabled||actor.sharedPickupActive))return null
  const roles=actor.roleCodes??[]
  if(roles.includes('KITCHEN')&&!roles.includes('BARTENDER')&&actor.allowedStations.includes('kitchen'))return 'kitchen'
  if(roles.includes('BARTENDER')&&!roles.includes('KITCHEN')&&actor.allowedStations.includes('bar'))return 'bar'
  return null
}
export function threeScreenMode(pathname:string,search:string):ThreeScreenMode|null {
  if(pathname!=='/staff/fulfillment')return null
  const mode=new URLSearchParams(search).get('screen')
  return mode==='bar'||mode==='kitchen'||mode==='pickup'?mode:null
}
