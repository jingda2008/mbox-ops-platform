import {createHash} from 'node:crypto'
import type {FastifyInstance} from 'fastify'
import {parseActivityServiceException,type ActivityServiceExceptionResult} from '../../src/shared/activity-service-exception.js'
import {ActivityServiceExceptionRepository} from './activity-service-exception-repository.js'
import {ActivityServiceError} from './activity-service-repository.js'
import {NormalizedKdsAuthorization} from './kds-authorization-policy.js'
import {handleCommerceRoute,type CommerceKdsApiOptions} from './commerce-kds-api.js'
import {NativeCommandNotCommittedError,type JsonValue} from './command-executor.js'
import type {ScopedTransaction} from './transaction-runner.js'

export async function registerActivityServiceExceptionRoutes(app:FastifyInstance,options:Pick<CommerceKdsApiOptions,'resolveContext'|'staffAccessTransactions'|'commandExecutor'>) {
  app.post('/commerce/activity-service/exceptions',async(request,reply)=>handleCommerceRoute(reply,async()=>{
    try {
      const context=await options.resolveContext(request),command=parseActivityServiceException(request.body),raw=request.headers['idempotency-key']
      if(typeof raw!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(raw))throw new TypeError('请保留原异常处理凭据')
      const authorize=async(tx:ScopedTransaction)=>{
        const line=(await tx.query<{station_code:string}>('SELECT station_code FROM mbox.activity_service_lines WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[context.scope.tenantId,context.scope.storeId,command.lineId])).rows[0]
        if(!line)throw new ActivityServiceError('未找到本门店原出品','ACTIVITY_LINE_NOT_FOUND',404)
        // Reuse the manager exception capability and live action-session/station checks.
        await new NormalizedKdsAuthorization().assertCanActOnTask({transaction:tx,...context,action:'quantity_remake',stationCode:line.station_code,tableId:''})
      }
      await options.staffAccessTransactions.run(context.scope,authorize)
      const key=createHash('sha256').update(`${context.employeeId}:${raw}`).digest('hex')
      const result=await options.commandExecutor.execute({scope:context.scope,operationScope:'activity.service.exception',idempotencyKey:key,requestFingerprint:JSON.stringify({employeeId:context.employeeId,command}),retainReceipt:true,
        resultCodec:{encode:value=>value as unknown as JsonValue,decode:value=>value as ActivityServiceExceptionResult}},async tx=>{
        await authorize(tx)
        const result=await new ActivityServiceExceptionRepository(tx).execute(command,key,context.employeeId)
        return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:context.employeeId},action:`activity.service.exception.${command.action}`,objectType:'activity_service_receipt',objectId:result.receiptId,businessDate:context.businessDate,afterData:{lineId:command.lineId,quantity:command.quantity??0,reason:command.reason},requestId:request.id}],outboxMessages:[]}
      })
      return reply.send({data:result.value,replayed:result.replayed})
    } catch(caught) {
      const error=caught instanceof NativeCommandNotCommittedError?caught.original:caught
      if(error instanceof ActivityServiceError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message,commitDisposition:'not_committed'}})
      throw error
    }
  }))
}
