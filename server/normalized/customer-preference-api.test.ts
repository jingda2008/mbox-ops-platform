import Fastify from 'fastify'
import { describe,expect,it } from 'vitest'
import { customerPreferenceApiPlugin } from './customer-preference-api.js'
import type { CustomerPreferenceService } from './customer-preference-service.js'

const snapshot={
  canonicalCustomerId:'10000000-0000-4000-8000-000000000003',
  facts:[{
    key:'beverage.family',value:'wine',status:'active' as const,confidence:0.8,
    supportScore:8000,contraryScore:1000,netScore:7000,
    supportingEvidenceCount:2,contraryEvidenceCount:1,
    lastEvidenceAt:'2026-08-16T12:00:00.000Z',validUntil:null,
    calculatedAt:'2026-08-16T12:01:00.000Z',
  }],
  sources:[{
    publicId:'preference-source-001',sourceKind:'observation_evidence' as const,
    key:'beverage.family',value:'wine',polarity:'supports' as const,
    allowedForRecommendation:true as const,validUntil:null,
    createdAt:'2026-08-16T12:00:00.000Z',withdrawn:false,
  }],
}

describe('customer preference public API',()=>{
  it('derives customer ownership from the authenticated context and never accepts a customer id',async()=>{
    const calls:Array<{kind:string;input?:unknown}>=[]
    const service={
      list:async()=>{calls.push({kind:'list'});return snapshot},
      declare:async(_context:unknown,input:unknown)=>{calls.push({kind:'declare',input});return{value:snapshot,replayed:false}},
      withdraw:async(_context:unknown,input:unknown)=>{calls.push({kind:'withdraw',input});return{value:snapshot,replayed:false}},
    } as unknown as CustomerPreferenceService
    const app=Fastify()
    await app.register(customerPreferenceApiPlugin,{
      service,
      resolvePublicContext:()=>({
        scope:{tenantId:'10000000-0000-4000-8000-000000000001',storeId:'10000000-0000-4000-8000-000000000002'},
        customerId:'10000000-0000-4000-8000-000000000003',actorRef:'reservation-session:test',businessDate:'2026-08-16',
      }),
    })
    const listed=await app.inject({method:'GET',url:'/public/mini/preferences'})
    expect(listed.statusCode).toBe(200)
    expect(listed.json().data).toMatchObject({
      facts:[{key:'beverage.family',value:'wine',supportingEvidenceCount:2,contraryEvidenceCount:1}],
      sources:[{publicId:'preference-source-001',sourceKind:'observation_evidence'}],
    })
    expect(JSON.stringify(listed.json().data)).not.toMatch(/canonicalCustomerId|confidence|supportScore|contraryScore|netScore|calculatedAt|actorRef|rawContent/)
    const forged=await app.inject({method:'POST',url:'/public/mini/preferences',headers:{'idempotency-key':'preference-api-forged'},payload:{
      customerId:'forged-customer',key:'beverage.family',value:'wine',polarity:'supports',
    }})
    expect(forged.statusCode).toBe(400)
    const declared=await app.inject({method:'POST',url:'/public/mini/preferences',headers:{'idempotency-key':'preference-api-001'},payload:{
      key:'beverage.family',value:'wine',polarity:'supports',
    }})
    expect(declared.statusCode).toBe(201)
    expect(JSON.stringify(declared.json().data)).not.toMatch(/canonicalCustomerId|confidence|supportScore|contraryScore|netScore|calculatedAt/)
    expect(calls[1]).toMatchObject({kind:'declare',input:{key:'beverage.family',value:'wine',polarity:'supports'}})

    const withdrawn=await app.inject({method:'POST',url:'/public/mini/preferences/preference-source-001/withdraw',
      headers:{'idempotency-key':'preference-api-002'},payload:{reason:'本人确认这条记录不准确'}})
    expect(withdrawn.statusCode).toBe(200)
    expect(JSON.stringify(withdrawn.json().data)).not.toMatch(/canonicalCustomerId|confidence|supportScore|contraryScore|netScore|calculatedAt/)
    expect(calls[2]).toMatchObject({kind:'withdraw',input:{sourcePublicId:'preference-source-001'}})
    await app.close()
  })

  it('rejects unsupported runtime keys and malformed beverage values before the service',async()=>{
    const app=Fastify()
    await app.register(customerPreferenceApiPlugin,{
      service:{declare:async()=>{throw new Error('must not run')}} as unknown as CustomerPreferenceService,
      resolvePublicContext:()=>({
        scope:{tenantId:'10000000-0000-4000-8000-000000000001',storeId:'10000000-0000-4000-8000-000000000002'},
        customerId:'10000000-0000-4000-8000-000000000003',actorRef:'reservation-session:test',businessDate:'2026-08-16',
      }),
    })
    const unsupported=await app.inject({method:'POST',url:'/public/mini/preferences',headers:{'idempotency-key':'preference-api-003'},payload:{key:'internal.vipScore',value:'999',polarity:'supports'}})
    const malformed=await app.inject({method:'POST',url:'/public/mini/preferences',headers:{'idempotency-key':'preference-api-004'},payload:{key:'beverage.family',value:'secret_family',polarity:'supports'}})
    expect(unsupported.statusCode).toBe(400)
    expect(malformed.statusCode).toBe(400)
    await app.close()
  })
})
