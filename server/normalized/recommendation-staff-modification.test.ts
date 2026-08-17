import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { recommendationStaffModificationApiPlugin } from './recommendation-staff-modification-api.js'
import {
  RecommendationStaffModificationRepository,
} from './recommendation-staff-modification-repository.js'
import { RecommendationStaffModificationService } from './recommendation-staff-modification-service.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '10000000-0000-4000-8000-000000000002',
}
const employeeId = '10000000-0000-4000-8000-000000000003'
const tableSessionId = '10000000-0000-4000-8000-000000000004'
const sourceProductId = '10000000-0000-4000-8000-000000000005'
const targetProductId = '10000000-0000-4000-8000-000000000006'
const recommendationPublicId = 'recommendation-staff-test'

describe('recommendation staff modification authority', () => {
  it('lists only a current assigned table recommendation from strong option rows', async () => {
    const queries: string[] = []
    const transaction = {
      scope,
      query: async (sql: string) => {
        queries.push(sql)
        if (sql.includes('AS active,EXISTS')) return { rows: [{ active: true,assigned: true }],rowCount: 1 }
        return { rows: [{
          recommendation_public_id: recommendationPublicId,table_session_id: tableSessionId,
          recommendation_created_at: '2026-08-16T01:00:00.000Z',product_id: sourceProductId,
          product_name: '舒适方案',rank: 1,tier: 'comfortable',amount_minor: '12800',currency: 'CNY',
        }],rowCount: 1 }
      },
    } as unknown as ScopedTransaction
    const result = await new RecommendationStaffModificationRepository(transaction)
      .latestForTable(tableSessionId,employeeId,false)
    expect(result).toMatchObject({ recommendationPublicId,options: [{ amountMinor: 12800,rank: 1 }] })
    expect(queries.join('\n')).toContain("assignment.assignment_type IN ('primary','backup','temporary')")
    expect(queries.join('\n')).not.toMatch(/snapshot\s*(?:->|#>>|#>)/)
  })

  it('rejects a direct cross-table write before loading or inserting a modification', async () => {
    const queries: string[] = []
    const transaction = {
      scope,
      query: async (sql: string) => {
        queries.push(sql)
        return { rows: [{ active: true,assigned: false }],rowCount: 1 }
      },
    } as unknown as ScopedTransaction
    await expect(new RecommendationStaffModificationRepository(transaction)
      .latestForTable(tableSessionId,employeeId,false)).rejects.toMatchObject({
        code: 'RECOMMENDATION_TABLE_SCOPE_DENIED',statusCode: 403,
      })
    expect(queries).toHaveLength(1)
  })

  it('records source, target, employee, reason and idempotency as strong fields', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = []
    const transaction = {
      scope,
      query: async (sql: string,values: readonly unknown[] = []) => {
        queries.push({ sql,values })
        if (sql.includes('source_option.id AS source_option_id')) return { rows: [{
          recommendation_session_id: '10000000-0000-4000-8000-000000000011',
          recommendation_public_id: recommendationPublicId,table_session_id: tableSessionId,
          source_option_id: '10000000-0000-4000-8000-000000000012',source_product_id: sourceProductId,
          source_product_name: '舒适方案',target_option_id: '10000000-0000-4000-8000-000000000013',
          target_product_id: targetProductId,target_product_name: '完整体验',
        }],rowCount: 1 }
        if (sql.includes('AS active,EXISTS')) return { rows: [{ active: true,assigned: true }],rowCount: 1 }
        return { rows: [{ event_id: '10000000-0000-4000-8000-000000000014',
          occurred_at: '2026-08-16T01:00:00.000Z' }],rowCount: 1 }
      },
    } as unknown as ScopedTransaction
    const result = await new RecommendationStaffModificationRepository(transaction).record({
      recommendationPublicId,sourceProductId,targetProductId,reasonCode: 'customer_request',employeeId,
      allowAllTables: false,idempotencyKey: 'staff-modification-test',requestSha256: 'a'.repeat(64),
    })
    expect(result).toMatchObject({ sourceProductId,targetProductId,employeeId,reasonCode: 'customer_request' })
    const insert = queries.find((entry) => entry.sql.includes('INSERT INTO mbox.recommendation_behavior_events'))
    expect(insert?.sql).toContain('source_recommendation_option_id,actor_employee_id')
    expect(insert?.sql).toContain('staff_modification_idempotency_key')
    expect(insert?.values).toContain(employeeId)
    expect(insert?.values).toContain('a'.repeat(64))
    expect(insert?.sql).not.toMatch(/evidence_snapshot\s*(?:->|#>>|#>)/)
  })

  it('enforces modify and all-table permissions inside the idempotent command transaction', async () => {
    const record = vi.fn(async (input) => ({
      eventId: '10000000-0000-4000-8000-000000000014',recommendationPublicId,
      tableSessionId,sourceProductId,sourceProductName: '舒适方案',targetProductId,
      targetProductName: '完整体验',reasonCode: input.reasonCode,employeeId,occurredAt: '2026-08-16T01:00:00.000Z',
    }))
    let auditEvents: unknown
    const service = new RecommendationStaffModificationService(
      { run: async (_scope,callback) => callback({ scope } as never) },
      { execute: async (_command,handler) => {
        const outcome = await handler({ scope } as never)
        auditEvents = outcome.auditEvents
        return { value: outcome.result,replayed: false }
      } },
      () => ({ resolve: async () => ({ permissions: [
        'recommendation.staff.modify','recommendation.staff.modify.all',
      ] }) as never }),
      () => ({ latestForTable: vi.fn(),record }),
    )
    const result = await service.modify({ scope,employeeId,businessDate: '2026-08-16' }, {
      recommendationPublicId,sourceProductId,targetProductId,reasonCode: 'service_recovery',
      idempotencyKey: 'staff-modification-test',
    })
    expect(result.replayed).toBe(false)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      employeeId,allowAllTables: true,requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(auditEvents).toEqual([expect.objectContaining({
      action: 'customer.experience.recommendation.staff_modified',
      actor: { type: 'employee',employeeId },
    })])
  })

  it('fails closed without the dedicated modification permission', async () => {
    const service = new RecommendationStaffModificationService(
      { run: async (_scope,callback) => callback({ scope } as never) },
      { execute: async (_command,handler) => {
        const outcome = await handler({ scope } as never)
        return { value: outcome.result,replayed: false }
      } },
      () => ({ resolve: async () => ({ permissions: [] }) as never }),
      () => ({ latestForTable: vi.fn(),record: vi.fn() }),
    )
    await expect(service.modify({ scope,employeeId,businessDate: '2026-08-16' }, {
      recommendationPublicId,sourceProductId,targetProductId,reasonCode: 'staff_judgement',
      idempotencyKey: 'staff-modification-test',
    })).rejects.toBeInstanceOf(StaffAccessDeniedError)
  })

  it('exposes a strict staff API and rejects unknown reason codes before the service', async () => {
    const modify = vi.fn()
    const app = Fastify()
    await app.register(recommendationStaffModificationApiPlugin, {
      service: { modify,latestForTable: vi.fn() } as never,
      resolveStaffContext: () => ({ scope,employeeId,businessDate: '2026-08-16' }),
    })
    const response = await app.inject({
      method: 'POST',
      url: `/staff/customer-experience/recommendations/${recommendationPublicId}/modifications`,
      headers: { 'idempotency-key': 'staff-modification-test' },
      payload: { sourceProductId,targetProductId,reasonCode: 'free_text_reason' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('RECOMMENDATION_STAFF_MODIFICATION_INPUT_INVALID')
    expect(modify).not.toHaveBeenCalled()
    await app.close()
  })
})
