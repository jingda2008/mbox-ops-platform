export function requiresStaffLogin(error:unknown):boolean {
  if(typeof error!=='object'||error===null)return false
  const {status,code}=error as {status?:number;code?:string}
  return status===401||status===403&&(code==='PICKUP_SESSION_INVALID'||code==='KDS_SESSION_INVALID')
}
