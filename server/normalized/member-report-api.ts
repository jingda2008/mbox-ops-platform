import {z} from 'zod'
import type {FastifyPluginAsync} from 'fastify'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {memberReportFilter,readMemberReport,readMemberReportDetail} from './member-report-query.js'
interface Options extends Pick<CustomerBenefitApiOptions,'resolveStaffContext'> {transactions:Pick<ScopedPostgresTransactionRunner,'run'>;protection:ActivityContactProtectionKeyring}
export const memberReportApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store');reply.header('Vary','Cookie, Authorization')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'MEMBER_REPORT_FORBIDDEN',message:'当前账号没有会员查询报表权限'}})
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'MEMBER_REPORT_INVALID',message:'请检查查询条件、日期范围和页码'}})
  return reply.code(503).send({error:{code:'MEMBER_REPORT_UNAVAILABLE',message:'会员报表暂时无法读取，请重试'}})
 })
 app.post('/staff/member-report',async request=>{
  const ctx=await options.resolveStaffContext(request),filter=memberReportFilter.parse(request.body)
  return {data:await options.transactions.run(ctx.scope,async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.report.view')
   await tx.query("SET LOCAL statement_timeout='15s'")
   return readMemberReport(tx,filter,options.protection)
  },{readOnly:true,isolation:'repeatable-read'})}
 })
 app.get<{Params:{id:string}}>('/staff/member-report/:id/consumption',async request=>{
  const ctx=await options.resolveStaffContext(request),id=z.uuid().parse(request.params.id)
  const {page}=z.object({page:z.coerce.number().int().min(1).max(100000).default(1)}).strict().parse(request.query)
  return {data:await options.transactions.run(ctx.scope,async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.report.view')
   await tx.query("SET LOCAL statement_timeout='15s'")
   return readMemberReportDetail(tx,id,page)
  },{readOnly:true,isolation:'repeatable-read'})}
 })
}
