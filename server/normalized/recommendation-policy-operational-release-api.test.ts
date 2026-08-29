import Fastify,{type FastifyInstance} from 'fastify'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { customerExperienceApiPlugin } from './customer-experience-api.js'
import type { CustomerExperienceService } from './customer-experience-service.js'
import { StaffAccessDeniedError,StaffAccessRepository } from './staff-access-repository.js'

const apps:FastifyInstance[]=[]
afterEach(async()=>{await Promise.all(apps.splice(0).map((app)=>app.close()));vi.restoreAllMocks()})

describe('recommendation policy operational API',()=>{
  it('uses distinct view, draft, approve and publish permissions and keeps rollout an owner action',async()=>{
    const checkedPermissions:string[]=[]
    vi.spyOn(StaffAccessRepository.prototype,'assertPermission').mockImplementation(async(_employeeId,permission)=>{
      checkedPermissions.push(permission)
      return {} as never
    })
    const service={
      recommendationPolicyConfiguration:vi.fn(async()=>({
        feature:{rolloutState:'disabled',reason:'未开放',effectiveFrom:null,updatedAt:'2026-08-16T00:00:00Z'},policies:[],
      })),
      createRecommendationPolicy:vi.fn(async()=>({value:{publicId:'recommendation-policy-api-v1',code:'DEFAULT',version:1,status:'draft'},replayed:false})),
      approveRecommendationPolicy:vi.fn(async()=>({value:{publicId:'recommendation-policy-api-v1',status:'approved'},replayed:false})),
      publishRecommendationPolicy:vi.fn(async()=>({value:{publicId:'recommendation-policy-api-v1',status:'published',effectiveFrom:'2026-08-20T10:00:00.000Z'},replayed:false})),
      cloneRecommendationPolicyDraft:vi.fn(async()=>({value:{publicId:'recommendation-policy-api-v2',code:'DEFAULT',version:2,status:'draft'},replayed:false})),
      setFeature:vi.fn(async()=>({value:{featureCode:'recommendation.engine',rolloutState:'pilot'},replayed:false})),
    }
    const app=fixture(service)
    const responses=await Promise.all([
      app.inject({method:'GET',url:'/staff/customer-experience/recommendation-policies'}),
      app.inject({method:'POST',url:'/staff/customer-experience/recommendation-policies',headers:{'idempotency-key':'recommendation-policy-create-api-001'},payload:{
        code:'DEFAULT',preferenceWeight:100,sceneWeight:60,marginWeight:50,priorityWeight:50,
        performanceWeight:0,inventoryWeight:0,capacityWeight:0,minimumGrossMarginBasisPoints:1500,
        preferenceHalfLifeDays:90,preferenceMaxAgeDays:730,preferenceMinEffectiveScore:1000,
        preferenceMinConfidenceBasisPoints:2500,explanationTemplate:'按当前可售条件提供建议',draftReason:'影子样本调整',
      }}),
      app.inject({method:'POST',url:'/staff/customer-experience/recommendation-policies/recommendation-policy-api-v1/approve',headers:{'idempotency-key':'recommendation-policy-approve-api-001'},payload:{reason:'独立复核通过'}}),
      app.inject({method:'POST',url:'/staff/customer-experience/recommendation-policies/recommendation-policy-api-v1/publish',headers:{'idempotency-key':'recommendation-policy-publish-api-001'},payload:{effectiveFrom:'2026-08-20T10:00:00Z',reason:'第三人排期发布'}}),
      app.inject({method:'POST',url:'/staff/customer-experience/recommendation-policies/recommendation-policy-api-v1/clone-draft',headers:{'idempotency-key':'recommendation-policy-clone-api-001'},payload:{reason:'从稳定版回退起草'}}),
      app.inject({method:'PUT',url:'/staff/customer-experience/features/recommendation.engine',headers:{'idempotency-key':'recommendation-rollout-api-001'},payload:{rolloutState:'pilot',configuration:{},reason:'限定岗位和样本试点'}}),
    ])
    expect(responses.map((response)=>response.statusCode)).toEqual([200,201,200,200,201,200])
    expect(checkedPermissions).toEqual(expect.arrayContaining([
      'recommendation.rule.view','recommendation.rule.draft','recommendation.rule.approve','recommendation.rule.publish',
    ]))
    expect(checkedPermissions.filter((permission)=>permission==='recommendation.rule.publish')).toHaveLength(2)
    expect(checkedPermissions).not.toContain('customer.experience.feature.manage')
    expect(service.createRecommendationPolicy).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({draftReason:'影子样本调整'}))
    expect(service.approveRecommendationPolicy).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({reason:'独立复核通过'}))
    expect(service.publishRecommendationPolicy).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
      effectiveFrom:'2026-08-20T10:00:00.000Z',reason:'第三人排期发布',
    }))
  })

  it('does not call the service when a role lacks the transition permission',async()=>{
    vi.spyOn(StaffAccessRepository.prototype,'assertPermission').mockImplementation(async(_employeeId,permission)=>{
      if(permission==='recommendation.rule.approve')throw new StaffAccessDeniedError(permission)
      return {} as never
    })
    const approveRecommendationPolicy=vi.fn()
    const app=fixture({approveRecommendationPolicy})
    const response=await app.inject({
      method:'POST',url:'/staff/customer-experience/recommendation-policies/recommendation-policy-api-v1/approve',
      headers:{'idempotency-key':'recommendation-policy-denied-api-001'},payload:{reason:'不应进入服务'},
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({error:{code:'PERMISSION_DENIED',message:'当前岗位没有这项权限'}})
    expect(approveRecommendationPolicy).not.toHaveBeenCalled()
  })

  it('serves the versioned three-question configuration only after table-session authority resolves',async()=>{
    const recommendationInputConfiguration=vi.fn(async()=>({
      policyPublicId:'recommendation-policy-input-v1',policyVersion:3,
      inputConfiguration:{version:1,questions:[
        {code:'occasion',title:'今晚想怎么坐坐？',options:[]},
        {code:'alcoholPreference',title:'更想喝点什么？',options:[]},
        {code:'experienceLevel',title:'今晚想要什么节奏？',options:[]},
      ],strategy:{paidOrderHistoryWeight:100,multiGuestHistoryConfidenceBasisPoints:2500,
        shakeExcludes:['exposed','cart','ordered','rejected']},
      },
    }))
    const app=guestConfigurationFixture({recommendationInputConfiguration})
    const response=await app.inject({method:'GET',url:'/guest/experience/recommendations/configuration'})
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.json()).toMatchObject({data:{
      policyPublicId:'recommendation-policy-input-v1',policyVersion:3,
      inputConfiguration:{questions:[{code:'occasion'},{code:'alcoholPreference'},{code:'experienceLevel'}]},
    }})
    expect(recommendationInputConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      tableSessionId:'82000000-0000-4000-8000-000000000004',partySize:2,
    }))
  })

  it('accepts the server-owned three answers and defaults service intensity to balanced',async()=>{
    const recommend=vi.fn(async()=>({
      value:{publicId:'recommendation-three-question-v1',answers:{},recommendations:[],missingTiers:[],
        policyPublicId:'recommendation-policy-input-v1',policyVersion:1,inputConfiguration:{}},replayed:false,
    }))
    const app=guestConfigurationFixture({recommend})
    const response=await app.inject({
      method:'POST',url:'/guest/experience/recommendations',headers:{'idempotency-key':'recommendation-three-question-api-001'},
      payload:{recommendationIntent:'guided',occasion:'friends',alcoholPreference:'mixed',experienceLevel:'enhanced'},
    })
    expect(response.statusCode).toBe(201)
    expect(recommend).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
      occasion:'friends',alcoholPreference:'mixed',experienceLevel:'enhanced',serviceIntensity:'balanced',
    }), 'recommendation-three-question-api-001','guided')
  })
})

function fixture(service:Record<string,ReturnType<typeof vi.fn>>){
  const app=Fastify();apps.push(app)
  const scope={tenantId:'82000000-0000-4000-8000-000000000001',storeId:'82000000-0000-4000-8000-000000000002'}
  const transaction={scope,query:vi.fn()}
  void app.register(customerExperienceApiPlugin,{
    transactions:{run:async(_scope,operation)=>operation(transaction as never)},
    service:service as unknown as CustomerExperienceService,
    resolvePublicContext:()=>{throw new Error('not used')},resolveGuestContext:async()=>{throw new Error('not used')},
    resolveStaffContext:()=>({scope,employeeId:'82000000-0000-4000-8000-000000000003',businessDate:'2026-08-16'}),
    protectContact:()=>{throw new Error('not used')},
  })
  return app
}

function guestConfigurationFixture(service:Record<string,ReturnType<typeof vi.fn>>){
  const app=Fastify();apps.push(app)
  const scope={tenantId:'82000000-0000-4000-8000-000000000001',storeId:'82000000-0000-4000-8000-000000000002'}
  const transaction={scope,query:vi.fn(async()=>({rows:[{guest_count:2,guest_profile_snapshot:{}}],rowCount:1}))}
  void app.register(customerExperienceApiPlugin,{
    transactions:{run:async(_scope,operation)=>operation(transaction as never)},
    service:service as unknown as CustomerExperienceService,
    resolvePublicContext:()=>{throw new Error('not used')},
    resolveGuestContext:()=>({
      scope,customerId:'82000000-0000-4000-8000-000000000003',
      tableSessionId:'82000000-0000-4000-8000-000000000004',businessDate:'2026-08-16',actorRef:'guest:test',
    }),
    resolveStaffContext:()=>{throw new Error('not used')},
    protectContact:()=>{throw new Error('not used')},
  })
  return app
}
