import Fastify from 'fastify'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { personalContactGovernanceApiPlugin } from './personal-contact-governance-api.js'
import {
  PersonalContactGovernanceError,
  type PersonalContactGovernanceService,
} from './personal-contact-governance-service.js'
import type { ActivityContactProtectionKeyring } from './personal-contact-protection.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const scope={
  tenantId:'10000000-0000-4000-8000-000000000001',
  storeId:'10000000-0000-4000-8000-000000000002',
}
const customerContext={
  scope,customerId:'10000000-0000-4000-8000-000000000003',
  actorRef:'reservation-session:contact-governance',businessDate:'2026-08-16',
}
const staffContext={scope,employeeId:'10000000-0000-4000-8000-000000000004',businessDate:'2026-08-16'}
const apps:ReturnType<typeof Fastify>[]=[]

afterEach(async()=>{
  await Promise.all(apps.splice(0).map(app=>app.close()))
  vi.restoreAllMocks()
})

describe('personal contact governance API',()=>{
  it('uses the authenticated canonical context for contact correction and never emits plaintext protection evidence',async()=>{
    const updateMyActivityContact=vi.fn(async()=>({
      contactVersionPublicId:`ACV${'A'.repeat(32)}`,maskedContact:'138****8000',status:'active' as const,
    }))
    const protect=vi.fn(()=>({
      hash:'a'.repeat(64),encryptedBase64:Buffer.alloc(40,1).toString('base64'),
      keyId:'contact-key-v2',masked:'138****8000',
    }))
    const app=fixture({updateMyActivityContact},protect)
    const forged=await app.inject({
      method:'PUT',url:'/public/mini/activity-registrations/activity-registration-1234567890abcdef12345678/contact',
      headers:{'idempotency-key':'contact-correction-forged'},
      payload:{contactType:'phone',contactValue:'13800138000',customerId:'forged-customer'},
    })
    expect(forged.statusCode).toBe(400)
    expect(updateMyActivityContact).not.toHaveBeenCalled()

    const nonPhone = await app.inject({
      method:'PUT',url:'/public/mini/activity-registrations/activity-registration-1234567890abcdef12345678/contact',
      headers:{'idempotency-key':'contact-correction-non-phone'},
      payload:{contactType:'wechat',contactValue:'mbox_guest'},
    })
    expect(nonPhone.statusCode).toBe(400)
    expect(updateMyActivityContact).not.toHaveBeenCalled()

    const response=await app.inject({
      method:'PUT',url:'/public/mini/activity-registrations/activity-registration-1234567890abcdef12345678/contact',
      headers:{'idempotency-key':'contact-correction-valid'},
      payload:{contactType:'phone',contactValue:'13800138000'},
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers.pragma).toBe('no-cache')
    expect(updateMyActivityContact).toHaveBeenCalledWith(customerContext,expect.objectContaining({
      registrationPublicId:'activity-registration-1234567890abcdef12345678',
      contact:expect.objectContaining({contactHash:'a'.repeat(64),maskedContact:'138****8000'}),
    }))
    expect(response.body).not.toMatch(/13800138000|contactHash|encryptedContact|encryptionKeyId|customerId|actorRef/)
  })

  it('marks success and every reveal error no-store while exposing only the short-lived contact value',async()=>{
    vi.spyOn(StaffAccessRepository.prototype,'assertPermission').mockResolvedValue(undefined)
    const revealActivityContact=vi.fn(async()=>({
      contactType:'phone',contactValue:'13800138000',maskedContact:'138****8000',
      expiresAt:'2026-08-16T12:00:30.000Z',
    }))
    const app=fixture({revealActivityContact})
    const success=await app.inject({
      method:'POST',url:`/staff/activity-contacts/ACV${'B'.repeat(32)}/reveal`,
      headers:{'idempotency-key':'contact-reveal-success'},payload:{purpose:'attendance_coordination'},
    })
    expect(success.statusCode).toBe(200)
    expect(success.headers['cache-control']).toContain('no-store')
    expect(success.headers.pragma).toBe('no-cache')
    expect(success.body).toContain('13800138000')
    expect(success.body).not.toMatch(/contactHash|encryptedContact|encryptionKeyId|keyId|employeeId|customerId|actorRef/)

    revealActivityContact.mockRejectedValueOnce(new PersonalContactGovernanceError(
      '当前联系用途已结束','ACTIVITY_CONTACT_REVEAL_DENIED',409,
    ))
    const denied=await app.inject({
      method:'POST',url:`/staff/activity-contacts/ACV${'B'.repeat(32)}/reveal`,
      headers:{'idempotency-key':'contact-reveal-denied'},payload:{purpose:'attendance_coordination'},
    })
    expect(denied.statusCode).toBe(409)
    expect(denied.headers['cache-control']).toContain('no-store')
    expect(denied.body).not.toContain('13800138000')
  })

  it('returns policy display names without employee ids or protected contact material',async()=>{
    vi.spyOn(StaffAccessRepository.prototype,'assertPermission').mockResolvedValue(undefined)
    const listPolicies=vi.fn(async()=>[{
      publicId:`PCR${'C'.repeat(32)}`,resourceKind:'activity_registration_contact',version:1,
      status:'published',retentionDaysAfterPurposeEnd:30,legalBasisReference:'MBOX-PRIVACY-V1',
      draftedBy:'店长',approvedBy:'运营负责人',publishedBy:'最高管理人',
      publicationReason:'审批后发布',publishedAt:'2026-08-16T12:00:00.000Z',
      effectiveFrom:'2026-08-16T12:00:00.000Z',effectiveUntil:null,createdAt:'2026-08-16T11:00:00.000Z',
    }])
    const app=fixture({listPolicies})
    const response=await app.inject({method:'GET',url:'/staff/personal-contact-governance/policies'})
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.body).toContain('最高管理人')
    expect(response.body).not.toMatch(/EmployeeId|employeeId|contactHash|encrypted|keyId|internal/)
  })

  it('lists only selectable public resources and non-sensitive governance evidence',async()=>{
    vi.spyOn(StaffAccessRepository.prototype,'assertPermission').mockResolvedValue(undefined)
    const listEvidence=vi.fn(async()=>({
      eligibleResources:[{
        publicId:`ACV${'D'.repeat(32)}`,resourceKind:'activity_registration_contact',
        maskedContact:'138****8000',businessLabel:'周末音乐活动',status:'confirmed',
      }],holds:[],dispositions:[],
    }))
    const app=fixture({listEvidence})
    const response=await app.inject({method:'GET',url:'/staff/personal-contact-governance/evidence'})
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.json().data.eligibleResources[0]).toEqual(expect.objectContaining({
      publicId:`ACV${'D'.repeat(32)}`,maskedContact:'138****8000',businessLabel:'周末音乐活动',
    }))
    expect(response.body).not.toMatch(/customerId|memberNo|employeeId|contactHash|encrypted|keyId/)
  })
})

function fixture(serviceMethods:Record<string,unknown>,protect=()=>({
  hash:'a'.repeat(64),encryptedBase64:Buffer.alloc(40,1).toString('base64'),
  keyId:'contact-key-v2',masked:'138****8000',
})){
  const app=Fastify()
  apps.push(app)
  const transactions={run:async (_scope:unknown,operation:(transaction:unknown)=>Promise<unknown>)=>operation({
    scope,query:vi.fn(async()=>({rows:[]})),
  })} as unknown as Pick<ScopedPostgresTransactionRunner,'run'>
  void app.register(personalContactGovernanceApiPlugin,{
    transactions,
    service:serviceMethods as unknown as PersonalContactGovernanceService,
    protection:{protect} as unknown as ActivityContactProtectionKeyring,
    resolvePublicContext:()=>customerContext,
    resolveStaffContext:()=>staffContext,
  })
  return app
}
