import { createHash } from 'node:crypto'
import type { JsonCodec, NormalizedCommandExecutor } from './command-executor.js'
import type { StaffCustomerExperienceContext } from './customer-experience-service.js'
import {
  LoyaltyOperationalControlRepository,
  type LoyaltyOperationalCapability,
  type LoyaltyOperationalStateView,
} from './loyalty-operational-control-repository.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'

export class LoyaltyOperationalControlError extends Error {
  constructor(readonly code: 'LOYALTY_OPERATION_CONTROL_VERSION_CONFLICT'|'LOYALTY_OPERATION_CONTROL_NO_CHANGE', message: string) {
    super(message)
    this.name = 'LoyaltyOperationalControlError'
  }
}

export class LoyaltyOperationalControlService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner,'run'>,
    private readonly commands: Pick<NormalizedCommandExecutor,'execute'>,
  ) {}

  list(context: StaffCustomerExperienceContext): Promise<LoyaltyOperationalStateView[]> {
    return this.transactions.run(context.scope, (transaction) => (
      new LoyaltyOperationalControlRepository(transaction).states()
    ), { readOnly: true })
  }

  set(context: StaffCustomerExperienceContext, input: Readonly<{
    capability: LoyaltyOperationalCapability
    operation: 'pause'|'resume'
    reason: string
    reviewAt: string|null
    expectedVersion: number
    idempotencyKey: string
  }>) {
    const targetState = input.operation==='pause' ? 'paused' as const : 'active' as const
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.operations.control',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: stateCodec,
    }, async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `loyalty-operational-control:${transaction.scope.tenantId}:${transaction.scope.storeId}:${input.capability}`,
      ])
      const current = await new LoyaltyOperationalControlRepository(transaction).state(input.capability, true)
      if (current.version!==input.expectedVersion) throw new LoyaltyOperationalControlError(
        'LOYALTY_OPERATION_CONTROL_VERSION_CONFLICT','运行状态已被其他管理人员修改，请刷新后重试',
      )
      if (current.state===targetState) throw new LoyaltyOperationalControlError(
        'LOYALTY_OPERATION_CONTROL_NO_CHANGE',targetState==='paused' ? '该能力已经暂停' : '该能力已经恢复',
      )
      const event = await transaction.query<{
        id: string; capability: LoyaltyOperationalCapability; resulting_state: 'active'|'paused'
        control_version: number; reason: string; review_at: string|null
        changed_by_employee_id: string; occurred_at: string
      }>(`
        INSERT INTO mbox.loyalty_operational_control_events(
          tenant_id,store_id,capability,operation,resulting_state,control_version,
          reason,review_at,changed_by_employee_id
        ) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::timestamptz,$9::uuid)
        RETURNING id,capability,resulting_state,control_version,reason,
          review_at::text,changed_by_employee_id,occurred_at::text
      `, [
        transaction.scope.tenantId,transaction.scope.storeId,input.capability,input.operation,
        targetState,current.version+1,input.reason,input.reviewAt,context.employeeId,
      ])
      const eventRow = event.rows[0]
      if (!eventRow) throw new Error('Loyalty operational control event was not recorded')
      const stateValues = [
        transaction.scope.tenantId,transaction.scope.storeId,eventRow.capability,
        eventRow.resulting_state,eventRow.control_version,eventRow.id,eventRow.reason,
        eventRow.review_at,eventRow.changed_by_employee_id,eventRow.occurred_at,
      ]
      const changed = await transaction.query<{
        capability: LoyaltyOperationalCapability; state: 'active'|'paused'; control_version: number
        reason: string; review_at: string|null; changed_by_employee_id: string; changed_at: string
      }>(current.version===0 ? `
        INSERT INTO mbox.loyalty_operational_control_states(
          tenant_id,store_id,capability,state,control_version,current_event_id,
          reason,review_at,changed_by_employee_id,changed_at
        ) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8::timestamptz,$9::uuid,$10::timestamptz)
        RETURNING capability,state,control_version,reason,review_at::text,
          changed_by_employee_id,changed_at::text
      ` : `
        UPDATE mbox.loyalty_operational_control_states
        SET state=$4,control_version=$5,current_event_id=$6::uuid,reason=$7,
          review_at=$8::timestamptz,changed_by_employee_id=$9::uuid,changed_at=$10::timestamptz
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND capability=$3
          AND control_version=$11
        RETURNING capability,state,control_version,reason,review_at::text,
          changed_by_employee_id,changed_at::text
      `, current.version===0 ? stateValues : [...stateValues,current.version])
      const row = changed.rows[0]
      if (!row) throw new Error('Loyalty operational control was not recorded')
      const result: LoyaltyOperationalStateView = {
        capability: row.capability,state: row.state,version: Number(row.control_version),
        reason: row.reason,reviewAt: row.review_at,changedByEmployeeId: row.changed_by_employee_id,
        changedAt: row.changed_at,pendingAccrualCount: current.pendingAccrualCount,
      }
      return {
        result,
        auditEvents: [{
          actor: { type:'employee' as const, employeeId:context.employeeId },
          action: `loyalty.operations.${input.operation}`,
          objectType: 'loyalty_operational_control',
          objectId: `${transaction.scope.storeId}:${input.capability}`,
          businessDate: context.businessDate,
          reason: input.reason,
          metadata: {
            capability: input.capability,state: targetState,version: result.version,
            reviewAt: input.reviewAt,reason: input.reason,
          },
        }],
        outboxMessages: [],
      }
    })
  }
}

const stateCodec: JsonCodec<LoyaltyOperationalStateView> = {
  encode: (value) => ({ ...value }),
  decode: (value) => value as unknown as LoyaltyOperationalStateView,
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value==='object' && value!==null) {
    const row = value as Record<string,unknown>
    return `{${Object.keys(row).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
