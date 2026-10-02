import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor} from './command-executor.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {nativeGuardedExecutor} from './native-guarded-executor.js'
import {PerformanceCommandService} from './performance-command-service.js'
import {ScheduleRepository} from './schedule-repository.js'
import {PerformerRepository} from './performer-repository.js'
import {PerformerSongRepository} from './performer-song-repository.js'
import {CustomerExperienceService} from './customer-experience-service.js'
import {CustomerExperienceRepository} from './customer-experience-repository.js'
import type {CustomerCommandService} from './customer-repository.js'
import {ReservationPerformanceRevisionService,type ReservationPerformanceStaffContext} from './reservation-performance-revision-service.js'
import {readMonthlySchedule,previewMonthlySchedule} from './monthly-schedule.js'

type Options={transactions:Pick<ScopedPostgresTransactionRunner,'run'>;commands:NormalizedCommandExecutor;customers:Pick<CustomerCommandService,'updateProfile'>;resolveContext:(request:FastifyRequest)=>Promise<ReservationPerformanceStaffContext>|ReservationPerformanceStaffContext}
const uuid=z.string().uuid(),stamp=z.iso.datetime({offset:true}),reason=z.string().trim().min(2).max(240),hash=z.string().regex(/^[a-f0-9]{64}$/),song=z.object({code:z.string().trim().max(64).nullable().optional(),title:z.string().trim().min(1).max(240),aliases:z.array(z.string().trim().min(1).max(240)).max(100).default([]),status:z.enum(['active','inactive']).default('active')}).strict()
const schemas={
 'publish':z.object({month:z.string(),slots:z.array(z.object({performerId:uuid,startsAt:stamp,endsAt:stamp,sortOrder:z.number().int().optional()}).strict()).min(1).max(155)}).strict(),
 'schedule-status':z.object({scheduleId:uuid,expected:hash,targetStatus:z.enum(['performing','completed'])}).strict(),
 'schedule-sort':z.object({scheduleId:uuid,expected:hash,sortOrder:z.number().int().min(0).max(100000)}).strict(),
 'revision':z.object({scheduleId:uuid,expected:hash,kind:z.enum(['rescheduled','cancelled','replaced']),startsAt:stamp.nullable(),endsAt:stamp.nullable(),replacementScheduleId:uuid.nullable(),replacementExpected:hash.nullable(),reason}).strict(),
 'phase-start':z.object({scheduleId:uuid,expected:hash,phaseCode:z.enum(['before_show','acoustic','band_live','intermission','after_show']),reason}).strict(),
 'phase-end':z.object({publicId:z.string().min(8).max(128),reason}).strict(),
 'phase-cancel':z.object({publicId:z.string().min(8).max(128),reason}).strict(),
 'performer-create':z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),stageName:z.string().trim().min(1).max(120),profileSnapshot:z.record(z.string(),z.json()),status:z.enum(['active','inactive']).default('active')}).strict(),
 'performer-update':z.object({performerId:uuid,expected:hash,stageName:z.string().trim().min(1).max(120),profileSnapshot:z.record(z.string(),z.json()),status:z.enum(['active','inactive'])}).strict(),
 'songs-import':z.object({performerId:uuid,expected:hash,sourceName:z.string().trim().min(1).max(240),mode:z.enum(['upsert','replace']),songs:z.array(song).min(0).max(5000)}).strict(),
 'song-update':z.object({songId:uuid,expected:hash,changes:song}).strict(),
}
type Action=keyof typeof schemas
export function performanceSnapshot(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
export const nativePerformanceApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'PERFORMANCE_FORBIDDEN',message:'没有此项演出管理权限'}})
  if(error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof TypeError?error.original.message:'演出或预约状态已变化，本次未提交，请刷新核对',commitDisposition:'not_committed'}})
  if(error instanceof z.ZodError||error instanceof TypeError)return reply.code(400).send({error:{code:'PERFORMANCE_INVALID',message:error instanceof TypeError?error.message:'请核对场次、时间及必填字段'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'NATIVE_REQUEST_CONFLICT',message:'原请求处理中或内容不一致，请核对原回执'}})
  throw error
 })
 async function context(request:FastifyRequest,permissions:string[]){
  const ctx=await options.resolveContext(request);await options.transactions.run(ctx.scope,async tx=>{const rights=await new StaffAccessRepository(tx).resolve(ctx.employeeId);if(!permissions.some(p=>rights.permissions.includes(p)))throw new StaffAccessDeniedError('无演出权限')},{readOnly:true});return ctx
 }
 const readPermissions=['song.view','song.manage','performance.phase.manage','performance.schedule.revise']
 app.get('/staff/native-performances',async request=>{
  const ctx=await context(request,readPermissions),{month}=z.object({month:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/)}).strict().parse(request.query)
  const data=await options.transactions.run(ctx.scope,async tx=>{
   const scheduleIds=(await tx.query<{id:string}>(`SELECT id FROM mbox.schedules WHERE tenant_id=$1 AND store_id=$2 AND to_char(starts_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM')=$3 ORDER BY starts_at,id`,[ctx.scope.tenantId,ctx.scope.storeId,month])).rows
   const schedules=[];for(const row of scheduleIds){const item=await new ScheduleRepository(tx).findById(row.id);if(item)schedules.push({...item,configurationFingerprint:performanceSnapshot(item)})}
   const performerIds=(await tx.query<{id:string}>('SELECT id FROM mbox.performers WHERE tenant_id=$1 AND store_id=$2 ORDER BY stage_name,id',[ctx.scope.tenantId,ctx.scope.storeId])).rows
   const performers=[];for(const row of performerIds){const item=await new PerformerRepository(tx).findById(row.id);if(item)performers.push({...item,configurationFingerprint:performanceSnapshot(item)})}
   const rights=await new StaffAccessRepository(tx).resolve(ctx.employeeId)
   const revisions=rights.permissions.includes('performance.schedule.revise')?(await tx.query(`SELECT public_id AS "publicId",schedule_id AS "scheduleId",revision_number AS "revisionNumber",revision_kind AS kind,reason,created_at::text AS "createdAt" FROM mbox.performance_schedule_revisions WHERE tenant_id=$1 AND store_id=$2 AND schedule_id=ANY($3::uuid[]) ORDER BY created_at DESC,id`,[ctx.scope.tenantId,ctx.scope.storeId,schedules.map(s=>s.id)])).rows:[]
   const phases=await new CustomerExperienceRepository(tx).currentPerformancePhaseEvents()
   return{month,schedules,performers,phases,revisions,employeeId:ctx.employeeId,durableCommands:true,protocol:1}
  },{readOnly:true,isolation:'repeatable-read'});return{data}
 })
 app.post('/staff/native-performances/preview',async request=>{
  const ctx=await context(request,['song.manage']),input=readMonthlySchedule(schemas.publish.parse(request.body));return{data:{slots:await options.transactions.run(ctx.scope,tx=>previewMonthlySchedule(tx,input),{readOnly:true})}}
 })
 app.get<{Params:{performerId:string}}>('/staff/native-performances/performers/:performerId/songs',async request=>{
  const ctx=await context(request,['song.view','song.manage']),id=uuid.parse(request.params.performerId)
  const {offset,search}=z.object({search:z.string().trim().max(120).default(''),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict().parse(request.query)
  return{data:await options.transactions.run(ctx.scope,async tx=>{
   const all=(await tx.query<{id:string;updatedAt:string}>('SELECT id,updated_at::text AS "updatedAt" FROM mbox.performer_songs WHERE tenant_id=$1 AND store_id=$2 AND performer_id=$3 ORDER BY id',[ctx.scope.tenantId,ctx.scope.storeId,id])).rows
   const matches=search?(await tx.query<{id:string}>(`SELECT song.id FROM mbox.performer_songs song WHERE tenant_id=$1 AND store_id=$2 AND performer_id=$3 AND (song.title ILIKE $4 OR song.code ILIKE $4 OR EXISTS(SELECT 1 FROM mbox.performer_song_aliases alias WHERE alias.tenant_id=song.tenant_id AND alias.store_id=song.store_id AND alias.song_id=song.id AND alias.alias ILIKE $4)) ORDER BY song.id`,[ctx.scope.tenantId,ctx.scope.storeId,id,'%'+search+'%'])).rows:all
   const songs=[];for(const row of matches.slice(offset,offset+100)){const item=await new PerformerSongRepository(tx).findById(row.id);if(item)songs.push({...item,configurationFingerprint:performanceSnapshot(item)})}
   return{songs,total:matches.length,totalSongs:all.length,nextOffset:offset+100<matches.length?offset+100:null,catalogFingerprint:performanceSnapshot(all)}
  },{readOnly:true,isolation:'repeatable-read'})}
 })
 app.get<{Params:{publicId:string}}>('/staff/native-performances/revisions/:publicId/impacts',async request=>{
  const ctx=await context(request,['reservation.view']),id=z.string().min(8).max(128).parse(request.params.publicId);return{data:{impacts:await new ReservationPerformanceRevisionService(options.transactions,options.commands).listRevisionImpacts(ctx,id)}}
 })
 app.post<{Params:{action:string}}>('/staff/native-performances/commands/:action',async request=>{
  const action=z.enum(Object.keys(schemas) as [Action,...Action[]]).parse(request.params.action),input=schemas[action].parse(request.body)
  const permission=action==='revision'?'performance.schedule.revise':action.startsWith('phase-')?'performance.phase.manage':'song.manage'
  const ctx=await context(request,[permission]),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key'])
  const commands=nativeGuardedExecutor(options.commands,{fingerprint:{action,input,employeeId:ctx.employeeId},authorize:async tx=>{
   const current=await options.resolveContext(request);if(current.employeeId!==ctx.employeeId||current.scope.storeId!==ctx.scope.storeId||current.scope.tenantId!==ctx.scope.tenantId)throw new StaffAccessDeniedError('账号变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)
  },guard:async tx=>{
   // Same timeline-first lock order used by the existing schedule repository.
   if(action==='phase-start'||action==='schedule-status')await tx.query('SELECT id FROM mbox.stores WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId])
   if(!action.startsWith('phase-')||action==='phase-start')await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.scope.tenantId}:${ctx.scope.storeId}:performance-timeline`])
   if(action==='schedule-status'&&schemas['schedule-status'].parse(input).targetStatus==='completed'){
    const active=await tx.query("SELECT id FROM mbox.schedule_performance_phase_events WHERE tenant_id=$1 AND store_id=$2 AND schedule_id=$3 AND status='active'",[ctx.scope.tenantId,ctx.scope.storeId,schemas['schedule-status'].parse(input).scheduleId])
    if(active.rows.length)throw new TypeError('请先结束当前现场阶段，再结束演出')
   }
   if(action==='songs-import'){
    const parsed=schemas[action].parse(input)
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text || \':\' || $2::text || \':\' || $3::text,0))',[ctx.scope.tenantId,ctx.scope.storeId,parsed.performerId])
    const all=(await tx.query('SELECT id,updated_at::text AS "updatedAt" FROM mbox.performer_songs WHERE tenant_id=$1 AND store_id=$2 AND performer_id=$3 ORDER BY id FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId,parsed.performerId])).rows
    if(performanceSnapshot(all)!==parsed.expected)throw new TypeError('曲库已变化，请重新读取后核对导入')
    return
   }
   let original:unknown
   if('scheduleId' in input){original=await new ScheduleRepository(tx).findById(input.scheduleId,true)}
   else if('performerId' in input && 'expected' in input){original=await new PerformerRepository(tx).findById(input.performerId,true)}
   else if('songId' in input){original=await new PerformerSongRepository(tx).findById(input.songId,true)}
   if(action==='revision'){
    const parsed=schemas[action].parse(input)
    if(parsed.kind==='replaced'){
     const replacement=parsed.replacementScheduleId?await new ScheduleRepository(tx).findById(parsed.replacementScheduleId,true):null
     if(!replacement||performanceSnapshot(replacement)!==parsed.replacementExpected)throw new TypeError('替代场次已变化，请刷新重新选择')
    }
   }
   if('expected' in input && (!original||performanceSnapshot(original)!==input.expected))throw new TypeError('原演出或曲目已变化，请刷新核对')
  }})
  const service=new PerformanceCommandService(commands),meta={scope:ctx.scope,actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,idempotencyKey:key,requestFingerprint:performanceSnapshot({input,employeeId:ctx.employeeId})}
  let result
  switch(action){
   case 'publish': result=await service.publishMonthly({...readMonthlySchedule(input),...meta});break
   case 'schedule-status':result=await service.transitionSchedule({...schemas[action].parse(input),...meta});break
   case 'schedule-sort':result=await service.updateSchedule({...schemas[action].parse(input),...meta});break
   case 'performer-create':result=await service.createPerformer({...schemas[action].parse(input),...meta});break
   case 'performer-update':result=await service.updatePerformer({...schemas[action].parse(input),...meta});break
   case 'songs-import':result=await service.importPerformerSongs({...schemas[action].parse(input),...meta});break
   case 'song-update':result=await service.updatePerformerSong({...schemas[action].parse(input),...meta});break
   case 'revision':result=await new ReservationPerformanceRevisionService(options.transactions,commands).revise(ctx,{...schemas[action].parse(input),idempotencyKey:key});break
   case 'phase-start':result=await new CustomerExperienceService(options.transactions,commands,options.customers).startPerformancePhase(ctx,{...schemas[action].parse(input),idempotencyKey:key});break
   case 'phase-end':case 'phase-cancel':result=await new CustomerExperienceService(options.transactions,commands,options.customers).transitionPerformancePhase(ctx,{...schemas[action].parse(input),action:action==='phase-end'?'end':'cancel',idempotencyKey:key});break
  }
  return{data:{action,employeeId:ctx.employeeId,requestKey:key,result:result.value},meta:{protocol:1,replayed:result.replayed}}
 })
}
