import { createHmac, timingSafeEqual } from 'node:crypto'
import { NormalizedCommandExecutor, type JsonCodec, type JsonObject } from './command-executor.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import { lockStaffAccessConfiguration } from './staff-access-version.js'
import { readNativePushTaskTarget } from './operations-query-service.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'
import type { NativePushConfig } from './native-push-config.js'
import { NativePushProtection, revocationHash } from './native-push-protection.js'
import { NativePushError, NATIVE_PUSH_PERMISSIONS, nativePushIdentity, type NativePushActor, type NativePushInstallationReceipt, type NativePushInstallationState, type NativePushRegistration } from './native-push-contracts.js'

type Installation = Record<string, unknown> & { id: string; revision: string; status: 'active'|'revoked'|'invalid_token'; employee_id: string; staff_session_id: string; device_access_lease_id: string; device_key_hash: string; expires_at: Date; last_request_key: string; revocation_hash: string; expired: boolean }
const codec = <T>(): JsonCodec<T> => ({ encode: value => JSON.parse(JSON.stringify(value)) as JsonObject, decode: value => value as T })
export async function lockNativePushInstallation(tx: ScopedTransaction, id: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('native-push:'||$1::text||':'||$2::text||':'||$3::text,0))", [tx.scope.tenantId, tx.scope.storeId, id])
}
/** No foreground heartbeat requirement: a valid authenticated session may be in the background. */
export async function authorizeNativePush(tx: ScopedTransaction, actor: NativePushActor, lock = false) {
  if (lock) await lockStaffAccessConfiguration(tx)
  const row = (await tx.query<{device_key_hash: string; expires_at: Date}>(`
    SELECT dl.device_key_hash,LEAST(ss.expires_at,dl.expires_at,dc.valid_until) AS expires_at
    FROM mbox.staff_sessions ss
    JOIN mbox.employees e ON (e.tenant_id,e.store_id,e.id)=(ss.tenant_id,ss.store_id,ss.employee_id)
    JOIN mbox.store_device_access_leases dl ON (dl.tenant_id,dl.store_id,dl.id)=(ss.tenant_id,ss.store_id,ss.device_access_lease_id)
    JOIN mbox.store_daily_credentials dc ON (dc.tenant_id,dc.store_id,dc.id)=(dl.tenant_id,dl.store_id,dl.daily_credential_id)
    WHERE ss.tenant_id=$1 AND ss.store_id=$2 AND ss.id=$3 AND ss.employee_id=$4 AND ss.device_access_lease_id=$5
      AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp() AND e.status='active'
      AND dl.revoked_at IS NULL AND dl.expires_at>clock_timestamp()
      AND dc.revoked_at IS NULL AND dc.valid_from<=clock_timestamp() AND dc.valid_until>clock_timestamp()
    ${lock ? 'FOR SHARE OF ss,dl,dc,e' : ''}`, [tx.scope.tenantId,tx.scope.storeId,actor.staffSessionId,actor.employeeId,actor.deviceAccessLeaseId])).rows[0]
  if (!row) throw new NativePushError('AUTH_REQUIRED',401)
  const access = await new StaffAccessRepository(tx).resolve(actor.employeeId)
  if (!NATIVE_PUSH_PERMISSIONS.some(p => access.permissions.includes(p))) throw new NativePushError('PUSH_FORBIDDEN',403)
  return row
}
function state(row: Installation, actor: NativePushActor): NativePushInstallationState {
  const bound = row.employee_id === actor.employeeId && row.staff_session_id === actor.staffSessionId && row.device_access_lease_id === actor.deviceAccessLeaseId
  return { installationId: row.id, revision: Number(row.revision), status: row.status === 'active' && row.expired ? 'expired' : row.status,
    boundToCurrentSession: bound, expiresAt: row.expires_at.toISOString(), lastRequestKey: bound ? row.last_request_key : null }
}
async function installation(tx: ScopedTransaction, id: string): Promise<Installation | undefined> {
  return (await tx.query<Installation>('SELECT *,expires_at<=clock_timestamp() AS expired FROM mbox.native_push_installations WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[tx.scope.tenantId,tx.scope.storeId,id])).rows[0]
}
async function tombstone(tx: ScopedTransaction, id: string, revision: number, hash: string) {
  const match = await tx.query('SELECT 1 FROM mbox.native_push_revocation_tombstones WHERE tenant_id=$1 AND store_id=$2 AND installation_id=$3 AND revision=$4 AND secret_hash=$5',[tx.scope.tenantId,tx.scope.storeId,id,revision,hash])
  if (match.rowCount) throw new NativePushError('PUSH_REGISTRATION_REVOKED',409)
}
export class NativePushRepository {
  readonly protection: NativePushProtection | null
  private readonly commands: NormalizedCommandExecutor
  constructor(readonly transactions: Pick<ScopedPostgresTransactionRunner,'run'>, readonly config: NativePushConfig | null, private readonly hashSecret: string) {
    this.protection = config ? new NativePushProtection(config.tokenKey, config.tokenKeyId, hashSecret) : null
    this.commands = new NormalizedCommandExecutor(transactions)
  }
  async capabilities(actor: NativePushActor) {
    await this.transactions.run(actor.scope,tx=>authorizeNativePush(tx,actor),{readOnly:true})
    return { ...nativePushIdentity(actor), enabled: !!this.config, reasonCode: this.config ? null : 'PUSH_DISABLED', platforms: {
      ios: { provider:'apns', configured:!!this.config, environment:this.config?.environment ?? null },
      android: { provider:null, configured:false, reasonCode:'PROVIDER_NOT_SELECTED' } } }
  }
  get(actor: NativePushActor,id: string) { return this.transactions.run(actor.scope,async tx=>{
    const device=await authorizeNativePush(tx,actor), row=await installation(tx,id)
    if (!row || row.device_key_hash!==device.device_key_hash) throw new NativePushError('PUSH_NOT_FOUND',404)
    return {...nativePushIdentity(actor),installation:state(row,actor)}
  },{readOnly:true}) }
  put(actor: NativePushActor,id: string,key: string,body: NativePushRegistration) {
    const secretHash=revocationHash(body.revocationSecret)
    const fingerprint=JSON.stringify({id,...nativePushIdentity(actor),device:actor.deviceAccessLeaseId,...body,token:this.tokenFingerprint(body.token),revocationSecret:secretHash})
    return this.commands.execute<NativePushInstallationReceipt>({scope:actor.scope,operationScope:'native.push.register',idempotencyKey:key,requestFingerprint:fingerprint,retainReceipt:true,resultCodec:codec()},async tx=>{
      const cfg=this.config, protection=this.protection
      if (!cfg || !protection) throw new NativePushError('PUSH_NOT_CONFIGURED',503,true)
      const device=await authorizeNativePush(tx,actor), current=await installation(tx,id)
      if (current && current.device_key_hash!==device.device_key_hash) throw new NativePushError('PUSH_NOT_FOUND',404)
      if ((current ? Number(current.revision) : 0)!==body.expectedRevision || body.expectedRevision===Number.MAX_SAFE_INTEGER) throw new NativePushError('PUSH_REVISION_CONFLICT',409,true)
      if (current?.revocation_hash===secretHash) throw new NativePushError('PUSH_INVALID_REQUEST',400,true)
      const revision=body.expectedRevision+1, tokenHash=protection.hash(body.token)
      // Release only expired ownership; an active different installation cannot silently steal a token.
      await tx.query("UPDATE mbox.native_push_installations SET status='revoked',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND token_hash=$3 AND status='active' AND expires_at<=clock_timestamp()",[actor.scope.tenantId,actor.scope.storeId,tokenHash])
      const conflict=await tx.query("SELECT id FROM mbox.native_push_installations WHERE tenant_id=$1 AND store_id=$2 AND token_hash=$3 AND provider='apns' AND environment=$4 AND topic=$5 AND status='active' AND id<>$6",[actor.scope.tenantId,actor.scope.storeId,tokenHash,cfg.environment,cfg.topic,id])
      if(conflict.rowCount)throw new NativePushError('PUSH_TOKEN_CONFLICT',409,true)
      await tx.query(`INSERT INTO mbox.native_push_installations(tenant_id,store_id,id,employee_id,staff_session_id,device_access_lease_id,device_key_hash,revision,platform,provider,environment,topic,token_ciphertext,token_key_id,token_hash,revocation_hash,permission,app_version,status,expires_at,last_request_key,event_ttl_seconds)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ios','apns',$9,$10,$11,$12,$13,$14,$15,$16,'active',$17,$18,$19)
        ON CONFLICT(tenant_id,store_id,id) DO UPDATE SET employee_id=EXCLUDED.employee_id,staff_session_id=EXCLUDED.staff_session_id,device_access_lease_id=EXCLUDED.device_access_lease_id,revision=EXCLUDED.revision,environment=EXCLUDED.environment,topic=EXCLUDED.topic,token_ciphertext=EXCLUDED.token_ciphertext,token_key_id=EXCLUDED.token_key_id,token_hash=EXCLUDED.token_hash,revocation_hash=EXCLUDED.revocation_hash,permission=EXCLUDED.permission,app_version=EXCLUDED.app_version,status='active',registered_at=clock_timestamp(),expires_at=EXCLUDED.expires_at,last_request_key=EXCLUDED.last_request_key,event_ttl_seconds=EXCLUDED.event_ttl_seconds,updated_at=clock_timestamp()`,
      [actor.scope.tenantId,actor.scope.storeId,id,actor.employeeId,actor.staffSessionId,actor.deviceAccessLeaseId,device.device_key_hash,revision,cfg.environment,cfg.topic,protection.protect(body.token,actor.scope,id,revision),protection.keyId,tokenHash,secretHash,body.permission,body.appVersion,device.expires_at,key,cfg.eventTtlSeconds])
      await this.cancelPending(tx,id)
      const result={...nativePushIdentity(actor),requestKey:key,installation:state((await installation(tx,id))!,actor)}
      return this.outcome(actor,id,'registered',result)
    },async tx=>{
      await lockNativePushInstallation(tx,id)
      await authorizeNativePush(tx,actor,true)
      await tombstone(tx,id,body.expectedRevision+1,secretHash)
    })
  }
  revoke(actor: NativePushActor,id: string,key: string,expectedRevision: number) {
    return this.commands.execute<NativePushInstallationReceipt>({scope:actor.scope,operationScope:'native.push.revoke',idempotencyKey:key,requestFingerprint:JSON.stringify({id,expectedRevision,...nativePushIdentity(actor),device:actor.deviceAccessLeaseId}),retainReceipt:true,resultCodec:codec()},async tx=>{
      const row=await installation(tx,id)
      if (!row || row.staff_session_id!==actor.staffSessionId || row.employee_id!==actor.employeeId || row.device_access_lease_id!==actor.deviceAccessLeaseId) throw new NativePushError('PUSH_NOT_FOUND',404)
      if(Number(row.revision)!==expectedRevision)throw new NativePushError('PUSH_REVISION_CONFLICT',409,true)
      await tx.query("UPDATE mbox.native_push_installations SET status='revoked',last_request_key=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[actor.scope.tenantId,actor.scope.storeId,id,key])
      await this.cancelPending(tx,id)
      return this.outcome(actor,id,'revoked',{...nativePushIdentity(actor),requestKey:key,installation:state((await installation(tx,id))!,actor)})
    },async tx=>{await lockNativePushInstallation(tx,id);await authorizeNativePush(tx,actor,true)})
  }
  async revokeCapability(scope: StoreScope,id: string,revision: number,secret: string,ip: string) {
    // Shared limiter transaction commits even if the later revocation transaction fails.
    await this.rateLimit(scope,ip)
    await this.transactions.run(scope,async tx=>{
      await lockNativePushInstallation(tx,id)
      const hash=revocationHash(secret)
      await tx.query('INSERT INTO mbox.native_push_revocation_tombstones(tenant_id,store_id,installation_id,revision,secret_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,id,revision,hash])
      const row=await installation(tx,id)
      const matches=timingSafeEqual(Buffer.from(row?.revocation_hash ?? '0'.repeat(64)),Buffer.from(hash))
      if(row && Number(row.revision)===revision && matches) {
        await tx.query("UPDATE mbox.native_push_installations SET status='revoked',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[scope.tenantId,scope.storeId,id])
        await this.cancelPending(tx,id)
      }
    })
    return {protocol:1 as const,accepted:true as const}
  }
  private async rateLimit(scope:StoreScope,ip:string) {
    const hash=(value:string)=>createHmac('sha256',this.hashSecret).update('native-push-revoke-v1\0'+value).digest('hex')
    const allowed=await this.transactions.run(scope,async tx=>{
      let allowed=true
      // Stable order across processes. Both buckets count every syntactically valid request.
      for(const [principal,limit] of [['store',600],['ip:'+ip,60]] as const) {
        const result=await tx.query<{attempt_count:number}>(`INSERT INTO mbox.staff_login_rate_limits(tenant_id,store_id,attempt_kind,principal_hash,device_key_hash,window_started_at,attempt_count,expires_at)
          VALUES($1,$2,'native_push_revoke',$3,$4,clock_timestamp(),1,clock_timestamp()+interval '1 minute')
          ON CONFLICT(tenant_id,store_id,attempt_kind,principal_hash,device_key_hash) DO UPDATE SET
          attempt_count=CASE WHEN staff_login_rate_limits.expires_at<=clock_timestamp() THEN 1 ELSE LEAST(staff_login_rate_limits.attempt_count+1,1000) END,
          window_started_at=CASE WHEN staff_login_rate_limits.expires_at<=clock_timestamp() THEN clock_timestamp() ELSE staff_login_rate_limits.window_started_at END,
          expires_at=CASE WHEN staff_login_rate_limits.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '1 minute' ELSE staff_login_rate_limits.expires_at END,updated_at=clock_timestamp() RETURNING attempt_count`,[scope.tenantId,scope.storeId,hash(principal),hash('bucket')])
        if(result.rows[0]!.attempt_count>limit)allowed=false
      }
      return allowed
    })
    if(!allowed)throw new NativePushError('PUSH_RATE_LIMITED',429)
  }
  async target(tx:ScopedTransaction,actor:NativePushActor,id:string) {
    const device=await authorizeNativePush(tx,actor)
    const row=(await tx.query<{id:string;installation_id:string;binding_revision:string;task_id:string;table_session_id:string;expired:boolean;status:string}>(`
      SELECT d.id,d.installation_id,d.binding_revision,e.task_id,e.table_session_id,d.status,
        (e.expires_at<=clock_timestamp() OR i.expires_at<=clock_timestamp()) AS expired
      FROM mbox.native_push_deliveries d JOIN mbox.native_push_events e ON(e.tenant_id,e.store_id,e.id)=(d.tenant_id,d.store_id,d.event_id)
      JOIN mbox.native_push_installations i ON(i.tenant_id,i.store_id,i.id)=(d.tenant_id,d.store_id,d.installation_id)
      WHERE d.tenant_id=$1 AND d.store_id=$2 AND d.id=$3 AND d.employee_id=$4 AND d.staff_session_id=$5
        AND i.employee_id=d.employee_id AND i.staff_session_id=d.staff_session_id AND i.revision=d.binding_revision
        AND i.device_access_lease_id=$6 AND i.device_key_hash=$7 AND i.status='active'`,[actor.scope.tenantId,actor.scope.storeId,id,actor.employeeId,actor.staffSessionId,actor.deviceAccessLeaseId,device.device_key_hash])).rows[0]
    if(!row)throw new NativePushError('PUSH_NOT_FOUND',404)
    if(row.expired || !['sending','provider_accepted','unknown'].includes(row.status))throw new NativePushError('PUSH_TARGET_EXPIRED',410)
    const task=await readNativePushTaskTarget(tx,actor.employeeId,row.task_id,row.table_session_id)
    if(!task)throw new NativePushError('PUSH_TARGET_EXPIRED',410)
    return {...nativePushIdentity(actor),deliveryId:id,installationId:row.installation_id,revision:Number(row.binding_revision),kind:'service_task' as const,taskId:row.task_id,tableSessionId:row.table_session_id}
  }
  getTarget(actor:NativePushActor,id:string) {return this.transactions.run(actor.scope,tx=>this.target(tx,actor,id),{readOnly:true})}
  observe(actor:NativePushActor,id:string,key:string,kind:'received'|'opened') {
    return this.commands.execute({scope:actor.scope,operationScope:'native.push.observe',idempotencyKey:key,requestFingerprint:JSON.stringify({id,kind,...nativePushIdentity(actor),device:actor.deviceAccessLeaseId}),retainReceipt:true,resultCodec:codec<ReturnType<typeof nativePushIdentity>&{requestKey:string;deliveryId:string;kind:typeof kind;clientReportedReceivedAt:string|null;clientReportedOpenedAt:string|null}>()},async tx=>{
      const column=kind==='received'?'client_reported_received_at':'client_reported_opened_at'
      const row=(await tx.query<{client_reported_received_at:Date|null;client_reported_opened_at:Date|null}>(`UPDATE mbox.native_push_deliveries SET ${column}=COALESCE(${column},clock_timestamp()),updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING client_reported_received_at,client_reported_opened_at`,[actor.scope.tenantId,actor.scope.storeId,id])).rows[0]!
      return {result:{...nativePushIdentity(actor),requestKey:key,deliveryId:id,kind,clientReportedReceivedAt:row.client_reported_received_at?.toISOString()??null,clientReportedOpenedAt:row.client_reported_opened_at?.toISOString()??null},auditEvents:[],outboxMessages:[]}
    },async tx=>{await this.target(tx,actor,id)})
  }
  private tokenFingerprint(token:string) {return createHmac('sha256',this.hashSecret).update('native-push-fingerprint-v1\0'+token).digest('hex')}
  private outcome(actor:NativePushActor,id:string,action:string,result:NativePushInstallationReceipt) {return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:actor.employeeId},action:'native_push.'+action,objectType:'native_push_installation',objectId:id,businessDate:actor.businessDate,afterData:{revision:result.installation.revision,status:result.installation.status}}],outboxMessages:[]}}
  private async cancelPending(tx:ScopedTransaction,id:string) {await tx.query("UPDATE mbox.native_push_deliveries SET status='cancelled',locked_by=NULL,locked_at=NULL,failure_code='BINDING_CHANGED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND installation_id=$3 AND status IN('pending','retry')",[tx.scope.tenantId,tx.scope.storeId,id])}
}
