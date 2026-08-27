import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wechatMemberServiceNotificationApiPlugin } from './wechat-member-service-notification-api.js'

const apps: ReturnType<typeof Fastify>[] = []
const scope = { tenantId:'83000000-0000-4000-8000-000000000001',storeId:'83000000-0000-4000-8000-000000000002' }

afterEach(async()=>{await Promise.all(apps.splice(0).map((app)=>app.close()));vi.restoreAllMocks()})

describe('WeChat member-service notification API',()=>{
  it('fails closed when the formal WeChat channel or a published template policy is unavailable',async()=>{
    const execute=vi.fn();const query=vi.fn();const app=Fastify();apps.push(app)
    await app.register(wechatMemberServiceNotificationApiPlugin,{transactions:{run:async(_scope,operation)=>operation({scope,query} as never)},commands:{execute},channelConfigured:false,
      resolvePublicContext:()=>({scope,customerId:'83000000-0000-4000-8000-000000000003',actorRef:'member-service-notice-customer',businessDate:'2026-08-27'}),})
    const options=await app.inject({method:'GET',url:'/public/mini/wechat-member-service-notification-authorizations'})
    expect(options.statusCode).toBe(200)
    expect(options.json()).toEqual({data:{available:false,authorizations:[]}})
    expect(query).not.toHaveBeenCalled()
    const record=await app.inject({method:'POST',url:'/public/mini/wechat-member-service-notification-authorizations',headers:{'idempotency-key':'member-service-notice-api-test-001'},payload:{
      notificationType:'member_benefit_issued',policyId:'83000000-0000-4000-8000-000000000004',policyVersion:1,
      templateId:'wechat-template-benefit-001',expectedVersion:0,platformResult:'accept',platformEventReference:'member-service-platform-event-001',
    }})
    expect(record.statusCode).toBe(503)
    expect(record.json()).toMatchObject({code:'WECHAT_MEMBER_SERVICE_NOTIFICATION_NOT_CONFIGURED'})
    expect(execute).not.toHaveBeenCalled()
  })
})
