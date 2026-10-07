import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'
import { authorizeNativePush, lockNativePushInstallation } from './native-push-repository.js'
import { readNativePushTaskTarget } from './operations-query-service.js'
import { NativePushError, type NativePushActor } from './native-push-contracts.js'
import { NativePushProtection } from './native-push-protection.js'
import type { NativePushConfig, GetuiPushConfig } from './native-push-config.js'
import type { NativePushSender, NativePushSendRequest, NativePushDeliveryOutcome } from './native-push-apns.js'

export interface NativePushBatch { workerId:string; projected:number; claimed:number; accepted:number; unknown:number; rejected:number; retry:number; cancelled:number; expired:number; configurationRejected:number }
type Binding=Record<string,unknown>&{provider:'apns'|'getui';id:string;revision:string;employee_id:string;staff_session_id:string;device_access_lease_id:string;registered_at:Date;expires_at:Date;environment:string;topic:string;token_ciphertext:Buffer;token_key_id:string}
type Event=Record<string,unknown>&{id:string;task_id:string;table_session_id:string;occurred_at:Date;expires_at:Date}
const scoped=(scope:StoreScope)=>[scope.tenantId,scope.storeId]
const actor=(scope:StoreScope,b:Binding):NativePushActor=>({scope,employeeId:b.employee_id,staffSessionId:b.staff_session_id,deviceAccessLeaseId:b.device_access_lease_id,businessDate:new Date().toISOString().slice(0,10)})
function denied(error:unknown) {return error instanceof NativePushError&&[401,403].includes(error.statusCode) || error instanceof Error&&['StaffAccessDeniedError','StaffNotFoundError'].includes(error.name)}
export class NativePushWorker {
  private readonly providers = new Map<string,{config:NativePushConfig|GetuiPushConfig;protection:NativePushProtection;sender:NativePushSender}>()
  constructor(private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>,config:NativePushConfig|null,hashSecret:string,sender:NativePushSender|null,getuiConfig:GetuiPushConfig|null=null,getuiSender:NativePushSender|null=null) {
    if(config&&sender)this.providers.set('apns',{config,protection:new NativePushProtection(config.tokenKey,config.tokenKeyId,hashSecret),sender})
    if(getuiConfig&&getuiSender)this.providers.set('getui',{config:getuiConfig,protection:new NativePushProtection(getuiConfig.tokenKey,getuiConfig.tokenKeyId,hashSecret),sender:getuiSender})
  }
  async runBatch(scope:StoreScope,workerId:string):Promise<NativePushBatch> {
    const result:NativePushBatch={workerId,projected:0,claimed:0,accepted:0,unknown:0,rejected:0,retry:0,cancelled:0,expired:0,configurationRejected:0}
    // A crashed sender may already have reached APNs. Never turn its stale claim into a retry.
    result.unknown=await this.transactions.run(scope,async tx=>(await tx.query("UPDATE mbox.native_push_deliveries SET status='unknown',locked_by=NULL,locked_at=NULL,failure_code='SENDER_INTERRUPTED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND status='sending' AND locked_at<clock_timestamp()-interval '1 minute'",scoped(scope))).rowCount??0)
    result.projected=await this.project(scope)
    const candidates=await this.transactions.run(scope,tx=>tx.query<{id:string;installation_id:string}>("SELECT id,installation_id FROM mbox.native_push_deliveries WHERE tenant_id=$1 AND store_id=$2 AND status IN('pending','retry') AND available_at<=clock_timestamp() ORDER BY available_at,id LIMIT 20",scoped(scope)),{readOnly:true})
    for(const candidate of candidates.rows) {
      const prepared=await this.prepare(scope,candidate.id,candidate.installation_id,workerId)
      if(prepared===null)continue
      if(typeof prepared==='string'){result[prepared]++;continue}
      result.claimed++
      let outcome:NativePushDeliveryOutcome
      try{outcome=await prepared.sender.send(prepared.request)}catch{outcome={status:'unknown',code:'PUSH_TRANSPORT_UNKNOWN'}}
      await this.finish(scope,candidate.id,candidate.installation_id,prepared.revision,workerId,outcome)
      if(outcome.status==='provider_accepted')result.accepted++;else result[outcome.status]++
      if(outcome.status==='rejected'&&outcome.configurationFailure)result.configurationRejected++
    }
    return result
  }
  private project(scope:StoreScope) {return this.transactions.run(scope,async tx=>{
    const events=await tx.query<Event>('SELECT * FROM mbox.native_push_events WHERE tenant_id=$1 AND store_id=$2 AND projected_at IS NULL ORDER BY occurred_at,id LIMIT 20 FOR UPDATE SKIP LOCKED',scoped(scope))
    for(const event of events.rows) {
      const live=(await tx.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()',[event.expires_at])).rowCount===1
      if(live) {
        const bindings=await tx.query<Binding>("SELECT * FROM mbox.native_push_installations WHERE tenant_id=$1 AND store_id=$2 AND status='active' AND expires_at>clock_timestamp() AND registered_at<=$3 ORDER BY id",[...scoped(scope),event.occurred_at])
        for(const binding of bindings.rows) {
          const cfg=this.providers.get(binding.provider)?.config
          if(!cfg||binding.environment!==cfg.environment||binding.topic!==cfg.topic)continue
          if(!(await tx.query('SELECT 1 WHERE $1::timestamptz+make_interval(secs=>$2)>clock_timestamp()',[event.occurred_at,cfg.eventTtlSeconds])).rowCount)continue
          const who=actor(scope,binding)
          try{await authorizeNativePush(tx,who)}catch(error){if(denied(error))continue;throw error}
          if(!await readNativePushTaskTarget(tx,who.employeeId,event.task_id,event.table_session_id))continue
          // A binding changed during this transaction is simply not projected; the registration reads current tasks.
          await tx.query(`INSERT INTO mbox.native_push_deliveries(tenant_id,store_id,event_id,installation_id,binding_revision,employee_id,staff_session_id)
            SELECT $1,$2,$3,i.id,i.revision,i.employee_id,i.staff_session_id FROM mbox.native_push_installations i
            WHERE i.tenant_id=$1 AND i.store_id=$2 AND i.id=$4 AND i.revision=$5 AND i.status='active'
            ON CONFLICT(tenant_id,store_id,event_id,installation_id,binding_revision) DO NOTHING`,[...scoped(scope),event.id,binding.id,binding.revision])
        }
      }
      await tx.query('UPDATE mbox.native_push_events SET projected_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scoped(scope),event.id])
    }
    return events.rowCount??0
  }) }
  private prepare(scope:StoreScope,id:string,installationId:string,workerId:string) {return this.transactions.run(scope,async tx=>{
    // Same order as register/revoke: installation guard, access configuration, session, delivery.
    await lockNativePushInstallation(tx,installationId)
    const binding=(await tx.query<Binding>("SELECT * FROM mbox.native_push_installations WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active'",[...scoped(scope),installationId])).rows[0]
    const provider=binding?this.providers.get(binding.provider):undefined
    let authorized=true,currentExpiry=binding?.expires_at
    if(binding)try{currentExpiry=(await authorizeNativePush(tx,actor(scope,binding),true)).expires_at}catch(error){if(denied(error))authorized=false;else throw error}
    const delivery=(await tx.query<Record<string,unknown>&{binding_revision:string;employee_id:string;staff_session_id:string;attempts:number;event_id:string}>("SELECT * FROM mbox.native_push_deliveries WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN('pending','retry') AND available_at<=clock_timestamp() FOR UPDATE",[...scoped(scope),id])).rows[0]
    if(!delivery)return null
    if(!binding||!provider||!authorized||binding.revision!==delivery.binding_revision||binding.employee_id!==delivery.employee_id||binding.staff_session_id!==delivery.staff_session_id||binding.environment!==provider.config.environment||binding.topic!==provider.config.topic) {await this.terminal(tx,id,'cancelled','BINDING_NOT_CURRENT');return 'cancelled' as const}
    const event=(await tx.query<Event>('SELECT * FROM mbox.native_push_events WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scoped(scope),delivery.event_id])).rows[0]!
    const deadline=(await tx.query<{expires_at:Date;live:boolean}>(`SELECT LEAST($1::timestamptz,$2::timestamptz,$3::timestamptz+make_interval(secs=>$4)) AS expires_at,
      LEAST($1::timestamptz,$2::timestamptz,$3::timestamptz+make_interval(secs=>$4))>clock_timestamp() AS live`,[event.expires_at,new Date(Math.min(binding.expires_at.getTime(),currentExpiry!.getTime())),event.occurred_at,provider.config.eventTtlSeconds])).rows[0]!
    if(!deadline.live||delivery.attempts>=10){await this.terminal(tx,id,'expired','EVENT_EXPIRED');return 'expired' as const}
    if(!await readNativePushTaskTarget(tx,binding.employee_id,event.task_id,event.table_session_id)){await this.terminal(tx,id,'cancelled','TARGET_NOT_CURRENT');return 'cancelled' as const}
    let token:string
    try{token=provider.protection.reveal(binding.token_ciphertext,binding.token_key_id,scope,binding.id,Number(binding.revision))}catch{await tx.query("UPDATE mbox.native_push_installations SET status='revoked',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND revision=$4",[...scoped(scope),installationId,binding.revision]);await this.terminal(tx,id,'cancelled','TOKEN_KEY_UNAVAILABLE');return 'cancelled' as const}
    const claimed=await tx.query<{provider_request_id:string}>("UPDATE mbox.native_push_deliveries SET status='sending',attempts=attempts+1,locked_by=$4,locked_at=clock_timestamp(),failure_code=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING provider_request_id",[...scoped(scope),id,workerId])
    return {sender:provider.sender,revision:Number(binding.revision),request:{token,requestId:claimed.rows[0]!.provider_request_id,deliveryId:id,expiresAt:deadline.expires_at.toISOString()} satisfies NativePushSendRequest}
  }) }
  private async terminal(tx:ScopedTransaction,id:string,status:'cancelled'|'expired',code:string) {await tx.query('UPDATE mbox.native_push_deliveries SET status=$4,failure_code=$5,locked_by=NULL,locked_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scoped(tx.scope),id,status,code])}
  private finish(scope:StoreScope,id:string,installationId:string,revision:number,workerId:string,outcome:NativePushDeliveryOutcome) {return this.transactions.run(scope,async tx=>{
    await lockNativePushInstallation(tx,installationId)
    const result=await tx.query(`UPDATE mbox.native_push_deliveries SET status=$5,locked_by=NULL,locked_at=NULL,
      provider_accepted_at=CASE WHEN $5='provider_accepted' THEN clock_timestamp() ELSE NULL END,failure_code=$6,
      available_at=clock_timestamp()+make_interval(secs=>$7),updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='sending' AND locked_by=$4 RETURNING id`,[...scoped(scope),id,workerId,outcome.status,'code' in outcome?outcome.code:null,outcome.status==='retry'?outcome.retryAfterSeconds:0])
    if(result.rowCount&&outcome.status==='rejected'&&outcome.invalidToken)await tx.query("UPDATE mbox.native_push_installations SET status='invalid_token',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND revision=$4 AND status='active'",[...scoped(scope),installationId,revision])
  }) }
}
