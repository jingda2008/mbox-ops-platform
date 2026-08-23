import Fastify from 'fastify'
import { describe,expect,it,vi } from 'vitest'
import { memberContentCardApiPlugin } from './member-content-card-api.js'
import type { MemberContentCardService } from './member-content-card-service.js'

const context={
  scope:{tenantId:'10000000-0000-4000-8000-000000000001',storeId:'10000000-0000-4000-8000-000000000002'},
  employeeId:'10000000-0000-4000-8000-000000000003',businessDate:'2026-08-20',
}

describe('member home content management API',()=>{
  it('lets managers save a typed draft and requires publish authority separately',async()=>{
    const service=fakeService();const permissions:string[]=[]
    const app=await build(service,async(_employeeId,permission)=>{permissions.push(permission)})
    const created=await app.inject({method:'POST',url:'/staff/home-content-cards',headers:{'idempotency-key':'home-content-create-001'},payload:draft()})
    const published=await app.inject({method:'POST',url:'/staff/home-content-cards/mbox-story-1999/publish',headers:{'idempotency-key':'home-content-publish-001'},payload:{reason:'管理人员确认品牌内容和排期'}})
    expect(created.statusCode).toBe(201);expect(published.statusCode).toBe(200)
    expect(permissions).toEqual(['community.activity.manage','community.activity.publish'])
    expect(service.create).toHaveBeenCalledWith(context,expect.objectContaining({draft:expect.objectContaining({type:'article',displayMode:'pinned',visibility:'public'})}))
    expect(service.publish).toHaveBeenCalledWith(context,expect.objectContaining({code:'mbox-story-1999'}))
    await app.close()
  })

  it('rejects external links, external images, and invalid display windows before writing',async()=>{
    const service=fakeService();const app=await build(service,async()=>{})
    const external=await app.inject({method:'POST',url:'/staff/home-content-cards',headers:{'idempotency-key':'home-content-invalid-001'},payload:{...draft(),targetPath:'https://example.com'}})
    const image=await app.inject({method:'POST',url:'/staff/home-content-cards',headers:{'idempotency-key':'home-content-invalid-002'},payload:{...draft(),imageUrl:'https://example.com/unbounded-story.png'}})
    const window=await app.inject({method:'POST',url:'/staff/home-content-cards',headers:{'idempotency-key':'home-content-invalid-003'},payload:{...draft(),validUntil:'2026-08-19T20:00:00+08:00'}})
    const mode=await app.inject({method:'POST',url:'/staff/home-content-cards',headers:{'idempotency-key':'home-content-invalid-004'},payload:{...draft(),displayMode:'popup'}})
    expect(external.statusCode).toBe(400);expect(image.statusCode).toBe(400);expect(window.statusCode).toBe(400);expect(mode.statusCode).toBe(400)
    expect(image.json().error.message).toContain('图片必须从站内图片库选择')
    expect(service.create).not.toHaveBeenCalled();await app.close()
  })

  it('uses a publish-authorized pause so content can disappear without a release',async()=>{
    const service=fakeService();const permissions:string[]=[]
    const app=await build(service,async(_employeeId,permission)=>{permissions.push(permission)})
    const response=await app.inject({method:'POST',url:'/staff/home-content-cards/mbox-story-1999/pause',headers:{'idempotency-key':'home-content-pause-001'},payload:{reason:'活动结束后暂停首页曝光'}})
    expect(response.statusCode).toBe(200);expect(permissions).toEqual(['community.activity.publish'])
    expect(service.pause).toHaveBeenCalledOnce();await app.close()
  })
})

async function build(service:ReturnType<typeof fakeService>,assertPermission:(employeeId:string,permission:string)=>Promise<void>){
  const app=Fastify()
  await app.register(memberContentCardApiPlugin,{
    transactions:{run:async(_scope,handler)=>handler({scope:context.scope} as never)},
    service:service as unknown as MemberContentCardService,resolveStaffContext:()=>context,
    createStaffAccessRepository:()=>({assertPermission}),
  })
  return app
}

function fakeService(){const value={code:'mbox-story-1999',status:'draft'};return{
  list:vi.fn(async()=>[]),create:vi.fn(async()=>({value,replayed:false})),
  update:vi.fn(async()=>({value,replayed:false})),publish:vi.fn(async()=>({value:{...value,status:'published'},replayed:false})),
  pause:vi.fn(async()=>({value:{...value,status:'paused'},replayed:false})),
}}
function draft(){return{
  code:'mbox-story-1999',type:'article',title:'从1999开始',summary:'关于上海、现场与M-BOX的真实故事。',imageUrl:'/api/public/media-assets/MA00000000000000000000000000000001',
  ctaLabel:'阅读故事',targetPath:'/pages/home/index',priority:100,displayMode:'pinned',visibility:'public',audienceMemberLevels:[],audienceLifecycleStages:[],
  validFrom:'2026-08-20T20:00:00+08:00',validUntil:'2026-09-20T20:00:00+08:00',reason:'建立M-BOX品牌故事首页内容',
}}
