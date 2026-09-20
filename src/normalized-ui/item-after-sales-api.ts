import type {ItemAfterSalesWorkspace,ItemAfterSalesPending,RemakePhysicalHandover} from '../shared/item-after-sales'
import {StaffActionsApiError} from './staff-actions/staff-actions-api'
import {STAFF_EMPLOYEE_BINDING_HEADER} from '../shared/staff-session-binding'
import {staffErrorMessage,staffUnavailableMessage} from '../shared/staff-error-message'

type Pending={key:string;url:string;body:Record<string,unknown>}
/** One outstanding command per product and employee; recovery retains the actual
 * original payload as well as its key even after a page reload. */
export class ItemAfterSalesApi {
  private readonly memory=new Map<string,Pending>()
  private readonly employeeId:string
  private readonly send:typeof fetch
  private readonly storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>|undefined
  constructor(employeeId:string,send:typeof fetch=(input,init)=>globalThis.fetch(input,init),storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>|undefined=defaultStorage()){
    this.employeeId=employeeId;this.send=send;this.storage=storage
  }
  read(itemId:string){return this.request<ItemAfterSalesWorkspace>(`/api/commerce/item-after-sales/items/${encodeURIComponent(itemId)}`)}
  access(){return this.request<{enabled:boolean;recoveryAvailable?:boolean;employeeId:string}>('/api/commerce/item-after-sales/access')}
  listPending(cursor?:{id:string;createdAt:string}){
    return this.request<ItemAfterSalesPending>(`/api/commerce/item-after-sales/pending${cursor?`?${new URLSearchParams({cursorId:cursor.id,createdAt:cursor.createdAt})}`:''}`)
  }
  listRemakeHandover(cursor?:{id:string;createdAt:string}){
    return this.request<RemakePhysicalHandover>(`/api/commerce/item-after-sales/remake-handover${cursor?`?${new URLSearchParams({cursorId:cursor.id,createdAt:cursor.createdAt})}`:''}`)
  }
  private storageKey(itemId:string){return `mbox-item-after-sales-v1:${this.employeeId}:${itemId}`}
  pending(itemId:string):Pending|null{
    try{
      const raw=this.storage?.getItem(this.storageKey(itemId)),stored=raw?JSON.parse(raw):null
      if(stored&&typeof stored.key==='string'&&typeof stored.url==='string'&&validCommandUrl(stored.url)&&stored.body&&typeof stored.body==='object'&&!Array.isArray(stored.body))return stored as Pending
    }catch{/* Current session memory remains available. */}
    return this.memory.get(itemId)??null
  }
  async act(itemId:string,url:string,body:Record<string,unknown>){
    if(!validCommandUrl(url))throw new Error('商品处理接口无效')
    const pending=this.pending(itemId)
    if(pending&&(pending.url!==url||JSON.stringify(pending.body)!==JSON.stringify(body)))throw new StaffActionsApiError('先恢复上次处理结果，再更换数量或操作','AFTER_SALES_ORIGINAL_PENDING',409)
    const attempt=pending??{url,body,key:`item-after-sales-${crypto.randomUUID()}`}
    this.memory.set(itemId,attempt)
    try{this.storage?.setItem(this.storageKey(itemId),JSON.stringify(attempt))}catch{/* Memory recovery is retained. */}
    try{
      if(attempt.url.startsWith('/api/refunds/')){
        // The original cash acknowledgement remains one recoverable UI action.
        // Each existing backend phase uses a stable key; neither phase is approval.
        if(attempt.body.succeeded!==true)throw new Error('必须确认现金已实际退付')
        await this.request(attempt.url.replace('/manual-result','/execute'),{method:'POST',body:'{}',headers:{'content-type':'application/json','idempotency-key':`${attempt.key}-begin`}})
      }
      const result=await this.request<unknown>(attempt.url,{method:'POST',body:JSON.stringify(attempt.body),headers:{'content-type':'application/json','idempotency-key':attempt.key}})
      this.clear(itemId);return result
    }catch(error){
      if(error instanceof StaffActionsApiError&&[400,403,404].includes(error.status??0))this.clear(itemId)
      else if(error instanceof StaffActionsApiError&&error.status===409&&[
        'QUANTITY_INVALID','QUANTITY_UNAVAILABLE','QUANTITY_FACTS_CONFLICT','PRICE_REVIEW_REQUIRED','PRODUCTION_REVIEW_REQUIRED','QUANTITY_BATCH_NOT_ENABLED',
      ].includes(error.code??''))this.clear(itemId)
      throw error
    }
  }
  recover(itemId:string){const pending=this.pending(itemId);return pending?this.act(itemId,pending.url,pending.body):Promise.resolve(null)}
  private clear(itemId:string){this.memory.delete(itemId);try{this.storage?.removeItem(this.storageKey(itemId))}catch{/* Memory remains cleared. */}}
  private async request<T>(url:string,init:RequestInit={}):Promise<T>{
    if(!url.startsWith('/api/commerce/item-after-sales/')&&!isRemakeCommandUrl(url)&&!/^\/api\/refunds\/[0-9a-f-]+\/(execute|manual-result)$/.test(url))throw new Error('商品处理接口无效')
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25_000)
    const headers=new Headers(init.headers)
    headers.set(STAFF_EMPLOYEE_BINDING_HEADER,this.employeeId)
    try{
      const response=await this.send(url,{...init,headers,credentials:'include',signal:controller.signal}),body=await response.json()
      if(!response.ok){
        const fallback=response.status>=500?staffUnavailableMessage(init.method??'GET'):response.status===401?'当前员工已切换或登录失效，请重新登录':'处理未完成，请核对原记录'
        throw new StaffActionsApiError(staffErrorMessage(body?.error?.message,fallback,response.status),body?.error?.code??'HTTP_ERROR',response.status)
      }
      if(!body||typeof body!=='object'||!('data' in body))throw new StaffActionsApiError('处理结果未能读取，请恢复原结果','INVALID_RESPONSE',null)
      return body.data as T
    }catch(error){if(error instanceof StaffActionsApiError)throw error;throw new StaffActionsApiError('处理结果待确认，请恢复原结果',controller.signal.aborted?'TIMEOUT':'NETWORK_ERROR',null)}
    finally{clearTimeout(timer)}
  }
}
function defaultStorage(){try{return typeof sessionStorage==='undefined'?undefined:sessionStorage}catch{return undefined}}

function isRemakeCommandUrl(url:string){return /^\/api\/commerce\/kds\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/remake$/.test(url)}
function validCommandUrl(url:string){return isRemakeCommandUrl(url)||/^\/api\/commerce\/item-after-sales\/(requests|remakes\/[0-9a-f-]+\/after-visit-physical|redeliveries|redeliveries\/[0-9a-f-]+\/(complete|cancel)|[0-9a-f-]+\/(decision|revision|resume|physical|notice-ack|resolve-unpaid|refund-retry))$/.test(url)||/^\/api\/refunds\/[0-9a-f-]+\/manual-result$/.test(url)}
