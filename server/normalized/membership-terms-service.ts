import { createHash, randomUUID } from 'node:crypto'
import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
  NormalizedCommandExecutor,
} from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import type {
  StaffCustomerExperienceContext,
} from './customer-experience-service.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

export type MembershipTermsAcknowledgementSource = 'mini_menu' | 'mini_profile'

export interface PublicMembershipTerms {
  version: number
  title: string
  summary: string
  content: string
  effectiveFrom: string
}

export interface MembershipTermsVersionView {
  publicId: string
  version: number
  status: 'draft' | 'approved' | 'published'
  title: string
  summary: string
  content: string
  effectiveFrom: string | null
  effectiveUntil: string | null
  draftedByEmployeeId: string
  approvedByEmployeeId: string | null
  publishedByEmployeeId: string | null
  createdAt: string
}

interface TermsRow extends Record<string, unknown> {
  id: string
  public_id: string
  version: number
  status: MembershipTermsVersionView['status']
  title: string
  summary: string
  content: string
  effective_from: string | null
  effective_until: string | null
  drafted_by_employee_id: string
  approved_by_employee_id: string | null
  published_by_employee_id: string | null
  created_at: string
}

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export class MembershipTermsRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async current(at: Date = new Date()): Promise<PublicMembershipTerms | null> {
    const result = await this.transaction.query<TermsRow>(`
      SELECT id,public_id,version,status,title,summary,content,
        effective_from::text,effective_until::text,drafted_by_employee_id,
        approved_by_employee_id,published_by_employee_id,created_at::text
      FROM mbox.membership_terms_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='published'
        AND effective_from<=$3::timestamptz
        AND (effective_until IS NULL OR effective_until>$3::timestamptz)
      ORDER BY effective_from DESC,version DESC,id DESC LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, at.toISOString()])
    const row = result.rows[0]
    return row === undefined ? null : publicView(row)
  }

  async list(): Promise<readonly MembershipTermsVersionView[]> {
    const result = await this.transaction.query<TermsRow>(`
      SELECT id,public_id,version,status,title,summary,content,
        effective_from::text,effective_until::text,drafted_by_employee_id,
        approved_by_employee_id,published_by_employee_id,created_at::text
      FROM mbox.membership_terms_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      ORDER BY version DESC,id DESC LIMIT 100
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows.map(versionView)
  }

  async acceptCurrentEnrollment(input: Readonly<{
    customerId: string
    memberNo: string
    termsVersion: number
    acknowledgementSource: MembershipTermsAcknowledgementSource
  }>): Promise<void> {
    const terms = await this.transaction.query<{ id: string; version: number; accepted_at: string }>(`
      WITH moment AS (SELECT clock_timestamp() AS accepted_at)
      SELECT terms.id,terms.version,moment.accepted_at::text
      FROM mbox.membership_terms_versions terms CROSS JOIN moment
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='published'
        AND effective_from<=moment.accepted_at
        AND (effective_until IS NULL OR effective_until>moment.accepted_at)
      ORDER BY effective_from DESC,version DESC,id DESC LIMIT 1
      FOR SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    const current = terms.rows[0]
    if (current === undefined) throw termsError(
      'MEMBERSHIP_TERMS_NOT_AVAILABLE', '当前没有生效的入会条款，暂不能新加入会员', 503,
    )
    if (current.version !== input.termsVersion) throw termsError(
      'MEMBERSHIP_TERMS_STALE', '入会条款已经更新，请阅读当前版本后重新确认', 409,
    )
    const membership = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.customer_memberships
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND customer_id=$3::uuid
        AND member_no=$4 AND status='active'
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      input.customerId, input.memberNo,
    ])
    const membershipId = required(membership.rows[0], 'new membership').id
    await this.transaction.query(`
      INSERT INTO mbox.membership_terms_acceptances(
        tenant_id,store_id,public_id,customer_id,membership_id,
        terms_version_id,terms_version,acknowledgement_source,accepted_at
      ) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::timestamptz)
      ON CONFLICT (tenant_id,store_id,membership_id,terms_version_id) DO NOTHING
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      publicId('MTA'), input.customerId, membershipId, current.id,
      current.version, input.acknowledgementSource, current.accepted_at,
    ])
  }
}

export class MembershipTermsService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  current(scope: Readonly<StoreScope>): Promise<PublicMembershipTerms | null> {
    return this.transactions.run(scope, (transaction) => (
      new MembershipTermsRepository(transaction).current(this.now())
    ), { readOnly: true })
  }

  list(context: StaffCustomerExperienceContext): Promise<readonly MembershipTermsVersionView[]> {
    return this.transactions.run(context.scope, (transaction) => (
      new MembershipTermsRepository(transaction).list()
    ), { readOnly: true })
  }

  createDraft(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      title: string
      summary: string
      content: string
      reason: string
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<MembershipTermsVersionView>> {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'membership.terms.draft',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, employeeId: context.employeeId }),
      resultCodec: objectCodec<MembershipTermsVersionView>(),
    }, async (transaction) => {
      await lockReleaseLane(transaction)
      const result = await transaction.query<TermsRow>(`
        INSERT INTO mbox.membership_terms_versions(
          tenant_id,store_id,public_id,version,status,title,summary,content,
          drafted_by_employee_id,draft_reason
        ) SELECT $1::uuid,$2::uuid,$3,COALESCE(max(version),0)+1,'draft',
          $4,$5,$6,$7::uuid,$8
        FROM mbox.membership_terms_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        RETURNING id,public_id,version,status,title,summary,content,
          effective_from::text,effective_until::text,drafted_by_employee_id,
          approved_by_employee_id,published_by_employee_id,created_at::text
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, publicId('MTV'),
        input.title, input.summary, input.content, context.employeeId, input.reason,
      ])
      const output = versionView(required(result.rows[0], 'membership terms draft'))
      return outcome(output, context, 'membership.terms.drafted', input.reason)
    })
  }

  approve(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ version: number; reason: string; idempotencyKey: string }>,
  ): Promise<CommandExecution<MembershipTermsVersionView>> {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'membership.terms.approve',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, employeeId: context.employeeId }),
      resultCodec: objectCodec<MembershipTermsVersionView>(),
    }, async (transaction) => {
      const selected = await lockVersion(transaction, input.version)
      if (selected.status !== 'draft') throw termsError(
        'MEMBERSHIP_TERMS_NOT_APPROVABLE', '该入会条款已经不在草稿阶段', 409,
      )
      if (selected.drafted_by_employee_id === context.employeeId) throw termsError(
        'MEMBERSHIP_TERMS_SELF_APPROVAL_DENIED', '入会条款起草人不能审批自己的版本', 409,
      )
      const result = await transaction.query<TermsRow>(`
        UPDATE mbox.membership_terms_versions
        SET status='approved',approved_by_employee_id=$4::uuid,approval_reason=$5,
          approved_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='draft'
        RETURNING id,public_id,version,status,title,summary,content,
          effective_from::text,effective_until::text,drafted_by_employee_id,
          approved_by_employee_id,published_by_employee_id,created_at::text
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, selected.id,
        context.employeeId, input.reason,
      ])
      const output = versionView(required(result.rows[0], 'approved membership terms'))
      return outcome(output, context, 'membership.terms.approved', input.reason)
    })
  }

  publish(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      version: number
      effectiveFrom: string | null
      reason: string
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<MembershipTermsVersionView>> {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'membership.terms.publish',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, employeeId: context.employeeId }),
      resultCodec: objectCodec<MembershipTermsVersionView>(),
    }, async (transaction) => {
      const publishedAt = this.now()
      const effectiveFrom = input.effectiveFrom === null
        ? publishedAt : new Date(input.effectiveFrom)
      if (!Number.isFinite(effectiveFrom.getTime()) || effectiveFrom.getTime()<publishedAt.getTime()) {
        throw termsError('MEMBERSHIP_TERMS_EFFECTIVE_TIME_INVALID', '生效时间不能早于发布时间', 400)
      }
      await lockReleaseLane(transaction)
      const selected = await lockVersion(transaction, input.version)
      if (selected.status !== 'approved') throw termsError(
        'MEMBERSHIP_TERMS_NOT_PUBLISHABLE', '该入会条款尚未独立审批或已经发布', 409,
      )
      if (selected.drafted_by_employee_id === context.employeeId
        || selected.approved_by_employee_id === context.employeeId) throw termsError(
        'MEMBERSHIP_TERMS_PUBLISHER_SEPARATION_REQUIRED', '发布人必须不同于起草人和审批人', 409,
      )
      const sameStart = await transaction.query(`
        SELECT 1 FROM mbox.membership_terms_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='published'
          AND effective_from=$3::timestamptz
      `, [transaction.scope.tenantId, transaction.scope.storeId, effectiveFrom.toISOString()])
      if ((sameStart.rowCount ?? 0)>0) throw termsError(
        'MEMBERSHIP_TERMS_EFFECTIVE_TIME_CONFLICT', '该时间已经安排了另一版入会条款', 409,
      )
      await transaction.query('SET CONSTRAINTS mbox.membership_terms_versions_no_published_overlap_excl DEFERRED')
      const next = await transaction.query<{ effective_from: string }>(`
        SELECT effective_from::text FROM mbox.membership_terms_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='published'
          AND effective_from>$3::timestamptz
        ORDER BY effective_from,id LIMIT 1 FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, effectiveFrom.toISOString()])
      const predecessor = await transaction.query<{ id: string }>(`
        SELECT id FROM mbox.membership_terms_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='published'
          AND effective_from<$3::timestamptz
          AND (effective_until IS NULL OR effective_until>$3::timestamptz)
        ORDER BY effective_from DESC,id DESC LIMIT 1 FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, effectiveFrom.toISOString()])
      const result = await transaction.query<TermsRow>(`
        UPDATE mbox.membership_terms_versions
        SET status='published',published_by_employee_id=$4::uuid,publication_reason=$5,
          published_at=$6::timestamptz,effective_from=$7::timestamptz,
          effective_until=$8::timestamptz,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved'
        RETURNING id,public_id,version,status,title,summary,content,
          effective_from::text,effective_until::text,drafted_by_employee_id,
          approved_by_employee_id,published_by_employee_id,created_at::text
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, selected.id,
        context.employeeId, input.reason, publishedAt.toISOString(), effectiveFrom.toISOString(),
        next.rows[0]?.effective_from ?? null,
      ])
      if (predecessor.rows[0] !== undefined) {
        await transaction.query(`
          UPDATE mbox.membership_terms_versions SET effective_until=$4::timestamptz,
            updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='published'
        `, [
          transaction.scope.tenantId, transaction.scope.storeId,
          predecessor.rows[0].id, effectiveFrom.toISOString(),
        ])
      }
      const output = versionView(required(result.rows[0], 'published membership terms'))
      return outcome(output, context, 'membership.terms.published', input.reason)
    })
  }
}

async function lockReleaseLane(transaction: ScopedTransaction): Promise<void> {
  await transaction.query(`
    SELECT pg_advisory_xact_lock(hashtextextended($1::text||':'||$2::text||':membership-terms',81))
  `, [transaction.scope.tenantId, transaction.scope.storeId])
}

async function lockVersion(transaction: ScopedTransaction, version: number): Promise<TermsRow> {
  const result = await transaction.query<TermsRow>(`
    SELECT id,public_id,version,status,title,summary,content,
      effective_from::text,effective_until::text,drafted_by_employee_id,
      approved_by_employee_id,published_by_employee_id,created_at::text
    FROM mbox.membership_terms_versions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND version=$3
    FOR UPDATE
  `, [transaction.scope.tenantId, transaction.scope.storeId, version])
  if (result.rows[0] === undefined) throw termsError(
    'MEMBERSHIP_TERMS_NOT_FOUND', '入会条款版本不存在', 404,
  )
  return result.rows[0]
}

function publicView(row: TermsRow): PublicMembershipTerms {
  if (row.effective_from === null) throw new TypeError('Published membership terms lack effective time')
  return {
    version: Number(row.version), title: row.title, summary: row.summary,
    content: row.content, effectiveFrom: row.effective_from,
  }
}

function versionView(row: TermsRow): MembershipTermsVersionView {
  return {
    publicId: row.public_id, version: Number(row.version), status: row.status,
    title: row.title, summary: row.summary, content: row.content,
    effectiveFrom: row.effective_from, effectiveUntil: row.effective_until,
    draftedByEmployeeId: row.drafted_by_employee_id,
    approvedByEmployeeId: row.approved_by_employee_id,
    publishedByEmployeeId: row.published_by_employee_id,
    createdAt: row.created_at,
  }
}

function outcome(
  result: MembershipTermsVersionView,
  context: StaffCustomerExperienceContext,
  action: string,
  reason: string,
) {
  const actor: AuditActor = { type: 'employee', employeeId: context.employeeId }
  return {
    result,
    auditEvents: [{
      actor, action, objectType: 'membership_terms_version', objectId: result.publicId,
      businessDate: context.businessDate, reason,
      afterData: { version: result.version, status: result.status },
    }],
    outboxMessages: [],
  }
}

function objectCodec<Value>(): JsonCodec<Value> {
  return {
    encode: (value) => value as unknown as JsonObject,
    decode: (value) => {
      if (typeof value!=='object' || value===null || Array.isArray(value)) {
        throw new TypeError('Stored membership terms result is invalid')
      }
      return value as Value
    },
  }
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function publicId(prefix: 'MTV' | 'MTA'): string {
  return `${prefix}${randomUUID().replaceAll('-','').toUpperCase()}`
}

function required<Value>(value: Value | undefined, label: string): Value {
  if (value===undefined) throw termsError('MEMBERSHIP_TERMS_STATE_CONFLICT', `${label}不存在或状态已变化`, 409)
  return value
}

function termsError(code: string, message: string, statusCode: number): CustomerExperienceRequestError {
  return new CustomerExperienceRequestError(message, code, statusCode)
}
