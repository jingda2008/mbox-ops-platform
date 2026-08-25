import { describe, expect, it } from 'vitest'
import { CustomerExperienceRequestError, CustomerExperienceService } from './customer-experience-service.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope={
  tenantId:'8b000000-0000-4000-8000-000000000001',
  storeId:'8b000000-0000-4000-8000-000000000002',
}
const context={
  scope,customerId:'8b000000-0000-4000-8000-000000000003',
  actorRef:'wechat-customer:birthday-test',businessDate:'2026-08-25',
}

describe('birthday benefit consent authority',()=>{
  it('rejects a different self-service birthday inside the 30-day cooling period',async()=>{
    const service=serviceWithPrevious({ birthday_month_day:'08-20',change_allowed:false })
    await expect(service.recordBirthdayBenefitConsent(context,{
      birthdayMonthDay:'08-25',idempotencyKey:'birthday-change-too-soon-0001',
    })).rejects.toMatchObject<CustomerExperienceRequestError>({
      code:'BIRTHDAY_CHANGE_TOO_FREQUENT',statusCode:409,
    })
  })

  it('writes the purpose consent and birthday in one command and audits the old and new values',async()=>{
    const observedSql:string[]=[]
    const service=serviceWithPrevious(
      { birthday_month_day:'07-25',change_allowed:true },
      observedSql,
    )
    const result=await service.recordBirthdayBenefitConsent(context,{
      birthdayMonthDay:'08-25',idempotencyKey:'birthday-authority-atomic-0001',
    })
    expect(result.value).toEqual({ birthdayMonthDay:'08-25',consentStatus:'granted' })
    expect(observedSql.some((sql)=>sql.includes('INSERT INTO mbox.customer_preferences'))).toBe(true)
    expect(observedSql.some((sql)=>sql.includes('INSERT INTO mbox.customer_annual_benefit_consents'))).toBe(true)
    expect(result.outcome.auditEvents[0]).toMatchObject({
      beforeData:{ birthdayMonthDay:'07-25' },
      afterData:{ birthdayMonthDay:'08-25',consentStatus:'granted' },
    })
  })
})

function serviceWithPrevious(
  previous:{ birthday_month_day:string|null;change_allowed:boolean },
  observedSql:string[]=[],
) {
  const transaction={
    scope,
    async query<Row extends Record<string,unknown>>(sql:string) {
      observedSql.push(sql)
      if (sql.includes('canonical_customer_id')) return { rows:[{ id:context.customerId }] as Row[],rowCount:1 }
      if (sql.includes("preference_key='birthdayMonthDay'")&&sql.includes('FOR UPDATE')) {
        return { rows:[previous] as Row[],rowCount:1 }
      }
      return { rows:[] as Row[],rowCount:1 }
    },
  } as unknown as ScopedTransaction
  return new CustomerExperienceService(
    { run:async()=>{ throw new Error('not used') } },
    { async execute<Result>(_command:unknown,handler:(current:ScopedTransaction)=>Promise<{
      result:Result;auditEvents:readonly unknown[];outboxMessages:readonly unknown[]
    }>) {
      const outcome=await handler(transaction)
      return { value:outcome.result,replayed:false,outcome }
    } } as never,
    { updateProfile:async()=>{ throw new Error('not used') } },
  )
}
