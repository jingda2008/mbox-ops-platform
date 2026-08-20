import { describe,expect,it } from 'vitest'
import {
  CustomerExperienceRepository,
  recommendationOperationalSignalContribution,
} from './customer-experience-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope={
  tenantId:'10000000-0000-4000-8000-000000000001',
  storeId:'10000000-0000-4000-8000-000000000002',
}

describe('recommendation operational scoring',()=>{
  it('normalizes authoritative signal basis points without allowing over-cap amplification',()=>{
    expect(recommendationOperationalSignalContribution(240,10_000)).toBe(240)
    expect(recommendationOperationalSignalContribution(240,5_000)).toBe(120)
    expect(recommendationOperationalSignalContribution(240,20_000)).toBe(240)
    expect(recommendationOperationalSignalContribution(240,-1)).toBe(0)
    expect(recommendationOperationalSignalContribution(-240,5_000)).toBe(-120)
    expect(()=>recommendationOperationalSignalContribution(1,0.5)).toThrow(/safe integer/)
  })

  it('accepts non-zero operational weights as an immutable draft instead of a readiness placeholder',async()=>{
    const queries:Array<{sql:string;values:readonly unknown[]}>=[]
    const transaction={
      scope,
      query:async(sql:string,values:readonly unknown[]=[])=>{
        queries.push({sql,values})
        if(sql.includes('INSERT INTO mbox.recommendation_policy_versions')) return { rows:[{
          public_id:'policy-operational-signal-v1',policy_code:'DEFAULT',version:4,status:'draft',
        }],rowCount:1 }
        return { rows:[],rowCount:0 }
      },
    } as unknown as ScopedTransaction
    const result=await new CustomerExperienceRepository(transaction).createRecommendationPolicy({
      publicId:'policy-operational-signal-v1',code:'DEFAULT',employeeId:'10000000-0000-4000-8000-000000000003',
      preferenceWeight:100,sceneWeight:80,marginWeight:60,priorityWeight:40,
      performanceWeight:30,inventoryWeight:20,capacityWeight:10,
      minimumGrossMarginBasisPoints:1500,preferenceHalfLifeDays:30,preferenceMaxAgeDays:90,
      preferenceMinEffectiveScore:100,preferenceMinConfidenceBasisPoints:5000,
      explanationTemplate:'权威运行信号测试',displayConfiguration:{},draftReason:'验证强类型运行评分',
    })
    expect(result).toEqual({ publicId:'policy-operational-signal-v1',code:'DEFAULT',version:4,status:'draft' })
    const insert=queries.find((query)=>query.sql.includes('INSERT INTO mbox.recommendation_policy_versions'))
    expect(insert?.values).toEqual(expect.arrayContaining([30,20,10]))
  })
})
