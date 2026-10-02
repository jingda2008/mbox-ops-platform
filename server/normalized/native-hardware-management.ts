import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { HardwareApiOptions } from './hardware-api.js'
import { HardwareRepository, HardwareConflictError, HardwareNotFoundError, HardwarePolicyError } from './hardware-repository.js'
import { NativeCommandNotCommittedError, IdempotencyConflictError, IdempotencyInProgressError, type JsonCodec, type JsonObject } from './command-executor.js'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import { PRINT_TICKET_KINDS } from '../../src/shared/print-ticket-policy.js'

const code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/)
const name = z.string().trim().min(1).max(120)
const status = z.enum(['active','paused','retired'])
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const reason = z.string().trim().min(3).max(500)
const device = z.object({code,name,stationCode:z.enum(['bar','kitchen','cashier','service']),
  status,printBridgeId:z.uuid().nullable(),windowsQueueName:z.string().trim().min(1).max(180).nullable(),
  printProfile:z.enum(['escpos_58','escpos_80','windows_text']).nullable()}).strict()
const inputSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('device-create'),device,reason}).strict(),
  z.object({kind:z.literal('device-update'),id:z.uuid(),expected:fingerprint,device,reason}).strict(),
  z.object({kind:z.literal('route-save'),expected:fingerprint.nullable(),reason,route:z.object({code,name,
    stationCode:z.enum(['bar','kitchen','cashier']),productCategoryCode:z.string().trim().min(1).max(64).nullable(),
    printerDeviceId:z.uuid(),copies:z.number().int().min(1).max(5),priority:z.number().int().min(0).max(1000),status}).strict()}).strict(),
  z.object({kind:z.literal('policy-save'),expected:fingerprint,reason,policy:z.object({ticketKind:z.enum(PRINT_TICKET_KINDS),
    enabled:z.boolean(),copies:z.number().int().min(1).max(5)}).strict()}).strict(),
  z.object({kind:z.literal('device-test'),id:z.uuid(),expected:fingerprint,reason,command:z.enum(['test_print','reconnect','ping'])}).strict(),
])
const deviceFields=['id','code','name','deviceType','stationCode','status','printBridgeId','windowsQueueName','printProfile']
const routeFields=['id','code','name','stationCode','productCategoryCode','printerDeviceId','copies','priority','status']
function hash(value: object, fields: string[]) { const row=value as Record<string,unknown>; return createHash('sha256').update(JSON.stringify(fields.map(k=>row[k]??null))).digest('hex') }
function withHash(value: object, fields: string[]) { return {...value,configurationFingerprint:hash(value,fields)} }
function manager(context: NormalizedOperationsRequestContext) {
  if(!context.capabilities.some(p=>['hardware.manage','printer.manage'].includes(p))) throw new ManagementPermissionError()
}
class ManagementPermissionError extends Error {}
const receiptCodec: JsonCodec<JsonObject> = {encode:v=>v,decode:v=>{
  if(!v || typeof v!=='object' || Array.isArray(v))throw new TypeError('设备原回执无效')
  return v as JsonObject
}}

export async function registerNativeHardware(app: FastifyInstance, options: HardwareApiOptions) {
  app.get('/hardware/native-management', async (request,reply)=>{
    try {
      const context=await options.resolveContext(request); manager(context)
      const data=await options.transactions.run(context.scope,async tx=>{
        const repo=options.createRepository?.(tx)??new HardwareRepository(tx)
        const devices=(await repo.listDevices()).filter(d=>d.deviceType==='printer').map(d=>withHash(d,deviceFields))
        const routes=(await repo.listPrinterRoutes()).map(r=>withHash(r,routeFields))
        const stored=(await tx.query<{ticketKind:string;enabled:boolean;copies:number}>(`SELECT ticket_kind AS "ticketKind",enabled,copies
          FROM mbox.print_ticket_policies WHERE tenant_id=$1 AND store_id=$2`,[context.scope.tenantId,context.scope.storeId])).rows
        const policies=PRINT_TICKET_KINDS.map(ticketKind=>withHash(stored.find(p=>p.ticketKind===ticketKind)??{ticketKind,enabled:true,copies:null},['ticketKind','enabled','copies']))
        const commands=(await tx.query(`SELECT h.id,h.device_id AS "deviceId",d.name AS "deviceName",h.command_type AS "commandType",h.status,
          h.last_error_code AS "errorCode",h.created_at::text AS "createdAt",h.completed_at::text AS "completedAt"
          FROM mbox.hardware_commands h JOIN mbox.devices d ON d.tenant_id=h.tenant_id AND d.store_id=h.store_id AND d.id=h.device_id
          WHERE h.tenant_id=$1 AND h.store_id=$2 AND d.device_type='printer' ORDER BY h.created_at DESC,h.id DESC LIMIT 50`,[context.scope.tenantId,context.scope.storeId])).rows
        return {nativeCommands:true,employeeId:context.employeeId,devices,routes,policies,commands}
      },{readOnly:true})
      return reply.header('cache-control','no-store').send({data})
    } catch(e) { return failure(reply,e) }
  })
  app.post('/hardware/native-management/commands',async(request,reply)=>{
    try {
      const context=await options.resolveContext(request);manager(context)
      const input=inputSchema.parse(request.body)
      const key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key'])
      const execute=await options.commands.execute({scope:context.scope,operationScope:`native.hardware.${input.kind}`,
        idempotencyKey:key,retainReceipt:true,resultCodec:receiptCodec,
        requestFingerprint:createHash('sha256').update(JSON.stringify({input,employeeId:context.employeeId})).digest('hex')},async tx=>{
        const repo=options.createRepository?.(tx)??new HardwareRepository(tx)
        let row: object; let before: object|undefined; let objectId=context.scope.storeId
        if(input.kind==='device-update'||input.kind==='device-test') {
          await tx.query('SELECT id FROM mbox.devices WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[context.scope.tenantId,context.scope.storeId,input.id])
          before=(await repo.listDevices()).find(d=>d.id===input.id&&d.deviceType==='printer')
          if(!before)throw new HardwareNotFoundError('打印机不存在')
          if(hash(before,deviceFields)!==input.expected)throw new HardwareConflictError('打印机配置已变化，请刷新后重新核对')
        }
        if(input.kind==='device-create') {
          if(input.device.status!=='active')throw new HardwarePolicyError('新设备只能以启用状态创建')
          row=await repo.createDevice({...input.device,deviceType:'printer',capabilities:['test_print','reconnect','ping']})
          objectId=(row as {id:string}).id
        } else if(input.kind==='device-update') {
          if((before as {code:string}).code!==input.device.code)throw new HardwarePolicyError('设备编号不能修改')
          row=(await repo.updateDevice({...input.device,id:input.id,printerOnly:true})).device;objectId=input.id
        } else if(input.kind==='device-test') {
          row=await repo.requestHardwareCommand({publicId:key,deviceId:input.id,commandType:input.command,
            requestedByEmployeeId:context.employeeId,reason:input.reason,printerOnly:true});objectId=(row as {id:string}).id
        } else if(input.kind==='route-save') {
          const current=await repo.getPrinterRouteByCode(input.route.code,true);before=current??undefined
          if((current?hash(current,routeFields):null)!==input.expected)throw new HardwareConflictError('打印路由已变化，请刷新后重新核对')
          row=await repo.upsertPrinterRoute({...input.route,createOnly:current===null});objectId=(row as {id:string}).id
        } else {
          const p=input.policy
          const current=(await tx.query<{ticketKind:string;enabled:boolean;copies:number}>(`SELECT ticket_kind AS "ticketKind",enabled,copies
            FROM mbox.print_ticket_policies WHERE tenant_id=$1 AND store_id=$2 AND ticket_kind=$3 FOR UPDATE`,[context.scope.tenantId,context.scope.storeId,p.ticketKind])).rows[0]
          before=current??{ticketKind:p.ticketKind,enabled:true,copies:null}
          if(hash(before,['ticketKind','enabled','copies'])!==input.expected)throw new HardwareConflictError('票据策略已变化，请刷新后重新核对')
          const changed=current ? await tx.query(`UPDATE mbox.print_ticket_policies SET enabled=$4,copies=$5,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND store_id=$2 AND ticket_kind=$3`,[context.scope.tenantId,context.scope.storeId,p.ticketKind,p.enabled,p.copies])
            : await tx.query(`INSERT INTO mbox.print_ticket_policies(tenant_id,store_id,ticket_kind,enabled,copies) VALUES($1,$2,$3,$4,$5)
              ON CONFLICT(tenant_id,store_id,ticket_kind) DO NOTHING`,[context.scope.tenantId,context.scope.storeId,p.ticketKind,p.enabled,p.copies])
          if(changed.rowCount!==1)throw new HardwareConflictError('票据策略刚被创建，请刷新')
          row=p
        }
        const result={kind:input.kind,employeeId:context.employeeId,reason:input.reason,row:JSON.parse(JSON.stringify(row))} as JsonObject
        return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:context.employeeId},action:`native.hardware.${input.kind}`,
          objectType:'hardware_configuration',objectId,businessDate:context.businessDate,reason:input.reason,
          beforeData:before?JSON.parse(JSON.stringify(before)):null,afterData:result}],outboxMessages:[]}
      },async()=>{
        const current=await options.resolveContext(request);manager(current)
        if(current.employeeId!==context.employeeId||current.scope.tenantId!==context.scope.tenantId||current.scope.storeId!==context.scope.storeId)throw new ManagementPermissionError()
      })
      return reply.send({data:execute.value,meta:{replayed:execute.replayed}})
    } catch(e) { return failure(reply,e) }
  })
}
function failure(reply: import('fastify').FastifyReply,e:unknown) {
  if(e instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:'本次设备配置未提交，请刷新配置后核对重试',commitDisposition:'not_committed'}})
  if(e instanceof ManagementPermissionError)return reply.code(403).send({error:{code:'HARDWARE_FORBIDDEN',message:'当前员工没有打印设备管理权限'}})
  if(e instanceof NormalizedAuthenticationRequiredError||e instanceof StaffSessionNotFoundError)return reply.code(401).send({error:{code:'AUTH_REQUIRED',message:'请重新登录'}})
  if(e instanceof z.ZodError||e instanceof HardwarePolicyError)return reply.code(400).send({error:{code:'HARDWARE_REQUEST_INVALID',message:'请核对设备配置、处理说明和请求编号'}})
  if(e instanceof IdempotencyConflictError||e instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'HARDWARE_CONFLICT',message:'请保留原请求并核对处理结果'}})
  return reply.code(500).send({error:{code:'HARDWARE_INTERNAL_ERROR',message:'设备服务暂不可用，请保留原请求'}})
}
