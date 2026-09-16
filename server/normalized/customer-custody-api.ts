import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { CustomerBenefitApiOptions } from './customer-benefit-api.js'
import { CustomerCustodyRepository } from './customer-custody-repository.js'
import { BottleCustodyError } from './bottle-custody-policy.js'
import { ReservationGuestSessionInvalidError } from './reservation-guest-session.js'
import { isStaffAuthenticationRequiredError } from './staff-api-authentication.js'
import type { ActivityContactProtectionKeyring } from './personal-contact-protection.js'

type Options = Pick<CustomerBenefitApiOptions,'transactions'|'resolveSelfContext'> & { protection: ActivityContactProtectionKeyring }
const uuid = z.string().uuid()
export const customerCustodyApiPlugin: FastifyPluginAsync<Options> = async (app,options) => {
  app.addHook('onRequest',async (_request,reply)=>{reply.header('Cache-Control','private, no-store')})
  app.setErrorHandler((error,_request,reply)=>{
    if (error instanceof ReservationGuestSessionInvalidError || isStaffAuthenticationRequiredError(error))
      return reply.code(401).send({error:{code:'CUSTOMER_AUTHENTICATION_REQUIRED',message:'请先登录会员后查看存酒'}})
    if (error instanceof BottleCustodyError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}})
    if (error instanceof z.ZodError) return reply.code(400).send({error:{code:'CUSTODY_INVALID',message:'存酒查询参数无效'}})
    throw error
  })
  app.get('/public/mini/customer/bottle-custody',async request=>{
    const ctx=await options.resolveSelfContext(request)
    const {cursor}=z.object({cursor:uuid.optional()}).strict().parse(request.query)
    return {data:await options.transactions.run(ctx.scope,tx=>new CustomerCustodyRepository(tx).list(ctx.customerId,cursor),{readOnly:true})}
  })
  app.get<{Params:{id:string}}>('/public/mini/customer/bottle-custody/:id',async request=>{
    const ctx=await options.resolveSelfContext(request),id=uuid.parse(request.params.id)
    return {data:await options.transactions.run(ctx.scope,tx=>new CustomerCustodyRepository(tx,options.protection).detail(ctx.customerId,id),{readOnly:true})}
  })
  app.get<{Params:{id:string;depositId:string}}>('/public/mini/customer/bottle-custody/:id/photos/:depositId',async request=>{
    const ctx=await options.resolveSelfContext(request),id=uuid.parse(request.params.id),depositId=uuid.parse(request.params.depositId)
    const photo=await options.transactions.run(ctx.scope,tx=>new CustomerCustodyRepository(tx).photo(ctx.customerId,id,depositId),{readOnly:true})
    return {data:{base64:photo.toString('base64')}}
  })
}
