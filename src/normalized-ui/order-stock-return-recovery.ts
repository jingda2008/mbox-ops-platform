import type {NormalizedApiClient} from '../normalized-api'
import {executeRecoverableCommand} from './recoverable-command'

export type StockReturnBody={quantity:number;disposition:'unmade'|'returned_unopened';reason:string;unopenedConfirmed:boolean}
type Attempt={key:string;body:StockReturnBody;recordId:string|null;label?:string}
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>
const memory=new Map<string,Attempt>()
const flights=new Map<string,Promise<string>>()

/** Original payload survives feedback loss; confirmed stock changes remain
 * locked until their remaining quantity has actually been read back. */
export class OrderStockReturnRecovery {
  private readonly endpoint:string
  private readonly namespace:string
  private readonly storageKey:string
  private readonly api:Pick<NormalizedApiClient,'postEndpoint'>
  private readonly storage:StoragePort|undefined
  private readonly label:string|undefined
  constructor(api:Pick<NormalizedApiClient,'postEndpoint'>,employeeId:string,itemId:string,storage:StoragePort|undefined=optionalStorage(),label?:string){
    this.api=api;this.storage=storage;this.label=label
    this.endpoint=`/api/operations/order-items/${encodeURIComponent(itemId)}/stock-return`
    this.namespace=`${employeeId}:${this.endpoint}`
    this.storageKey=`mbox-stock-return-recovery-v1:${this.namespace}`
  }
  pending():Attempt|null{
    try{
      const text=this.storage?.getItem(this.storageKey),value=text?JSON.parse(text):null
      if(value&&typeof value.key==='string'&&value.body&&Number.isSafeInteger(value.body.quantity)&&value.body.quantity>0
        &&['unmade','returned_unopened'].includes(value.body.disposition)&&typeof value.body.reason==='string'&&value.body.unopenedConfirmed===true
        &&(value.recordId===null||typeof value.recordId==='string'))return value as Attempt
    }catch{/* The same-tab recovery record remains available. */}
    return memory.get(this.storageKey)??null
  }
  async submit(body:StockReturnBody){
    const previous=this.pending()
    if(previous?.recordId)throw new Error('退库已成功，请先刷新剩余数量，不要再次登记')
    if(previous&&JSON.stringify(previous.body)!==JSON.stringify(body))throw new Error('请先恢复原退库结果，再更改数量或实际情况')
    const running=flights.get(this.storageKey)
    if(running)return running
    const attempt=previous??{key:crypto.randomUUID(),body,recordId:null,...(this.label?{label:this.label}:{})}
    this.save(attempt)
    const execution=executeRecoverableCommand(this.namespace,attempt.body,attempt.key,async key=>{
      // Also migrates an older same-body recoverable-command key before sending.
      attempt.key=key;this.save(attempt)
      const result=await this.api.postEndpoint<{id:string}>(this.endpoint,attempt.body,{idempotencyKey:key})
      if(!result||typeof result.id!=='string')throw new Error('退库回执暂未读全，请恢复原登记结果')
      return result.id
    }).then(id=>{this.save({...attempt,recordId:id});return id}).catch((error:unknown)=>{
      const status=error&&typeof error==='object'&&'status' in error?error.status:null
      // Authorization/validation refusals are definite; conflict and unknown
      // results retain the original intent, as on the existing endpoint.
      const code=error&&typeof error==='object'&&'code' in error?error.code:null
      if(typeof status==='number'&&[400,403,404].includes(status)||status===409&&code==='STOCK_RETURN_CONFLICT')this.clear()
      throw error
    }).finally(()=>{flights.delete(this.storageKey)})
    flights.set(this.storageKey,execution)
    return execution
  }
  recover(){const original=this.pending();if(!original)throw new Error('没有待恢复的退库登记');return original.recordId?Promise.resolve(original.recordId):this.submit(original.body)}
  async refresh(readRemaining:()=>Promise<void>){
    const original=this.pending()
    if(!original?.recordId)throw new Error('请先确认原退库结果')
    await readRemaining()
    if(this.pending()?.key===original.key)this.clear()
  }
  private save(value:Attempt){memory.set(this.storageKey,value);try{this.storage?.setItem(this.storageKey,JSON.stringify(value))}catch{/* Retain in memory. */}notifyChanged()}
  private clear(){memory.delete(this.storageKey);try{this.storage?.removeItem(this.storageKey)}catch{/* Retain no stale in-memory record. */}notifyChanged()}
}
function optionalStorage(){try{return typeof sessionStorage==='undefined'?undefined:sessionStorage}catch{return undefined}}

function notifyChanged(){if(typeof window!=='undefined')window.dispatchEvent(new Event('mbox-stock-return-recovery-changed'))}
export function pendingStockReturns(employeeId:string){
  const storage=optionalStorage(),prefix=`mbox-stock-return-recovery-v1:${employeeId}:/api/operations/order-items/`
  const keys=new Set([...memory.keys()].filter(key=>key.startsWith(prefix)))
  try{if(storage)for(let index=0;index<storage.length;index++){const key=storage.key(index);if(key?.startsWith(prefix))keys.add(key)}}catch{/* Same-tab memory still lists work. */}
  const pending:Array<{itemId:string;label:string}>=[]
  for(const key of keys){
    const itemId=key.slice(prefix.length).replace(/\/stock-return$/,'')
    if(!/^[0-9a-f-]{36}$/i.test(itemId))continue
    try{
      const text=storage?.getItem(key),value=text?JSON.parse(text):memory.get(key)
      if(value&&typeof value.key==='string'&&value.body&&Number.isSafeInteger(value.body.quantity)&&value.body.quantity>0)pending.push({itemId,label:typeof value.label==='string'?value.label:'原商品退库'})
    }catch{/* Malformed local data cannot become an operation. */}
  }
  return pending
}
