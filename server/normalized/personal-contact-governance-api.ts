import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { PublicCustomerExperienceContext, StaffCustomerExperienceContext } from './customer-experience-service.js'
import { protectActivityRegistrationContact } from './customer-experience-api.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import {
  PersonalContactGovernanceError,
  PersonalContactGovernanceService,
} from './personal-contact-governance-service.js'
import type { ActivityContactProtectionKeyring } from './personal-contact-protection.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import type { JsonObject } from './command-executor.js'

interface Options {
  transactions: Pick<ScopedPostgresTransactionRunner,'run'>
  service: PersonalContactGovernanceService
  protection: ActivityContactProtectionKeyring
  resolvePublicContext(request: FastifyRequest): PublicCustomerExperienceContext | Promise<PublicCustomerExperienceContext>
  resolveStaffContext(request: FastifyRequest): StaffCustomerExperienceContext | Promise<StaffCustomerExperienceContext>
}

export const personalContactGovernanceApiPlugin: FastifyPluginAsync<Options> = async (app,options) => {
  app.addHook('onRequest',(_request,reply,done)=>{
    reply.header('Cache-Control','private, no-store, max-age=0')
    reply.header('Pragma','no-cache')
    done()
  })
  app.put<{ Params:{ registrationPublicId:string } }>(
    '/public/mini/activity-registrations/:registrationPublicId/contact',
    async (request,reply) => handle(reply,async () => {
      const context=await options.resolvePublicContext(request)
      const body=object(request.body)
      const protectedValue=await protectActivityRegistrationContact(body,(
        value => options.protection.protect(value)
      ))
      const result=await options.service.updateMyActivityContact(context,{
        registrationPublicId:text(request.params.registrationPublicId,'报名编号',8,128),
        contact:protectedValue,
        idempotencyKey:idempotencyKey(request),
      })
      return reply.send({ data:result })
    }),
  )

  app.post<{ Params:{ contactVersionPublicId:string } }>(
    '/staff/activity-contacts/:contactVersionPublicId/reveal',
    async (request,reply) => handle(reply,async () => {
      const context=await staff(options,request,'community.activity.contact.reveal')
      const body=object(request.body)
      const result=await options.service.revealActivityContact(context,{
        contactVersionPublicId:publicId(request.params.contactVersionPublicId,'ACV'),
        purpose:enumeration(body.purpose,'查看用途',[
          'attendance_coordination','waitlist_coordination','payment_followup',
        ] as const),
        idempotencyKey:idempotencyKey(request),
      })
      return reply.send({ data:result })
    }),
  )

  app.get('/staff/personal-contact-governance/policies',async (request,reply) => handle(reply,async () => {
    const context=await staff(options,request,'privacy.contact.retention.view')
    return reply.send({ data:await options.service.listPolicies(context) })
  }))

  app.get('/staff/personal-contact-governance/evidence',async (request,reply) => handle(reply,async () => {
    const context=await staff(options,request,'privacy.contact.retention.view')
    return reply.send({data:await options.service.listEvidence(context)})
  }))

  app.post('/staff/personal-contact-governance/policies',async (request,reply) => handle(reply,async () => {
    const context=await staff(options,request,'privacy.contact.retention.draft')
    const body=object(request.body)
    const data=await options.service.draftPolicy(context,{
      resourceKind:enumeration(body.resourceKind,'资源类型',[
        'activity_registration_contact','verified_membership_phone',
      ] as const),
      retentionDaysAfterPurposeEnd:integer(body.retentionDaysAfterPurposeEnd,'保留天数',0,36_500),
      legalBasisReference:text(body.legalBasisReference,'保留依据',3,500),
      reason:text(body.reason,'起草原因',2,500),
    })
    return reply.code(201).send({ data })
  }))

  app.post<{ Params:{ publicId:string } }>(
    '/staff/personal-contact-governance/policies/:publicId/approve',
    async (request,reply) => handle(reply,async () => {
      const context=await staff(options,request,'privacy.contact.retention.approve')
      const body=object(request.body)
      return reply.send({ data:await options.service.approvePolicy(context,{
        publicId:publicId(request.params.publicId,'PCR'),reason:text(body.reason,'审批意见',2,500),
      }) })
    }),
  )

  app.post<{ Params:{ publicId:string } }>(
    '/staff/personal-contact-governance/policies/:publicId/publish',
    async (request,reply) => handle(reply,async () => {
      const context=await staff(options,request,'privacy.contact.retention.publish')
      const body=object(request.body)
      return reply.send({ data:await options.service.publishPolicy(context,{
        publicId:publicId(request.params.publicId,'PCR'),
        effectiveFrom:text(body.effectiveFrom,'生效时间',20,40),
        reason:text(body.reason,'发布说明',2,500),
      }) })
    }),
  )

  app.post('/staff/personal-contact-governance/legal-holds',async (request,reply) => handle(reply,async () => {
    const context=await staff(options,request,'privacy.contact.legal_hold')
    const body=object(request.body)
    const data=await options.service.createLegalHold(context,{
      resourceKind:enumeration(body.resourceKind,'资源类型',[
        'activity_registration_contact','verified_membership_phone',
      ] as const),
      resourcePublicId:text(body.resourcePublicId,'联系方式版本',3,64),
      legalBasisReference:text(body.legalBasisReference,'保留依据',3,500),
      reason:text(body.reason,'保留原因',2,500),
      holdUntil:body.holdUntil==null?null:timestamp(body.holdUntil,'保留截止时间'),
    })
    return reply.code(201).send({ data })
  }))

  app.post<{ Params:{ publicId:string } }>(
    '/staff/personal-contact-governance/legal-holds/:publicId/release',
    async (request,reply) => handle(reply,async () => {
      const context=await staff(options,request,'privacy.contact.legal_hold')
      const body=object(request.body)
      return reply.send({ data:await options.service.releaseLegalHold(context,{
        publicId:publicId(request.params.publicId,'PCH'),reason:text(body.reason,'释放原因',2,500),
      }) })
    }),
  )
}

async function staff(options:Options,request:FastifyRequest,permission:string) {
  const context=await options.resolveStaffContext(request)
  await options.transactions.run(context.scope,async (transaction) => {
    await new StaffAccessRepository(transaction).assertPermission(context.employeeId,permission)
  },{ readOnly:true })
  return context
}

async function handle(reply:FastifyReply,run:()=>Promise<unknown>) {
  try { return await run() }
  catch (error) {
    if (isStaffAuthenticationRequiredError(error)) {
      return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    }
    if (error instanceof PersonalContactGovernanceError) {
      return reply.code(error.statusCode).send({ error:{ code:error.code,message:error.message } })
    }
    if (error instanceof CustomerExperienceRequestError) {
      return reply.code(error.statusCode).send({ error:{ code:error.code,message:error.message } })
    }
    if (error instanceof StaffAccessDeniedError) {
      return reply.code(403).send({ error:{ code:'CONTACT_GOVERNANCE_FORBIDDEN',message:'当前岗位无权执行该操作' } })
    }
    throw error
  }
}
function object(value:unknown):JsonObject {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new PersonalContactGovernanceError('请求内容格式无效','CONTACT_GOVERNANCE_INPUT_INVALID',400)
  return value as JsonObject
}
function text(value:unknown,label:string,min:number,max:number) {
  if (typeof value!=='string' || value.trim().length<min || value.trim().length>max) throw new PersonalContactGovernanceError(`${label}格式无效`,'CONTACT_GOVERNANCE_INPUT_INVALID',400)
  return value.trim()
}
function integer(value:unknown,label:string,min:number,max:number) {
  if (!Number.isSafeInteger(value) || Number(value)<min || Number(value)>max) throw new PersonalContactGovernanceError(`${label}格式无效`,'CONTACT_GOVERNANCE_INPUT_INVALID',400)
  return Number(value)
}
function enumeration<const T extends readonly string[]>(value:unknown,label:string,values:T):T[number] {
  if (typeof value!=='string' || !values.includes(value)) throw new PersonalContactGovernanceError(`${label}格式无效`,'CONTACT_GOVERNANCE_INPUT_INVALID',400)
  return value as T[number]
}
function timestamp(value:unknown,label:string) {
  const raw=text(value,label,20,40)
  const parsed=new Date(raw)
  if (!Number.isFinite(parsed.getTime()) || !/[zZ]|[+-][0-9]{2}:[0-9]{2}$/.test(raw)) {
    throw new PersonalContactGovernanceError(`${label}格式无效`,'CONTACT_GOVERNANCE_INPUT_INVALID',400)
  }
  return parsed.toISOString()
}
function publicId(value:string,prefix:string) {
  if (!new RegExp(`^${prefix}[0-9A-F]{32}$`).test(value)) throw new PersonalContactGovernanceError('资源编号格式无效','CONTACT_GOVERNANCE_INPUT_INVALID',400)
  return value
}
function idempotencyKey(request:FastifyRequest) {
  const value=request.headers['idempotency-key']
  if (typeof value!=='string' || value.trim().length<8 || value.trim().length>128) throw new PersonalContactGovernanceError('缺少有效的重试编号','CONTACT_GOVERNANCE_INPUT_INVALID',400)
  return value.trim()
}
