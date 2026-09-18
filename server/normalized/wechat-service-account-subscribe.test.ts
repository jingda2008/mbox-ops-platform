import Fastify from 'fastify'
import {createHmac} from 'node:crypto'
import {expect,it,vi} from 'vitest'
import {wechatServiceAccountSubscribePlugin} from './wechat-service-account-subscribe.js'
const now=1789570000000
const config={appId:'wxTestService01',appSecret:'test-secret-value-123',activityTemplateId:'activity-template-test',couponTemplateId:'coupon-template-test',codeTemplateId:'code-template-test',miniProgramAppId:'wxTestMini01',publicOrigin:'https://mbox.example.test',stateSecret:'test-state-secret-value-123'}
function signed(value:string){const body=Buffer.from(value).toString('base64url');return body+'.'+createHmac('sha256',config.stateSecret).update(body).digest('base64url')}
it('preserves subscribe entry and OAuth page with private signed identity and no send side effect',async()=>{
 const app=Fastify(),fetchImpl=vi.fn(async()=>new Response(JSON.stringify({openid:'openid-test-12345'})))
 await app.register(wechatServiceAccountSubscribePlugin,{prefix:'/api',config,now:()=>now,fetchImpl})
 const initial=await app.inject('/api/wechat/service-account/subscribe');expect(initial.statusCode).toBe(302);expect(initial.headers['cache-control']).toBe('no-store')
 const state=new URL(String(initial.headers.location)).searchParams.get('state')!
 const page=await app.inject('/api/wechat/service-account/subscribe?code=code&state='+encodeURIComponent(state));expect(page.statusCode).toBe(200);expect(page.body).toContain('wx-open-subscribe');expect(fetchImpl).toHaveBeenCalledTimes(1)
 expect((await app.inject('/api/wechat/service-account/subscribe?code=code&state='+signed('subscribe:'+(now-600001)))).statusCode).toBe(403)
 await app.close()
})
it('rejects unsigned or mismatched callback recipients and forged origin without calling provider',async()=>{
 const app=Fastify(),fetchImpl=vi.fn(async()=>new Response('{}'))
 await app.register(wechatServiceAccountSubscribePlugin,{prefix:'/api',config,now:()=>now,fetchImpl})
 const base='/api/wechat/service-account/subscribe/result?action=confirm&template_id='+config.activityTemplateId+'&openid=victim-openid123'
 expect((await app.inject(base)).statusCode).toBe(403)
 expect((await app.inject(base+'&reserved='+signed('openid:other-openid123:'+now))).statusCode).toBe(403)
 expect((await app.inject('/api/wechat/service-account/subscribe/jssdk-config?url='+encodeURIComponent(config.publicOrigin+'.evil.test/api/wechat/service-account/subscribe'))).statusCode).toBe(400)
 expect((await app.inject({method:'POST',url:'/api/wechat/service-account/subscribe/send-test',payload:{openIdToken:'fake',acceptedTemplateIds:[config.activityTemplateId]}})).statusCode).toBe(403)
 expect(fetchImpl).not.toHaveBeenCalled();await app.close()
})
it('only sends the explicitly accepted configured template for the signed identity',async()=>{
 const app=Fastify(),fetchImpl=vi.fn(async(url: string|URL|Request)=>new Response(JSON.stringify(String(url).includes('/token?')?{access_token:'test-token',expires_in:7200}:{errcode:0})))
 await app.register(wechatServiceAccountSubscribePlugin,{prefix:'/api',config,now:()=>now,fetchImpl})
 const response=await app.inject({method:'POST',url:'/api/wechat/service-account/subscribe/send-test',payload:{openIdToken:signed('openid:verified-openid123:'+now),acceptedTemplateIds:[config.activityTemplateId,'unconfigured']}})
 expect(response.statusCode).toBe(200);expect(response.json().sends).toEqual([{templateId:config.activityTemplateId,ok:true}]);expect(fetchImpl).toHaveBeenCalledTimes(2)
 const call=fetchImpl.mock.calls[1] as unknown as [string,RequestInit];expect(JSON.parse(String(call[1].body))).toMatchObject({touser:'verified-openid123',template_id:config.activityTemplateId});await app.close()
})
