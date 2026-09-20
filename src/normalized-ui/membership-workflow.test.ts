import {describe,it,expect} from 'vitest'
import {beijingDateTimeIso,beijingDateTimeInput,membershipPublicationPath,type MembershipDomain} from './membership-workflow'
describe('membership publication contracts',()=>{
  it('uses Beijing time and rejects invalid calendar dates',()=>{
    expect(beijingDateTimeIso('2026-09-20T18:30')).toBe('2026-09-20T10:30:00.000Z')
    expect(beijingDateTimeInput('2026-09-20T10:30:00Z')).toBe('2026-09-20T18:30')
    expect(()=>beijingDateTimeIso('2026-02-30T18:30')).toThrow()
    expect(()=>beijingDateTimeIso('tomorrow')).toThrow()
  })
  it('uses the version number for terms and UUID for the other six domains',()=>{
    expect(membershipPublicationPath('membership_terms','uuid',8)).toBe('/api/staff/membership-terms/8/publish')
    for(const domain of ['base_points','tier_policy','tier_benefits','redemption_catalog','promotion_points','wechat_notifications'] as MembershipDomain[])expect(membershipPublicationPath(domain,'uuid',8)).toMatch(/\/uuid\/publish$/)
  })
})
