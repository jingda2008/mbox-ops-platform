import { describe, expect, it, vi } from 'vitest'
import type { ScopedTransaction } from './transaction-runner.js'
import { WechatLoyaltyNotificationWorker } from './wechat-loyalty-notification-worker.js'

const scope = {
  tenantId: '83000000-0000-4000-8000-000000000001',
  storeId: '83000000-0000-4000-8000-000000000002',
}

describe('WechatLoyaltyNotificationWorker', () => {
  it('preflights, consumes one exact authorization, resolves the same customer and records an accepted receipt', async () => {
    const statements: string[] = []
    const transaction = fakeTransaction((sql) => {
      statements.push(sql)
      if (sql.includes("FROM (VALUES('points_accrual')")) return activeOperationalStates()
      if (sql.includes('INSERT INTO mbox.wechat_customer_notification_jobs')
        && sql.includes("'loyalty_point_lot'")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT changed.id')) return {
        rows: [{
          id: '83000000-0000-4000-8000-000000000010',
          customer_id: '83000000-0000-4000-8000-000000000011',
          identity_external_id: 'wx-identity-customer-self',
          notification_type: 'loyalty_points_credited',
          template_id: 'wechat-template-points-credited',
          page_path: 'pages/profile/index',
          points_data_key: 'thing1',
          balance_data_key: 'number2',
          occurred_at_data_key: 'time3',
          expires_at_data_key: null,
          points_change: 20,
          points_at_risk: 0,
          balance_after: 320,
          event_occurred_at: '2026-08-16T02:00:00.000Z',
          expires_at: null,
        }],
        rowCount: 1,
      }
      if (sql.includes('RETURNING notification_job_id') && sql.includes('authorization_uses')) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const preflight = vi.fn(async () => undefined)
    const send = vi.fn(async () => ({
      outcome: 'accepted' as const,
      providerReference: 'provider-request-self-001',
    }))
    const resolveRecipient = vi.fn(async () => ({
      identityExternalId: 'wx-identity-customer-self', openId: 'openid-self',
    }))
    const worker = new WechatLoyaltyNotificationWorker(
      runner(transaction),
      { resolveMiniProgramNotificationRecipient: resolveRecipient },
      { preflight, send },
    )

    const result = await worker.runBatch(scope, 'worker-notification-01')

    expect(result).toMatchObject({ claimed: 1, accepted: ['83000000-0000-4000-8000-000000000010'] })
    expect(preflight).toHaveBeenCalledBefore(send)
    expect(resolveRecipient).toHaveBeenCalledWith(
      '83000000-0000-4000-8000-000000000011',
      'wx-identity-customer-self',
    )
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      recipientOpenId: 'openid-self', notificationType: 'loyalty_points_credited', pointsChange: 20,
    }))
    expect(statements.some((sql) => sql.includes('wechat_notification_authorization_uses'))).toBe(true)
    expect(statements.some((sql) => sql.includes('wechat_notification_receipts'))).toBe(true)
    expect(statements.some((sql) => /payload\s*->|snapshot\s*->|metadata\s*->/.test(sql))).toBe(false)
  })

  it('does not consume an authorization when provider preflight fails', async () => {
    const statements: string[] = []
    const transaction = fakeTransaction((sql) => {
      statements.push(sql)
      if (sql.includes("FROM (VALUES('points_accrual')")) return activeOperationalStates()
      return { rows: [], rowCount: 0 }
    })
    const worker = new WechatLoyaltyNotificationWorker(
      runner(transaction),
      { resolveMiniProgramNotificationRecipient: vi.fn() },
      { preflight: vi.fn(async () => { throw new Error('credentials unavailable') }), send: vi.fn() },
    )

    await expect(worker.runBatch(scope, 'worker-notification-02')).rejects.toThrow('credentials unavailable')
    expect(statements.some((sql) => sql.includes('INSERT INTO mbox.wechat_notification_authorization_uses'))).toBe(false)
  })

  it('does not preflight, lease a job or consume authorization while notification sending is paused', async () => {
    const statements:string[]=[]
    const transaction=fakeTransaction((sql)=>{
      statements.push(sql)
      if (sql.includes("FROM (VALUES('points_accrual')")) return {
        rows:[
          state('points_accrual','active'),state('points_redemption','active'),state('wechat_notification','paused'),
        ],rowCount:3,
      }
      return {rows:[],rowCount:0}
    })
    const preflight=vi.fn()
    const send=vi.fn()
    const worker=new WechatLoyaltyNotificationWorker(
      runner(transaction),{resolveMiniProgramNotificationRecipient:vi.fn()},{preflight,send},
    )
    const result=await worker.runBatch(scope,'worker-notification-paused')
    expect(result).toMatchObject({paused:true,expiryJobsCreated:0,claimed:0})
    expect(preflight).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(statements.some((sql)=>sql.includes('wechat_notification_authorization_uses'))).toBe(false)
  })
})

function activeOperationalStates() {
  return {rows:[state('points_accrual','active'),state('points_redemption','active'),state('wechat_notification','active')],rowCount:3}
}
function state(capability:string,currentState:string) {
  return {
    capability,state:currentState,control_version:currentState==='paused'?1:0,reason:null,review_at:null,
    changed_by_employee_id:null,changed_at:null,pending_accrual_count:0,
  }
}

function runner(transaction: ScopedTransaction) {
  return {
    run: async <Value>(
      _scope: typeof scope,
      operation: (current: ScopedTransaction) => Promise<Value> | Value,
    ) => operation(transaction),
  }
}

function fakeTransaction(
  query: (sql: string, values?: readonly unknown[]) => { rows: Record<string, unknown>[]; rowCount: number | null },
): ScopedTransaction {
  return {
    scope,
    query: async (sql, values) => query(sql, values),
  }
}
