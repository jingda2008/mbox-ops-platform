type StoredAttempt<B,R>={key:string;body:B;result?:R}
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>
const memory=new Map<string,unknown>()
const flights=new Map<string,Promise<unknown>>()
/** One unresolved intent per employee/workflow. A new body cannot replace an unknown result. */
export class DurableStaffCommand<B,R>{
  private readonly requirePersistent:boolean
  private readonly storageKey:string
  private readonly send:(body:B,key:string)=>Promise<R>
  private readonly storage:StoragePort|undefined
  constructor(namespace:string,send:(body:B,key:string)=>Promise<R>,storage:StoragePort|undefined=optionalStorage(),requirePersistent=false){
    this.send=send;this.storage=storage;this.requirePersistent=requirePersistent
    this.storageKey=`mbox.staff-command.v1:${namespace}`
  }
  pending():StoredAttempt<B,R>|null{
    try{const text=this.storage?.getItem(this.storageKey);if(text){const value=JSON.parse(text);if(value&&typeof value.key==='string'&&'body' in value)return value}}
    catch{/* Same-tab memory remains available. */}
    return memory.get(this.storageKey) as StoredAttempt<B,R>??null
  }
  async submit(body:B):Promise<R>{
    const previous=this.pending()
    if(previous&&JSON.stringify(previous.body)!==JSON.stringify(body))throw new Error('原操作结果尚未核对，请先恢复原操作，再登记新的内容')
    if(previous&&'result' in previous)return previous.result as R
    const running=flights.get(this.storageKey);if(running)return running as Promise<R>
    const attempt=previous??{key:crypto.randomUUID(),body:structuredClone(body)}
    this.save(attempt)
    const request=this.send(attempt.body,attempt.key).then(result=>{this.save({...attempt,result});return result}).catch((error:unknown)=>{
      const details=error as {status?:number;code?:string}|null
      if(details&&([400,403,404,422].includes(details.status??0)||details.status===409&&!!details.code&&(!/(IDEMPOTENCY|IN_PROGRESS|TEMPORAR|UNAVAILABLE|INTERNAL)/.test(details.code)||['QUANTITY_UNAVAILABLE','TABLE_SESSION_UNAVAILABLE'].includes(details.code))))this.clear()
      throw error
    }).finally(()=>flights.delete(this.storageKey))
    flights.set(this.storageKey,request);return request
  }
  recover(){const previous=this.pending();if(!previous)throw new Error('没有待恢复的操作');return this.submit(previous.body)}
  async refresh(read:()=>Promise<void>){const previous=this.pending();if(!previous||!('result' in previous))throw new Error('请先恢复原操作结果');await read();if(this.pending()?.key===previous.key)this.clear()}
  private save(value:StoredAttempt<B,R>){if(this.requirePersistent){if(!this.storage)throw new Error('此设备无法保留操作记录，请恢复浏览器存储后再制作');this.storage.setItem(this.storageKey,JSON.stringify(value));memory.set(this.storageKey,value);return}memory.set(this.storageKey,value);try{this.storage?.setItem(this.storageKey,JSON.stringify(value))}catch{/* Memory protects retries when storage is unavailable. */}}
  private clear(){if(this.requirePersistent){this.storage?.removeItem(this.storageKey);memory.delete(this.storageKey);return}memory.delete(this.storageKey);try{this.storage?.removeItem(this.storageKey)}catch{/* Cleared in memory. */}}
}
// Keep an unresolved stock or publication intent when a staff member closes
// the tab. Employee/workflow namespacing prevents the next login taking it over.
function optionalStorage(){try{return typeof localStorage==='undefined'?undefined:localStorage}catch{return undefined}}
