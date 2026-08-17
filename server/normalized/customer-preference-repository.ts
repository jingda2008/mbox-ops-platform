import type { ScopedTransaction } from './transaction-runner.js'

export type PreferencePolarity = 'supports' | 'contradicts'
export type PreferenceSourceKind = 'observation_evidence' | 'customer_declaration'

export interface CustomerPreferenceFactView {
  key: string
  value: string
  status: 'active' | 'suppressed'
  confidence: number
  supportScore: number
  contraryScore: number
  netScore: number
  supportingEvidenceCount: number
  contraryEvidenceCount: number
  lastEvidenceAt: string | null
  validUntil: string | null
  calculatedAt: string
}

export interface CustomerPreferenceSourceView {
  publicId: string
  sourceKind: PreferenceSourceKind
  key: string
  value: string
  polarity: PreferencePolarity
  allowedForRecommendation: true
  validUntil: string | null
  createdAt: string
  withdrawn: boolean
}

export interface CustomerPreferenceSnapshot {
  canonicalCustomerId: string
  facts: CustomerPreferenceFactView[]
  sources: CustomerPreferenceSourceView[]
}

interface CanonicalRow extends Record<string, unknown> { customer_id: string }
interface PolicyRow extends Record<string, unknown> {
  id: string
  version: number
  preference_half_life_days: number
  preference_max_age_days: number
  preference_min_effective_score: number
  preference_min_confidence_basis_points: number
}
interface FactRow extends Record<string, unknown> {
  preference_key: string
  preference_value: string
  status: 'active' | 'suppressed'
  confidence: string | number
  support_score: number
  contrary_score: number
  net_score: number
  supporting_evidence_count: number
  contrary_evidence_count: number
  last_evidence_at: string | null
  valid_until: string | null
  calculated_at: string
}
interface SourceRow extends Record<string, unknown> {
  public_id: string
  source_kind: PreferenceSourceKind
  preference_key: string
  preference_value: string
  polarity: PreferencePolarity
  valid_until: string | null
  created_at: string
  withdrawn: boolean
}

export class CustomerPreferenceRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async recompute(customerId: string): Promise<CustomerPreferenceSnapshot> {
    const canonicalCustomerId = await this.canonicalCustomerId(customerId)
    const policy = await this.currentPolicy()
    await this.transaction.query(`
      UPDATE mbox.customer_preference_facts
      SET status='suppressed',support_score=0,contrary_score=0,net_score=0,
        confidence=0,supporting_evidence_count=0,contrary_evidence_count=0,
        last_evidence_at=NULL,valid_until=NULL,next_recalculation_at=NULL,
        policy_version=$4,calculated_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND customer_id=$3::uuid
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      canonicalCustomerId,
      policy.version,
    ])
    await this.transaction.query(`
      WITH RECURSIVE family AS (
        SELECT $3::uuid AS id
        UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent
          ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      ), current_evidence AS (
        SELECT evidence.preference_key,evidence.preference_value,evidence.polarity,
          evidence.evidence_weight,
          round(evidence.confidence*10000)::integer AS confidence_basis_points,
          evidence.created_at,
          LEAST(
            COALESCE(evidence.valid_until,'infinity'::timestamptz),
            evidence.created_at+make_interval(days=>$5)
          ) AS effective_until
        FROM mbox.preference_evidence evidence
        JOIN mbox.observation_events event
          ON event.tenant_id=evidence.tenant_id AND event.store_id=evidence.store_id
         AND event.id=evidence.observation_event_id
        WHERE evidence.tenant_id=$1::uuid AND evidence.store_id=$2::uuid
          AND evidence.customer_id IN (SELECT id FROM family)
          AND evidence.allowed_for_recommendation=true
          AND event.scope_kind='customer' AND event.customer_id=evidence.customer_id
          AND event.expression_kind IN ('customer_quote','objective_fact')
          AND event.confirmation_state='confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM mbox.observation_events later
            WHERE later.tenant_id=event.tenant_id AND later.store_id=event.store_id
              AND later.event_group_id=event.event_group_id
              AND later.revision_no>event.revision_no
          )
          AND NOT EXISTS (
            SELECT 1 FROM mbox.customer_preference_withdrawals withdrawal
            WHERE withdrawal.tenant_id=evidence.tenant_id
              AND withdrawal.store_id=evidence.store_id
              AND withdrawal.preference_evidence_id=evidence.id
          )
        UNION ALL
        SELECT declaration.preference_key,declaration.preference_value,declaration.polarity,
          declaration.evidence_weight,declaration.confidence_basis_points,
          declaration.created_at,
          LEAST(
            COALESCE(declaration.valid_until,'infinity'::timestamptz),
            declaration.created_at+make_interval(days=>$5)
          ) AS effective_until
        FROM mbox.customer_preference_declarations declaration
        WHERE declaration.tenant_id=$1::uuid AND declaration.store_id=$2::uuid
          AND declaration.canonical_customer_id=$3::uuid
          AND declaration.allowed_for_recommendation=true
          AND NOT EXISTS (
            SELECT 1 FROM mbox.customer_preference_withdrawals withdrawal
            WHERE withdrawal.tenant_id=declaration.tenant_id
              AND withdrawal.store_id=declaration.store_id
              AND withdrawal.customer_declaration_id=declaration.id
          )
      ), live_evidence AS (
        SELECT *,greatest(0,round(
          evidence_weight*confidence_basis_points/100.0
          *power(0.5,extract(epoch FROM (clock_timestamp()-created_at))/86400.0/$4)
        ))::integer AS decayed_score
        FROM current_evidence
        WHERE effective_until>clock_timestamp()
      ), aggregated AS (
        SELECT preference_key,preference_value,
          COALESCE(sum(decayed_score) FILTER (WHERE polarity='supports'),0)::integer AS support_score,
          COALESCE(sum(decayed_score) FILTER (WHERE polarity='contradicts'),0)::integer AS contrary_score,
          count(*) FILTER (WHERE polarity='supports')::integer AS support_count,
          count(*) FILTER (WHERE polarity='contradicts')::integer AS contrary_count,
          max(created_at) AS last_evidence_at,
          CASE WHEN bool_or(effective_until='infinity'::timestamptz) THEN NULL
            ELSE max(effective_until) END AS valid_until,
          LEAST(min(effective_until),clock_timestamp()+interval '1 day') AS next_recalculation_at
        FROM live_evidence GROUP BY preference_key,preference_value
      )
      INSERT INTO mbox.customer_preference_facts(
        tenant_id,store_id,customer_id,preference_key,preference_value,
        confidence,supporting_evidence_count,contrary_evidence_count,policy_version,
        valid_until,calculated_at,status,support_score,contrary_score,net_score,
        last_evidence_at,next_recalculation_at
      ) SELECT $1::uuid,$2::uuid,$3::uuid,preference_key,preference_value,
        CASE WHEN support_score+contrary_score=0 THEN 0
          ELSE abs(support_score-contrary_score)::numeric/(support_score+contrary_score) END,
        support_count,contrary_count,$6,valid_until,clock_timestamp(),
        CASE WHEN support_score-contrary_score >= $7
          AND (CASE WHEN support_score+contrary_score=0 THEN 0
            ELSE abs(support_score-contrary_score)*10000/(support_score+contrary_score) END)>=$8
          THEN 'active' ELSE 'suppressed' END,
        support_score,contrary_score,support_score-contrary_score,
        last_evidence_at,next_recalculation_at
      FROM aggregated
      ON CONFLICT (tenant_id,store_id,customer_id,preference_key,preference_value)
      DO UPDATE SET confidence=EXCLUDED.confidence,
        supporting_evidence_count=EXCLUDED.supporting_evidence_count,
        contrary_evidence_count=EXCLUDED.contrary_evidence_count,
        policy_version=EXCLUDED.policy_version,valid_until=EXCLUDED.valid_until,
        calculated_at=EXCLUDED.calculated_at,status=EXCLUDED.status,
        support_score=EXCLUDED.support_score,contrary_score=EXCLUDED.contrary_score,
        net_score=EXCLUDED.net_score,last_evidence_at=EXCLUDED.last_evidence_at,
        next_recalculation_at=EXCLUDED.next_recalculation_at,
        updated_at=clock_timestamp()
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      canonicalCustomerId,
      policy.preference_half_life_days,
      policy.preference_max_age_days,
      policy.version,
      policy.preference_min_effective_score,
      policy.preference_min_confidence_basis_points,
    ])
    return this.read(canonicalCustomerId)
  }

  async declare(input: Readonly<{
    publicId: string
    customerId: string
    key: string
    value: string
    polarity: PreferencePolarity
    validUntil: string | null
    idempotencyKey: string
  }>): Promise<CustomerPreferenceSnapshot> {
    const canonical = await this.canonicalCustomerId(input.customerId)
    await this.transaction.query(`
      INSERT INTO mbox.customer_preference_declarations(
        tenant_id,store_id,public_id,canonical_customer_id,declared_by_customer_id,
        preference_key,preference_value,polarity,valid_until,idempotency_key
      ) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$7,$8,$9::timestamptz,$10)
      ON CONFLICT (tenant_id,store_id,idempotency_key) DO NOTHING
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,input.publicId,
      canonical,input.customerId,input.key,input.value,input.polarity,input.validUntil,input.idempotencyKey])
    return this.recompute(input.customerId)
  }

  async withdraw(input: Readonly<{
    publicId: string
    customerId: string
    sourcePublicId: string
    reason: string
    idempotencyKey: string
  }>): Promise<CustomerPreferenceSnapshot> {
    const canonical = await this.canonicalCustomerId(input.customerId)
    const inserted = await this.transaction.query(`
      WITH RECURSIVE family AS (
        SELECT $4::uuid AS id UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent
          ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      ), target AS (
        SELECT 'observation_evidence'::text AS target_kind,evidence.id AS evidence_id,
          NULL::uuid AS declaration_id
        FROM mbox.preference_evidence evidence
        WHERE evidence.tenant_id=$1::uuid AND evidence.store_id=$2::uuid
          AND evidence.public_id=$6 AND evidence.customer_id IN (SELECT id FROM family)
        UNION ALL
        SELECT 'customer_declaration',NULL,declaration.id
        FROM mbox.customer_preference_declarations declaration
        WHERE declaration.tenant_id=$1::uuid AND declaration.store_id=$2::uuid
          AND declaration.public_id=$6 AND declaration.canonical_customer_id=$4::uuid
      )
      INSERT INTO mbox.customer_preference_withdrawals(
        tenant_id,store_id,public_id,canonical_customer_id,withdrawn_by_customer_id,
        target_kind,preference_evidence_id,customer_declaration_id,reason,idempotency_key
      ) SELECT $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,target_kind,evidence_id,
        declaration_id,$7,$8 FROM target LIMIT 1
      ON CONFLICT (tenant_id,store_id,idempotency_key) DO NOTHING
      RETURNING id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,input.publicId,
      canonical,input.customerId,input.sourcePublicId,input.reason,input.idempotencyKey])
    if (inserted.rowCount !== 1) {
      const replay = await this.transaction.query(`
        SELECT 1 FROM mbox.customer_preference_withdrawals
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND idempotency_key=$3
      `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,input.idempotencyKey])
      if (replay.rowCount !== 1) throw new CustomerPreferenceNotFoundError(input.sourcePublicId)
    }
    return this.recompute(input.customerId)
  }

  private async read(canonicalCustomerId: string): Promise<CustomerPreferenceSnapshot> {
    const facts = await this.transaction.query<FactRow>(`
      SELECT preference_key,preference_value,status,confidence,support_score,
        contrary_score,net_score,supporting_evidence_count,contrary_evidence_count,
        last_evidence_at::text,valid_until::text,calculated_at::text
      FROM mbox.customer_preference_facts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND customer_id=$3::uuid
      ORDER BY status,preference_key,net_score DESC,preference_value
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,canonicalCustomerId])
    const sources = await this.transaction.query<SourceRow>(`
      WITH RECURSIVE family AS (
        SELECT $3::uuid AS id UNION ALL
        SELECT child.id FROM mbox.customers child JOIN family parent
          ON child.merged_into_customer_id=parent.id
        WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
      )
      SELECT evidence.public_id,'observation_evidence'::text AS source_kind,
        evidence.preference_key,evidence.preference_value,evidence.polarity,
        evidence.valid_until::text,evidence.created_at::text,
        withdrawal.id IS NOT NULL AS withdrawn
      FROM mbox.preference_evidence evidence
      LEFT JOIN mbox.customer_preference_withdrawals withdrawal
        ON withdrawal.tenant_id=evidence.tenant_id AND withdrawal.store_id=evidence.store_id
       AND withdrawal.preference_evidence_id=evidence.id
      WHERE evidence.tenant_id=$1::uuid AND evidence.store_id=$2::uuid
        AND evidence.customer_id IN (SELECT id FROM family)
        AND evidence.allowed_for_recommendation=true
      UNION ALL
      SELECT declaration.public_id,'customer_declaration',declaration.preference_key,
        declaration.preference_value,declaration.polarity,declaration.valid_until::text,
        declaration.created_at::text,withdrawal.id IS NOT NULL
      FROM mbox.customer_preference_declarations declaration
      LEFT JOIN mbox.customer_preference_withdrawals withdrawal
        ON withdrawal.tenant_id=declaration.tenant_id
       AND withdrawal.store_id=declaration.store_id
       AND withdrawal.customer_declaration_id=declaration.id
      WHERE declaration.tenant_id=$1::uuid AND declaration.store_id=$2::uuid
        AND declaration.canonical_customer_id=$3::uuid
      ORDER BY created_at DESC,public_id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,canonicalCustomerId])
    return {
      canonicalCustomerId,
      facts: facts.rows.map((row) => ({
        key: row.preference_key,
        value: row.preference_value,
        status: row.status,
        confidence: Number(row.confidence),
        supportScore: Number(row.support_score),
        contraryScore: Number(row.contrary_score),
        netScore: Number(row.net_score),
        supportingEvidenceCount: Number(row.supporting_evidence_count),
        contraryEvidenceCount: Number(row.contrary_evidence_count),
        lastEvidenceAt: row.last_evidence_at,
        validUntil: row.valid_until,
        calculatedAt: row.calculated_at,
      })),
      sources: sources.rows.map((row) => ({
        publicId: row.public_id,
        sourceKind: row.source_kind,
        key: row.preference_key,
        value: row.preference_value,
        polarity: row.polarity,
        allowedForRecommendation: true,
        validUntil: row.valid_until,
        createdAt: row.created_at,
        withdrawn: row.withdrawn,
      })),
    }
  }

  private async canonicalCustomerId(customerId: string): Promise<string> {
    const result = await this.transaction.query<CanonicalRow>(`
      SELECT mbox.canonical_customer_id($1::uuid,$2::uuid,$3::uuid) AS customer_id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,customerId])
    const canonical = result.rows[0]?.customer_id
    if (!canonical) throw new CustomerPreferenceNotFoundError(customerId)
    return canonical
  }

  private async currentPolicy(): Promise<PolicyRow> {
    const result = await this.transaction.query<PolicyRow>(`
      SELECT id,version,preference_half_life_days,preference_max_age_days,
        preference_min_effective_score,preference_min_confidence_basis_points
      FROM mbox.recommendation_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND policy_code='DEFAULT' AND status='published'
        AND effective_from<=clock_timestamp()
        AND (effective_until IS NULL OR effective_until>clock_timestamp())
      ORDER BY effective_from DESC,version DESC,id DESC LIMIT 1
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId])
    const row = result.rows[0]
    if (!row) throw new Error('Published recommendation policy is missing')
    return row
  }
}

export class CustomerPreferenceNotFoundError extends Error {
  readonly code='CUSTOMER_PREFERENCE_SOURCE_NOT_FOUND'
  readonly statusCode=404
  constructor(public readonly reference: string) {
    super('没有找到属于当前顾客的偏好证据')
    this.name='CustomerPreferenceNotFoundError'
  }
}
