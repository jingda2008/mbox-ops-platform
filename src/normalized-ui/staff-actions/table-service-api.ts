import { STAFF_SESSION_BINDING_HEADER } from '../../shared/staff-session-binding'
import type { ServiceTable, ServiceOptions, ServiceSession, ServiceDetail } from '../../shared/table-service'
import { executeRecoverableCommand } from '../recoverable-command'
export class TableServiceApiError extends Error {readonly status:number; readonly notCommitted:boolean; constructor(message:string,status:number,notCommitted=false){super(message);this.status=status;this.notCommitted=notCommitted}}
export class TableServiceApi {
 private readonly sessionId:string|undefined; private readonly send:typeof fetch
 constructor(sessionId?:string,send:typeof fetch=globalThis.fetch.bind(globalThis)){this.sessionId=sessionId;this.send=send}
 private async request<T>(path:string,init:RequestInit={}):Promise<T> {
  const headers=new Headers(init.headers);headers.set('accept','application/json')
  if(this.sessionId)headers.set(STAFF_SESSION_BINDING_HEADER,this.sessionId)
  const response=await this.send(`/api/table-service/${path}`,{...init,headers,credentials:'include',signal:init.signal??AbortSignal.timeout(12000)})
  const json=await response.json()
  if(!response.ok)throw new TableServiceApiError(json.error?.message??'服务记录读取失败',response.status,json.error?.commitDisposition==='not_committed')
  return json.data as T
 }
 tables(signal?:AbortSignal){return this.request<ServiceTable[]>('tables',{signal})}
 options(tableId:string,signal?:AbortSignal){return this.request<ServiceOptions>(`tables/${encodeURIComponent(tableId)}/options`,{signal})}
 sessions(tableId:string,page=0,signal?:AbortSignal){return this.request<{sessions:ServiceSession[];hasMore:boolean}>(`tables/${encodeURIComponent(tableId)}/sessions?page=${page}`,{signal})}
 detail(id:string,changesPage=0,activitiesPage=0,signal?:AbortSignal){return this.request<ServiceDetail>(`sessions/${encodeURIComponent(id)}?changesPage=${changesPage}&activitiesPage=${activitiesPage}`,{signal})}
 handover(id:string,input:{employeeId:string;expectedRevision:number;reason:string}){
  return executeRecoverableCommand(`table-service:${this.sessionId}:${id}`,input,`service-${crypto.randomUUID()}`,key=>this.request<{sessionId:string;revision:number}>(`sessions/${encodeURIComponent(id)}/handover`,{
   method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(input),
  }))
 }
}
