import { createPrivateKey, sign } from 'node:crypto'
import { connect } from 'node:http2'
import type { NativePushConfig } from './native-push-config.js'

export type NativePushDeliveryOutcome =
  | {status:'provider_accepted'}
  | {status:'retry';code:string;retryAfterSeconds:number}
  | {status:'unknown';code:string}
  | {status:'rejected';code:string;invalidToken?:boolean;configurationFailure?:boolean}
export interface NativePushSendRequest {token:string;requestId:string;deliveryId:string;expiresAt:string}
export interface NativePushSender {send(request:NativePushSendRequest):Promise<NativePushDeliveryOutcome>}
export interface ApnsWireRequest {origin:string;headers:Record<string,string>;body:string}
export type ApnsWireResult = {kind:'response';status:number;headers:Record<string,string>;body:string}|{kind:'not_sent'}|{kind:'unknown'}
export type ApnsTransport = (request:ApnsWireRequest)=>Promise<ApnsWireResult>

/** Wire injection is a test seam; runtime configuration never supplies a host or transport. */
export class OfficialApnsAdapter implements NativePushSender {
  private jwt: {value:string;issuedAt:number}|null=null
  private readonly signingKey
  constructor(private readonly config:NativePushConfig,private readonly transport:ApnsTransport=sendApnsHttp2,private readonly now:()=>number=Date.now) {
    this.signingKey=createPrivateKey(config.privateKey)
  }
  async send(request:NativePushSendRequest):Promise<NativePushDeliveryOutcome> {
    const now=Math.floor(this.now()/1000),expires=Math.floor(Date.parse(request.expiresAt)/1000)
    if(!Number.isFinite(expires)||expires<=now)return {status:'rejected',code:'EVENT_EXPIRED'}
    if(!this.jwt || now-this.jwt.issuedAt>=50*60 || now<this.jwt.issuedAt) {
      const header=Buffer.from(JSON.stringify({alg:'ES256',kid:this.config.keyId})).toString('base64url')
      const claims=Buffer.from(JSON.stringify({iss:this.config.teamId,iat:now})).toString('base64url')
      const input=header+'.'+claims
      this.jwt={value:input+'.'+sign('sha256',Buffer.from(input),{key:this.signingKey,dsaEncoding:'ieee-p1363'}).toString('base64url'),issuedAt:now}
    }
    const wire:ApnsWireRequest={origin:this.config.environment==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com',headers:{
      ':method':'POST',':path':'/3/device/'+request.token,authorization:'bearer '+this.jwt.value,
      'apns-topic':this.config.topic,'apns-push-type':'alert','apns-priority':'10','apns-id':request.requestId,
      'apns-expiration':String(expires),'apns-collapse-id':request.deliveryId,'content-type':'application/json',
    },body:JSON.stringify({aps:{alert:{title:'M-BOX 服务待办',body:'有待处理事项，请打开工作台核对最新状态'},sound:'default'},mbox:{protocol:1,kind:'service_task',deliveryId:request.deliveryId}})}
    let response:ApnsWireResult
    try{response=await this.transport(wire)}catch{return {status:'unknown',code:'APNS_TRANSPORT_UNKNOWN'}}
    if(response.kind==='not_sent')return {status:'retry',code:'APNS_NOT_SENT',retryAfterSeconds:5}
    if(response.kind==='unknown')return {status:'unknown',code:'APNS_TRANSPORT_UNKNOWN'}
    if(response.headers['apns-id'] && response.headers['apns-id'].toLowerCase()!==request.requestId.toLowerCase())return {status:'unknown',code:'APNS_RECEIPT_MISMATCH'}
    if(response.status===200)return response.headers['apns-id']?{status:'provider_accepted'}:{status:'unknown',code:'APNS_RECEIPT_MISSING'}
    let reason=''
    try{const parsed=JSON.parse(response.body);if(typeof parsed.reason==='string')reason=parsed.reason}catch{ /* Never log the provider body. */ }
    if(response.status===410&&reason==='Unregistered'||response.status===400&&['BadDeviceToken','DeviceTokenNotForTopic'].includes(reason))return {status:'rejected',code:'APNS_TOKEN_INVALID',invalidToken:true}
    if([429,500,503].includes(response.status)) {
      const seconds=Number(response.headers['retry-after']),date=Date.parse(response.headers['retry-after']??'')
      const wait=Number.isFinite(seconds)?seconds:Number.isFinite(date)?Math.ceil(date/1000-now):30
      return {status:'retry',code:'APNS_RETRYABLE',retryAfterSeconds:Math.max(1,Math.min(900,wait))}
    }
    if(response.status===403||['BadTopic','MissingTopic','TopicDisallowed','BadCertificate','BadCertificateEnvironment'].includes(reason))return {status:'rejected',code:'APNS_CONFIGURATION_REJECTED',configurationFailure:true}
    return {status:'rejected',code:'APNS_REQUEST_REJECTED'}
  }
}

/** A stream created before failure is conservatively unknown; no automatic duplicate notification. */
export function sendApnsHttp2(request:ApnsWireRequest):Promise<ApnsWireResult> {
  if(!['https://api.sandbox.push.apple.com','https://api.push.apple.com'].includes(request.origin))return Promise.resolve({kind:'not_sent'})
  return new Promise(resolve=>{
    let settled=false,streamStarted=false
    const client=connect(request.origin,{rejectUnauthorized:true})
    const finish=(value:ApnsWireResult)=>{if(settled)return;settled=true;clearTimeout(timer);client.destroy();resolve(value)}
    const failed=()=>finish({kind:streamStarted?'unknown':'not_sent'})
    const timer=setTimeout(failed,10_000);timer.unref()
    client.on('error',failed);client.on('goaway',failed);client.on('close',failed)
    client.once('connect',()=>{
      if(settled)return
      try{
        const stream=client.request(request.headers);streamStarted=true
        let status=0,body='',length=0,headers:Record<string,string>={}
        stream.on('response',response=>{status=Number(response[':status']);for(const key of ['apns-id','retry-after'])if(typeof response[key]==='string')headers[key]=response[key]})
        stream.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>4096)failed();else body+=chunk.toString('utf8')})
        stream.on('error',failed);stream.on('end',()=>finish(status>0?{kind:'response',status,headers,body}:{kind:'unknown'}));stream.on('close',failed)
        stream.end(request.body)
      }catch{failed()}
    })
  })
}
