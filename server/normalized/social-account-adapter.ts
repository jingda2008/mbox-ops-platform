import {createHash} from 'node:crypto'
import {z} from 'zod'
export const socialCredentialsSchema=z.object({secret:z.string().min(8).max(256),token:z.string().regex(/^[A-Za-z0-9]{3,32}$/),encodingAesKey:z.string().regex(/^[A-Za-z0-9]{43}$/)}).strict()
export type SocialCredentials=z.infer<typeof socialCredentialsSchema>
export interface SocialAccount{id:string;kind:'service_account'|'wecom';app_id:string;enabled:boolean;code_template_id:string|null;code_data_key:string;reminder_template_id:string|null;reminder_data_key:string}
export type SocialDeliveryResult={status:'accepted'|'rejected'|'unknown';providerReference:string|null;errorCode:string|null}
export class SocialProviderError extends Error{constructor(readonly code:string){super('微信平台请求未成功')}}
/** Fixed official endpoints only; no credentials or provider response bodies in errors. */
const tokenCaches=new WeakMap<typeof fetch,Map<string,{value:string;until:number}>>()
const tokenFlights=new WeakMap<typeof fetch,Map<string,Promise<string>>>()
function messageReference(value:unknown):string|null{return (typeof value==='string'||(typeof value==='number'&&Number.isSafeInteger(value)))&&/^[0-9]{1,30}$/.test(String(value))?String(value):null}
export class OfficialSocialAccountAdapter{
 constructor(private readonly account:SocialAccount,private readonly credentials:SocialCredentials,private readonly request:typeof fetch=fetch){}
 private async json(url:string,body?:unknown):Promise<Record<string,unknown>>{
  const response=await this.request(url,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)})
  if(!response.ok)throw new SocialProviderError(`HTTP_${response.status}`)
  const value=JSON.parse((await response.text()).replace(/("(?:msgid|msg_id)"\s*:\s*)([0-9]{16,})(?=\s*[,}])/g,'$1"$2"'));if(!value||typeof value!=='object'||Array.isArray(value))throw new SocialProviderError('INVALID_RESPONSE')
  const record=value as Record<string,unknown>;if(record.errcode!==undefined&&record.errcode!==0)throw new SocialProviderError(`WECHAT_${String(record.errcode).replace(/[^0-9-]/g,'')}`)
  return record
 }
 private async accessToken():Promise<string>{
  const key=createHash('sha256').update(`${this.account.id}:${this.account.app_id}:${this.account.kind}:${this.credentials.secret}`).digest('hex')
  let cache=tokenCaches.get(this.request);if(!cache){cache=new Map();tokenCaches.set(this.request,cache)}
  for(const [id,entry] of cache)if(entry.until<=Date.now())cache.delete(id)
  const cached=cache.get(key);if(cached)return cached.value
  let flights=tokenFlights.get(this.request);if(!flights){flights=new Map();tokenFlights.set(this.request,flights)}
  const pending=flights.get(key);if(pending)return pending
  const operation=(async()=>{
   const url=this.account.kind==='service_account'?`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(this.account.app_id)}&secret=${encodeURIComponent(this.credentials.secret)}`:`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.account.app_id)}&corpsecret=${encodeURIComponent(this.credentials.secret)}`
   const result=await this.json(url);if(typeof result.access_token!=='string'||typeof result.expires_in!=='number')throw new SocialProviderError('TOKEN_INVALID')
   cache!.set(key,{value:result.access_token,until:Date.now()+Math.max(0,result.expires_in-120)*1000});return result.access_token
  })().finally(()=>flights!.delete(key));flights.set(key,operation);return operation
 }

 async user(externalId:string){
  const token=await this.accessToken()
  if(this.account.kind==='service_account'){
   const result=await this.json(`https://api.weixin.qq.com/cgi-bin/user/info?access_token=${encodeURIComponent(token)}&openid=${encodeURIComponent(externalId)}&lang=zh_CN`)
   return{unionId:typeof result.unionid==='string'?result.unionid:null,active:result.subscribe===1}
  }
  const result=await this.json(`https://qyapi.weixin.qq.com/cgi-bin/externalcontact/get?access_token=${encodeURIComponent(token)}&external_userid=${encodeURIComponent(externalId)}`)
  const external=result.external_contact as Record<string,unknown>|undefined
  const followers=Array.isArray(result.follow_user)?result.follow_user as {userid?:string}[]:[]
  return{unionId:typeof external?.unionid==='string'?external.unionid:null,active:followers.length>0,followers:followers.map(item=>item.userid).filter((value):value is string=>typeof value==='string')}
 }
 async sendBroadcast(content:string):Promise<SocialDeliveryResult>{
  if(this.account.kind!=='service_account'||!this.account.enabled)return{status:'rejected',providerReference:null,errorCode:'ACCOUNT_DISABLED'}
  let token:string;try{token=await this.accessToken()}catch{return{status:'rejected',providerReference:null,errorCode:'TOKEN_UNAVAILABLE'}}
  try{const result=await this.json(`https://api.weixin.qq.com/cgi-bin/message/mass/sendall?access_token=${encodeURIComponent(token)}`,{filter:{is_to_all:true},msgtype:'text',text:{content}})
   const reference=messageReference(result.msg_id);return reference===null?{status:'unknown',providerReference:null,errorCode:'MISSING_RECEIPT'}:{status:'accepted',providerReference:reference,errorCode:null}
  }catch(error){return error instanceof SocialProviderError&&error.code.startsWith('WECHAT_')?{status:'rejected',providerReference:null,errorCode:error.code}:{status:'unknown',providerReference:null,errorCode:'DELIVERY_OUTCOME_UNKNOWN'}}
 }
 async sendTemplate(openId:string,templateId:string,data:Record<string,string>):Promise<SocialDeliveryResult>{
  if(this.account.kind!=='service_account'||!this.account.enabled)return{status:'rejected',providerReference:null,errorCode:'ACCOUNT_DISABLED'}
  let token:string;try{token=await this.accessToken()}catch{return{status:'rejected',providerReference:null,errorCode:'TOKEN_UNAVAILABLE'}}
  try{
   const result=await this.json(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`,{touser:openId,template_id:templateId,data:Object.fromEntries(Object.entries(data).map(([key,value])=>[key,{value}]))})
   const reference=messageReference(result.msgid);if(reference===null)return{status:'unknown',providerReference:null,errorCode:'MISSING_RECEIPT'}
   return{status:'accepted',providerReference:reference,errorCode:null}
  }catch(error){return error instanceof SocialProviderError&&error.code.startsWith('WECHAT_')?{status:'rejected',providerReference:null,errorCode:error.code}:{status:'unknown',providerReference:null,errorCode:'DELIVERY_OUTCOME_UNKNOWN'}}
 }
}
