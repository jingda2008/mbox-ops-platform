import type { ScopedTransaction } from './transaction-runner.js'

export type RecommendationStaffModificationReason =
  | 'customer_request'
  | 'availability_substitution'
  | 'service_recovery'
  | 'staff_judgement'

export interface StaffRecommendationOptionView {
  productId: string
  productName: string
  rank: number
  tier: 'comfortable' | 'enhanced' | 'signature'
  amountMinor: number
  currency: string
}

export interface StaffRecommendationSessionView {
  recommendationPublicId: string
  tableSessionId: string
  createdAt: string
  options: StaffRecommendationOptionView[]
}

export interface RecommendationStaffModificationView {
  eventId: string
  recommendationPublicId: string
  tableSessionId: string
  sourceProductId: string
  sourceProductName: string
  targetProductId: string
  targetProductName: string
  reasonCode: RecommendationStaffModificationReason
  employeeId: string
  occurredAt: string
}

interface RecommendationOptionRow extends Record<string, unknown> {
  recommendation_public_id: string
  table_session_id: string
  recommendation_created_at: string
  product_id: string
  product_name: string
  rank: number
  tier: StaffRecommendationOptionView['tier']
  amount_minor: string | number
  currency: string
}

interface ModificationContextRow extends Record<string, unknown> {
  recommendation_session_id: string
  recommendation_public_id: string
  table_session_id: string
  source_option_id: string
  source_product_id: string
  source_product_name: string
  target_option_id: string
  target_product_id: string
  target_product_name: string
}

interface ModificationRow extends Record<string, unknown> {
  event_id: string
  occurred_at: string
}

export class RecommendationStaffModificationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'RecommendationStaffModificationError'
  }
}

export class RecommendationStaffModificationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async latestForTable(
    tableSessionId: string,
    employeeId: string,
    allowAllTables: boolean,
  ): Promise<StaffRecommendationSessionView | null> {
    await this.assertEmployeeTableAccess(tableSessionId, employeeId, allowAllTables)
    const result = await this.transaction.query<RecommendationOptionRow>(`
      WITH latest_recommendation AS (
        SELECT recommendation.id,recommendation.public_id,recommendation.table_session_id,
          recommendation.created_at
        FROM mbox.recommendation_sessions recommendation
        WHERE recommendation.tenant_id=$1::uuid AND recommendation.store_id=$2::uuid
          AND recommendation.table_session_id=$3::uuid
        ORDER BY recommendation.created_at DESC,recommendation.id DESC
        LIMIT 1
      )
      SELECT recommendation.public_id AS recommendation_public_id,
        recommendation.table_session_id,recommendation.created_at::text AS recommendation_created_at,
        option.product_id,product.name AS product_name,option.rank,option.tier,
        option.amount_minor,option.currency
      FROM latest_recommendation recommendation
      JOIN mbox.recommendation_options option
        ON option.tenant_id=$1::uuid AND option.store_id=$2::uuid
       AND option.recommendation_session_id=recommendation.id
      JOIN mbox.products product
        ON product.tenant_id=option.tenant_id AND product.store_id=option.store_id
       AND product.id=option.product_id
      ORDER BY option.rank,option.id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,tableSessionId])
    const first = result.rows[0]
    if (first === undefined) return null
    return {
      recommendationPublicId: first.recommendation_public_id,
      tableSessionId: first.table_session_id,
      createdAt: first.recommendation_created_at,
      options: result.rows.map((row) => ({
        productId: row.product_id,
        productName: row.product_name,
        rank: row.rank,
        tier: row.tier,
        amountMinor: amount(row.amount_minor),
        currency: row.currency,
      })),
    }
  }

  async record(input: Readonly<{
    recommendationPublicId: string
    sourceProductId: string
    targetProductId: string
    reasonCode: RecommendationStaffModificationReason
    employeeId: string
    allowAllTables: boolean
    idempotencyKey: string
    requestSha256: string
  }>): Promise<RecommendationStaffModificationView> {
    if (input.sourceProductId === input.targetProductId) throw new RecommendationStaffModificationError(
      '调整前后商品不能相同','RECOMMENDATION_STAFF_MODIFICATION_UNCHANGED',409,
    )
    const contextResult = await this.transaction.query<ModificationContextRow>(`
      SELECT recommendation.id AS recommendation_session_id,
        recommendation.public_id AS recommendation_public_id,recommendation.table_session_id,
        source_option.id AS source_option_id,source_option.product_id AS source_product_id,
        source_product.name AS source_product_name,target_option.id AS target_option_id,
        target_option.product_id AS target_product_id,target_product.name AS target_product_name
      FROM mbox.recommendation_sessions recommendation
      JOIN mbox.table_sessions table_session
        ON table_session.tenant_id=recommendation.tenant_id AND table_session.store_id=recommendation.store_id
       AND table_session.id=recommendation.table_session_id AND table_session.status IN ('open','closing')
      JOIN mbox.recommendation_options source_option
        ON source_option.tenant_id=recommendation.tenant_id AND source_option.store_id=recommendation.store_id
       AND source_option.recommendation_session_id=recommendation.id AND source_option.product_id=$4::uuid
      JOIN mbox.products source_product
        ON source_product.tenant_id=source_option.tenant_id AND source_product.store_id=source_option.store_id
       AND source_product.id=source_option.product_id
      JOIN mbox.recommendation_options target_option
        ON target_option.tenant_id=recommendation.tenant_id AND target_option.store_id=recommendation.store_id
       AND target_option.recommendation_session_id=recommendation.id AND target_option.product_id=$5::uuid
      JOIN mbox.products target_product
        ON target_product.tenant_id=target_option.tenant_id AND target_product.store_id=target_option.store_id
       AND target_product.id=target_option.product_id
      WHERE recommendation.tenant_id=$1::uuid AND recommendation.store_id=$2::uuid
        AND recommendation.public_id=$3
      FOR KEY SHARE OF recommendation,table_session,source_option,target_option
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,input.recommendationPublicId,
      input.sourceProductId,input.targetProductId,
    ])
    const context = contextResult.rows[0]
    if (context === undefined) throw new RecommendationStaffModificationError(
      '推荐会话已失效，或调整前后商品不属于同一推荐','RECOMMENDATION_STAFF_MODIFICATION_INVALID',409,
    )
    await this.assertEmployeeTableAccess(context.table_session_id,input.employeeId,input.allowAllTables)
    const inserted = await this.transaction.query<ModificationRow>(`
      INSERT INTO mbox.recommendation_behavior_events (
        tenant_id,store_id,recommendation_session_id,recommendation_option_id,
        customer_id,table_session_id,event_type,actor_type,actor_ref,reason_code,
        source_recommendation_option_id,actor_employee_id,
        staff_modification_reason_code,staff_modification_idempotency_key,
        staff_modification_request_sha256,evidence_snapshot
      )
      SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,recommendation.customer_id,$5::uuid,
        'staff_modified','employee','authorized_employee',$6,$7::uuid,$8::uuid,
        $6,$9,$10,'{}'::jsonb
      FROM mbox.recommendation_sessions recommendation
      WHERE recommendation.tenant_id=$1::uuid AND recommendation.store_id=$2::uuid
        AND recommendation.id=$3::uuid
      RETURNING id AS event_id,occurred_at::text
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,context.recommendation_session_id,
      context.target_option_id,context.table_session_id,input.reasonCode,context.source_option_id,
      input.employeeId,input.idempotencyKey,input.requestSha256,
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount !== 1 || row === undefined) throw new Error('staff recommendation modification insert failed')
    return {
      eventId: row.event_id,
      recommendationPublicId: context.recommendation_public_id,
      tableSessionId: context.table_session_id,
      sourceProductId: context.source_product_id,
      sourceProductName: context.source_product_name,
      targetProductId: context.target_product_id,
      targetProductName: context.target_product_name,
      reasonCode: input.reasonCode,
      employeeId: input.employeeId,
      occurredAt: row.occurred_at,
    }
  }

  private async assertEmployeeTableAccess(
    tableSessionId: string,
    employeeId: string,
    allowAllTables: boolean,
  ): Promise<void> {
    const result = await this.transaction.query<{ active: boolean; assigned: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM mbox.table_sessions session
        WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
          AND session.id=$3::uuid AND session.status IN ('open','closing')
      ) AS active,EXISTS (
        SELECT 1
        FROM mbox.table_sessions session
        JOIN mbox.table_assignments assignment
          ON assignment.tenant_id=session.tenant_id AND assignment.store_id=session.store_id
         AND assignment.table_id=session.table_id AND assignment.employee_id=$4::uuid
         AND assignment.assignment_type IN ('primary','backup','temporary')
         AND assignment.starts_at<=clock_timestamp()
         AND (assignment.ends_at IS NULL OR assignment.ends_at>clock_timestamp())
        WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
          AND session.id=$3::uuid AND session.status IN ('open','closing')
      ) AS assigned
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,tableSessionId,employeeId])
    const row = result.rows[0]
    if (row?.active !== true) throw new RecommendationStaffModificationError(
      '桌次已结束，不能再调整推荐','RECOMMENDATION_TABLE_SESSION_INACTIVE',409,
    )
    if (!allowAllTables && row.assigned !== true) throw new RecommendationStaffModificationError(
      '只能调整当前主责、候补或临时分配桌台的推荐','RECOMMENDATION_TABLE_SCOPE_DENIED',403,
    )
  }
}

function amount(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('recommendation amount is invalid')
  return parsed
}
