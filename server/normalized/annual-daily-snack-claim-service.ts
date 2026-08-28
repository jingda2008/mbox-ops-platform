import { createHash } from 'node:crypto'
import type { AuditActor, JsonCodec, JsonObject, NormalizedCommandExecutor } from './command-executor.js'
import { BenefitRepository } from './benefit-repository.js'
import { CustomerRepository } from './customer-repository.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'
import { assertEmployeeTableSessionReadAccess } from './employee-table-access.js'

export interface AnnualDailySnackGuestContext {
  scope: Readonly<StoreScope>
  customerId: string
  tableSessionId: string | null
  businessDate: string
  actorRef: string
}

export interface AnnualDailySnackStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export interface AnnualDailySnackClaim {
  id: string
  claimCode: string
  benefitId: string | null
  benefitReservationId: string | null
  giftOrderId: string | null
  attemptNo: number
  quantity: number
  status: 'initiated' | 'reserved' | 'redeemed' | 'fulfilled' | 'cancelled' | 'expired'
    | 'cancelled_after_redemption' | 'compensated'
  expiresAt: string | null
  redeemedByEmployeeId: string | null
  redeemedByEmployeeName: string | null
  redeemedAt: string | null
  fulfilledAt: string | null
  title: string
  tableCode?: string
  tableSessionId?: string
  memberNo?: string | null
  customerName?: string | null
}

interface CandidateRow extends Record<string, unknown> {
  membership_id: string
  customer_id: string
  policy_id: string
  rule_id: string
  title: string
  quantity: number
  member_daily_limit: number
  table_daily_limit: number
  redemption_hold_minutes: number
  benefit_definition_id: string
  benefit_code: string
  benefit_kind: string
  display_snapshot: JsonObject
  product_id: string
  price_amount_minor: string | number
  price_currency: string
  claimed_at: string
  expires_at: string
  stack_group: string
  priority: number
}

interface ClaimRow extends Record<string, unknown> {
  id: string
  claim_code: string
  benefit_id: string | null
  benefit_reservation_id: string | null
  gift_order_id: string | null
  attempt_no: number
  quantity: number
  status: AnnualDailySnackClaim['status']
  expires_at: string | null
  redeemed_by_employee_id: string | null
  redeemed_by_employee_name: string | null
  redeemed_at: string | null
  fulfilled_at: string | null
  title: string
  table_code?: string
  table_session_id?: string
  member_no?: string | null
  customer_name?: string | null
}

interface RedeemableClaimRow extends ClaimRow {
  customer_id: string
  table_session_id: string
}

export class AnnualDailySnackClaimError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message)
    this.name = 'AnnualDailySnackClaimError'
  }
}

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export class AnnualDailySnackClaimService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
  ) {}

  claim(context: AnnualDailySnackGuestContext, input: Readonly<{ idempotencyKey: string }>) {
    if (context.tableSessionId === null) throw failure('请在入座并连接当前桌台后申请每日点心', 'DAILY_SNACK_TABLE_REQUIRED', 400)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.annual-daily-snack.claim',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ customerId: context.customerId, tableSessionId: context.tableSessionId, businessDate: context.businessDate }),
      resultCodec: claimCodec,
    }, async (transaction) => {
      const canonical = await new CustomerRepository(transaction).resolveCanonical(context.customerId)
      if (!await lockBoundGuestTablePosition(transaction, {
        tableSessionId: context.tableSessionId!, customerId: canonical.id, actorRef: context.actorRef,
      })) throw failure('当前桌边会话已失效，请重新扫码连接桌台', 'DAILY_SNACK_TABLE_AUTH_REQUIRED', 401)
      const candidates = await dailySnackCandidates(transaction, canonical.id, context.tableSessionId!, context.businessDate)
      if (candidates.length !== 1) {
        throw failure(candidates.length === 0
          ? '当前没有可申请的每日点心权益，请以门店已发布规则和当前会员等级为准'
          : '每日点心规则存在歧义，已停止申请并请门店先完成规则核对',
        candidates.length === 0 ? 'DAILY_SNACK_UNAVAILABLE' : 'DAILY_SNACK_RULE_AMBIGUOUS')
      }
      const candidate = candidates[0]!
      await advisoryLock(transaction, `annual-daily-snack:member:${candidate.membership_id}:${candidate.rule_id}:${context.businessDate}`)
      await advisoryLock(transaction, `annual-daily-snack:table:${context.tableSessionId}:${candidate.rule_id}:${context.businessDate}`)
      const prior = await findClaim(transaction, candidate.membership_id, candidate.rule_id, context.businessDate)
      if (prior !== null) {
        if (prior.status === 'reserved' || prior.status === 'redeemed' || prior.status === 'fulfilled') {
          return outcome(context, prior, 'loyalty.annual-daily-snack.claim-replayed', prior.id, { claimCode: prior.claimCode, status: prior.status })
        }
      }
      const cap = await tableClaimedQuantity(transaction, context.tableSessionId!, candidate.rule_id, context.businessDate)
      if (cap + candidate.quantity > candidate.table_daily_limit) {
        throw failure('本桌今日每日点心名额已满，不能超出门店已发布的桌台上限', 'DAILY_SNACK_TABLE_LIMIT_REACHED')
      }
      if (candidate.quantity > candidate.member_daily_limit) {
        throw failure('每日点心规则的单次数量超过会员每日上限，已停止申请', 'DAILY_SNACK_MEMBER_LIMIT_INVALID')
      }
      const unitAmount = Number(candidate.price_amount_minor)
      if (!Number.isSafeInteger(unitAmount) || unitAmount < 0 || unitAmount * candidate.quantity > Number.MAX_SAFE_INTEGER) {
        throw failure('每日点心当前售价无法安全核算，已停止申请', 'DAILY_SNACK_PRICE_INVALID')
      }
      const repository = new BenefitRepository(transaction)
      const initiated = prior === null
        ? await insertInitiatedClaim(transaction, candidate, context.businessDate, context.tableSessionId!)
        : await resetReleasedClaim(transaction, prior, candidate)
      let benefitId = initiated.benefitId
      if (benefitId === null) {
        const benefit = await repository.issue({
          customerId: canonical.id,benefitCode: candidate.benefit_code,benefitType: 'gift_product',
          valueAmountMinor: unitAmount * candidate.quantity,currency: candidate.price_currency,
          quantity: candidate.quantity,allowedProductIds: [candidate.product_id],
          benefitSnapshot: { publicDisplay: candidate.display_snapshot,annualDailySnack: {
            claimCode:initiated.claimCode,ruleId:candidate.rule_id,businessDate:context.businessDate,
          } },
          validFrom:candidate.claimed_at,validUntil:candidate.expires_at,reason:'会员本人到店申请每日点心',
          authorizationSource:{ kind:'annual_daily_snack',policyVersionId:candidate.policy_id,ruleId:candidate.rule_id },
          issuanceIdempotencyKey:`annual-daily-snack:${candidate.policy_id}:${candidate.rule_id}:${candidate.membership_id}:${context.businessDate}`,
          issuanceFingerprint:fingerprint({ policyId:candidate.policy_id,ruleId:candidate.rule_id,
            membershipId:candidate.membership_id,businessDate:context.businessDate,productId:candidate.product_id,
            unitAmount,quantity:candidate.quantity }),
        })
        benefitId = benefit.id
        const grant = await transaction.query(`
          INSERT INTO mbox.membership_annual_benefit_grants(
            tenant_id,store_id,membership_id,customer_id,policy_version_id,rule_id,cycle_key,benefit_id,status,granted_at,expires_at,
            stack_group,priority,window_starts_on,window_ends_on
          ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::uuid,'active',$9::timestamptz,$10::timestamptz,
            $11,$12,$7::date,$7::date)
        `, [transaction.scope.tenantId,transaction.scope.storeId,candidate.membership_id,canonical.id,
          candidate.policy_id,candidate.rule_id,context.businessDate,benefit.id,benefit.validFrom,benefit.validUntil,
          candidate.stack_group,candidate.priority])
        if (grant.rowCount !== 1) throw new Error('Daily snack annual benefit grant was not created')
        await transaction.query(`UPDATE mbox.annual_daily_snack_claims SET benefit_id=$3::uuid
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$4::uuid AND status='initiated'`,
        [transaction.scope.tenantId,transaction.scope.storeId,benefit.id,initiated.id])
      } else {
        await transaction.query(`
          UPDATE mbox.benefits SET valid_until=$4::timestamptz,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
            AND status='issued' AND quantity_reserved=0
        `, [transaction.scope.tenantId,transaction.scope.storeId,benefitId,candidate.expires_at])
        await transaction.query(`
          UPDATE mbox.membership_annual_benefit_grants SET expires_at=$4::timestamptz,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND benefit_id=$3::uuid AND status='active'
        `, [transaction.scope.tenantId,transaction.scope.storeId,benefitId,candidate.expires_at])
      }
      const reservation = await repository.reserve({
        benefitId,
        customerId: canonical.id,
        tableSessionId: context.tableSessionId!,
        quantity: candidate.quantity,
        expiresAt: candidate.expires_at,
        reservationIdempotencyKey: `annual-daily-snack-reservation:${initiated.id}:${initiated.attemptNo}`,
        reservationFingerprint: fingerprint({ claimId: initiated.id, attemptNo:initiated.attemptNo,
          benefitId, tableSessionId: context.tableSessionId, quantity: candidate.quantity }),
        annualDailySnackClaimId: initiated.id,
      }, context.actorRef)
      const updated = await transaction.query<ClaimRow>(`
        UPDATE mbox.annual_daily_snack_claims AS claim SET benefit_reservation_id=$4::uuid,status='reserved',expires_at=$5::timestamptz
        WHERE claim.tenant_id=$1::uuid AND claim.store_id=$2::uuid AND claim.id=$3::uuid
          AND claim.benefit_id=$6::uuid AND claim.status='initiated'
        RETURNING claim.id,claim.claim_code,claim.benefit_id,claim.benefit_reservation_id,claim.gift_order_id,
          claim.attempt_no,claim.quantity,claim.status,claim.expires_at::text,claim.redeemed_by_employee_id,
          NULL::text AS redeemed_by_employee_name,claim.redeemed_at::text,claim.fulfilled_at::text,$7::text AS title
      `, [transaction.scope.tenantId, transaction.scope.storeId, initiated.id, reservation.id, candidate.expires_at, benefitId, candidate.title])
      const value = mapClaim(updated.rows[0])
      if (value === null) throw new Error('Daily snack claim reservation was not saved')
      await reserveDailySnackInventory(transaction, value.id, candidate.product_id, candidate.quantity)
      return outcome(context, value, 'loyalty.annual-daily-snack.claimed', value.id, {
        claimCode: value.claimCode, benefitId: value.benefitId, benefitReservationId: value.benefitReservationId,
        tableSessionId: context.tableSessionId, quantity: value.quantity, expiresAt: value.expiresAt,
      })
    })
  }

  listForStaff(context: AnnualDailySnackStaffContext, tableSessionId?: string | null) {
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<ClaimRow>(`${claimSelectSql()}
        AND ($3::uuid IS NULL OR claim.table_session_id=$3::uuid)
        AND claim.business_date=$4::date
        AND session.status IN ('open','closing')
        AND EXISTS (
          SELECT 1 FROM mbox.employees employee
          WHERE employee.tenant_id=claim.tenant_id AND employee.store_id=claim.store_id
            AND employee.id=$5::uuid AND employee.status='active'
            AND (
              mbox.employee_has_effective_permission(
                employee.tenant_id,employee.store_id,employee.id,'table.view_all'
              )
              OR EXISTS (
                SELECT 1 FROM mbox.table_assignments assignment
                WHERE assignment.tenant_id=session.tenant_id AND assignment.store_id=session.store_id
                  AND assignment.table_id=session.table_id AND assignment.employee_id=employee.id
                  AND assignment.assignment_type IN ('primary','backup')
                  AND assignment.starts_at<=clock_timestamp()
                  AND (assignment.ends_at IS NULL OR assignment.ends_at>clock_timestamp())
              )
            )
        )
        AND claim.status IN ('reserved','redeemed','fulfilled','cancelled','expired')
        ORDER BY CASE claim.status WHEN 'reserved' THEN 0 WHEN 'redeemed' THEN 1 WHEN 'fulfilled' THEN 2 WHEN 'cancelled' THEN 3 ELSE 4 END,
          claim.created_at,claim.id`,
      [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId ?? null, context.businessDate, context.employeeId])
      return result.rows.flatMap((row) => {
        const value = mapClaim(row)
        return value === null ? [] : [value]
      })
    }, { readOnly: true })
  }

  findRedeemableForStaff(context: AnnualDailySnackStaffContext, claimCode: string) {
    if (!/^DSN-[A-Z0-9]{10,24}$/.test(claimCode)) throw failure('每日点心核销码格式不正确', 'DAILY_SNACK_CLAIM_CODE_INVALID', 400)
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<RedeemableClaimRow>(`
        SELECT claim.id,claim.claim_code,claim.benefit_id,claim.benefit_reservation_id,claim.gift_order_id,claim.attempt_no,
          claim.quantity,claim.status,claim.expires_at::text,claim.redeemed_by_employee_id,
          employee.display_name AS redeemed_by_employee_name,claim.redeemed_at::text,claim.fulfilled_at::text,
          rule.title,claim.customer_id,claim.table_session_id
        FROM mbox.annual_daily_snack_claims claim
        JOIN mbox.loyalty_annual_benefit_rules rule
          ON rule.tenant_id=claim.tenant_id AND rule.store_id=claim.store_id AND rule.id=claim.rule_id
        LEFT JOIN mbox.employees employee
          ON employee.tenant_id=claim.tenant_id AND employee.store_id=claim.store_id
         AND employee.id=claim.redeemed_by_employee_id
        WHERE claim.tenant_id=$1::uuid AND claim.store_id=$2::uuid AND claim.claim_code=$3
          AND claim.status IN ('reserved','redeemed','fulfilled')
          AND (claim.status<>'reserved' OR claim.expires_at>clock_timestamp())
      `, [transaction.scope.tenantId, transaction.scope.storeId, claimCode])
      const claim = result.rows[0]
      if (!claim || claim.benefit_id === null || claim.benefit_reservation_id === null) {
        throw failure('该每日点心暂留不存在、已过期或已处理', 'DAILY_SNACK_CLAIM_UNAVAILABLE')
      }
      await assertEmployeeTableSessionReadAccess(transaction, {
        employeeId: context.employeeId, tableSessionId: claim.table_session_id,
      })
      return { claim: mapClaim(claim)!, customerId: claim.customer_id, tableSessionId: claim.table_session_id }
    }, { readOnly: true })
  }

  findCancellableForStaff(context: AnnualDailySnackStaffContext, claimCode: string) {
    if (!/^DSN-[A-Z0-9]{10,24}$/.test(claimCode)) throw failure('每日点心核销码格式不正确', 'DAILY_SNACK_CLAIM_CODE_INVALID', 400)
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<RedeemableClaimRow>(`
        SELECT claim.id,claim.claim_code,claim.benefit_id,claim.benefit_reservation_id,claim.gift_order_id,claim.attempt_no,
          claim.quantity,claim.status,claim.expires_at::text,claim.redeemed_by_employee_id,
          employee.display_name AS redeemed_by_employee_name,claim.redeemed_at::text,claim.fulfilled_at::text,
          rule.title,claim.customer_id,claim.table_session_id
        FROM mbox.annual_daily_snack_claims claim
        JOIN mbox.loyalty_annual_benefit_rules rule
          ON rule.tenant_id=claim.tenant_id AND rule.store_id=claim.store_id AND rule.id=claim.rule_id
        LEFT JOIN mbox.employees employee
          ON employee.tenant_id=claim.tenant_id AND employee.store_id=claim.store_id
         AND employee.id=claim.redeemed_by_employee_id
        WHERE claim.tenant_id=$1::uuid AND claim.store_id=$2::uuid AND claim.claim_code=$3
          AND claim.status='reserved'
      `, [transaction.scope.tenantId, transaction.scope.storeId, claimCode])
      const claim = result.rows[0]
      if (!claim || claim.benefit_id === null || claim.benefit_reservation_id === null) {
        throw failure('该每日点心暂留不存在或已处理', 'DAILY_SNACK_CLAIM_UNAVAILABLE')
      }
      await assertEmployeeTableSessionReadAccess(transaction, {
        employeeId: context.employeeId, tableSessionId: claim.table_session_id,
      })
      return { claim: mapClaim(claim)!, customerId: claim.customer_id, tableSessionId: claim.table_session_id }
    }, { readOnly: true })
  }
}

async function dailySnackCandidates(transaction: ScopedTransaction, customerId: string, tableSessionId: string, businessDate: string) {
  const result = await transaction.query<CandidateRow>(`
    SELECT membership.id AS membership_id,membership.customer_id,policy.id AS policy_id,rule.id AS rule_id,rule.title,
      rule.quantity,rule.member_daily_limit,rule.table_daily_limit,rule.redemption_hold_minutes,
      definition.id AS benefit_definition_id,definition.benefit_code,definition.benefit_kind,definition.display_snapshot,
      definition.product_id,price.amount_minor AS price_amount_minor,price.currency AS price_currency,
      rule.stack_group,rule.priority,
      clock_timestamp()::text AS claimed_at,(clock_timestamp()+make_interval(mins=>rule.redemption_hold_minutes))::text AS expires_at
    FROM mbox.customer_memberships membership
    JOIN mbox.loyalty_accounts account
      ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
     AND account.membership_id=membership.id AND account.customer_id=membership.customer_id
     AND account.redemption_status='active'
    JOIN mbox.membership_tier_periods tier_period
      ON tier_period.tenant_id=membership.tenant_id AND tier_period.store_id=membership.store_id
     AND tier_period.membership_id=membership.id AND tier_period.tier=account.current_tier
     AND tier_period.status IN ('active','grace')
     AND ((tier_period.status='active' AND (tier_period.ends_at IS NULL OR tier_period.ends_at>clock_timestamp()))
       OR (tier_period.status='grace' AND tier_period.grace_ends_at>clock_timestamp()))
    JOIN mbox.table_sessions session
      ON session.tenant_id=membership.tenant_id AND session.store_id=membership.store_id
     AND session.id=$4::uuid AND session.status='open' AND session.business_date=$5::date
    JOIN mbox.loyalty_annual_benefit_policy_versions policy
      ON policy.tenant_id=membership.tenant_id AND policy.store_id=membership.store_id
     AND policy.status='published' AND policy.effective_from<=clock_timestamp()
     AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
    JOIN mbox.loyalty_annual_benefit_rules rule
      ON rule.tenant_id=policy.tenant_id AND rule.store_id=policy.store_id AND rule.policy_version_id=policy.id
     AND rule.rule_kind='daily_snack' AND rule.enabled
    JOIN mbox.loyalty_benefit_definitions definition
      ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id AND definition.id=rule.benefit_definition_id
     AND definition.status='active' AND definition.benefit_kind='gift_product' AND definition.product_id IS NOT NULL
    JOIN mbox.products product
      ON product.tenant_id=definition.tenant_id AND product.store_id=definition.store_id AND product.id=definition.product_id
     AND product.status='active' AND product.inventory_control_mode='tracked'
     AND product.fulfillment_station IN ('bar','kitchen')
     AND EXISTS (
       SELECT 1 FROM mbox.recipes recipe
       JOIN mbox.recipe_items recipe_item
         ON recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
        AND recipe_item.recipe_id=recipe.id
       WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
         AND recipe.product_id=product.id AND recipe.status='active'
         AND recipe.effective_at<=clock_timestamp()
     )
    JOIN LATERAL (
      SELECT amount_minor,currency FROM mbox.product_prices
      WHERE tenant_id=product.tenant_id AND store_id=product.store_id AND product_id=product.id
        AND price_type='standard' AND valid_from<=clock_timestamp()
        AND (valid_until IS NULL OR valid_until>clock_timestamp())
      ORDER BY valid_from DESC,id DESC LIMIT 1
    ) price ON true
    WHERE membership.tenant_id=$1::uuid AND membership.store_id=$2::uuid AND membership.customer_id=$3::uuid
      AND membership.status='active'
      AND (account.current_tier=rule.eligible_tier
        OR (rule.inherit_to_higher_tiers AND (account.current_tier,rule.eligible_tier) IN (('silver','member'),('gold','member'),('gold','silver'))))
    ORDER BY policy.effective_from DESC,policy.id DESC,rule.rule_code,rule.id LIMIT 2
    FOR SHARE OF membership,account,tier_period,session,policy,rule,definition,product
  `, [transaction.scope.tenantId, transaction.scope.storeId, customerId, tableSessionId, businessDate])
  return result.rows
}

async function insertInitiatedClaim(transaction: ScopedTransaction, candidate: CandidateRow, businessDate: string, tableSessionId: string) {
  const claimCode = `DSN-${createHash('sha256').update(`${candidate.membership_id}:${candidate.rule_id}:${businessDate}`).digest('hex').slice(0, 14).toUpperCase()}`
  const result = await transaction.query<ClaimRow>(`
    INSERT INTO mbox.annual_daily_snack_claims(
      tenant_id,store_id,membership_id,customer_id,policy_version_id,rule_id,business_date,table_session_id,claim_code,quantity
    ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::date,$8::uuid,$9,$10)
    RETURNING id,claim_code,benefit_id,benefit_reservation_id,gift_order_id,attempt_no,quantity,status,expires_at::text,
      redeemed_by_employee_id,NULL::text AS redeemed_by_employee_name,redeemed_at::text,fulfilled_at::text,$11::text AS title
  `, [transaction.scope.tenantId, transaction.scope.storeId, candidate.membership_id, candidate.customer_id,
    candidate.policy_id, candidate.rule_id, businessDate, tableSessionId, claimCode, candidate.quantity, candidate.title])
  const value = mapClaim(result.rows[0])
  if (value === null) throw new Error('Daily snack claim was not created')
  return value
}

async function resetReleasedClaim(
  transaction: ScopedTransaction,
  prior: AnnualDailySnackClaim,
  candidate: CandidateRow,
) {
  if (!['cancelled','expired'].includes(prior.status) || prior.benefitId === null) {
    throw failure('该每日点心申请不能重新暂留，请员工核对履约状态', 'DAILY_SNACK_RETRY_NOT_ALLOWED')
  }
  const result = await transaction.query<ClaimRow>(`
    UPDATE mbox.annual_daily_snack_claims claim
    SET status='initiated',attempt_no=attempt_no+1,benefit_reservation_id=NULL,expires_at=NULL,
      gift_order_id=NULL,redeemed_by_employee_id=NULL,redeemed_at=NULL,fulfilled_at=NULL,
      updated_at=clock_timestamp()
    WHERE claim.tenant_id=$1::uuid AND claim.store_id=$2::uuid AND claim.id=$3::uuid
      AND claim.status IN ('cancelled','expired') AND claim.attempt_no<100
    RETURNING claim.id,claim.claim_code,claim.benefit_id,claim.benefit_reservation_id,claim.gift_order_id,
      claim.attempt_no,claim.quantity,claim.status,claim.expires_at::text,claim.redeemed_by_employee_id,
      NULL::text AS redeemed_by_employee_name,claim.redeemed_at::text,claim.fulfilled_at::text,$4::text AS title
  `, [transaction.scope.tenantId,transaction.scope.storeId,prior.id,candidate.title])
  const value = mapClaim(result.rows[0])
  if (value === null) throw failure('每日点心重新暂留发生并发冲突，请刷新后再试', 'DAILY_SNACK_RETRY_CONFLICT')
  return value
}

async function reserveDailySnackInventory(
  transaction: ScopedTransaction,
  claimId: string,
  productId: string,
  quantity: number,
) {
  const demand = await transaction.query<{
    inventory_item_id:string; sku:string; required_quantity:string
  }>(`
    SELECT recipe_item.inventory_item_id,inventory_item.sku,
      (((recipe_item.quantity+recipe_item.expected_waste_quantity)*$4::integer)
        / recipe.yield_quantity)::numeric(18,6)::text AS required_quantity
    FROM mbox.recipes recipe
    JOIN mbox.recipe_items recipe_item
      ON recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
     AND recipe_item.recipe_id=recipe.id
    JOIN mbox.inventory_items inventory_item
      ON inventory_item.tenant_id=recipe_item.tenant_id AND inventory_item.store_id=recipe_item.store_id
     AND inventory_item.id=recipe_item.inventory_item_id AND inventory_item.status='active'
    WHERE recipe.tenant_id=$1::uuid AND recipe.store_id=$2::uuid AND recipe.product_id=$3::uuid
      AND recipe.status='active' AND recipe.effective_at<=clock_timestamp()
    ORDER BY recipe_item.inventory_item_id
    FOR SHARE OF recipe,recipe_item,inventory_item
  `, [transaction.scope.tenantId,transaction.scope.storeId,productId,quantity])
  if (demand.rows.length === 0) {
    throw failure('每日点心没有当前生效的正式配方，未创建暂留', 'DAILY_SNACK_RECIPE_UNAVAILABLE')
  }
  const itemIds = demand.rows.map((row)=>row.inventory_item_id)
  const balances = await transaction.query<{ inventory_item_id:string }>(`
    SELECT balance.inventory_item_id
    FROM mbox.inventory_balances balance
    WHERE balance.tenant_id=$1::uuid AND balance.store_id=$2::uuid
      AND balance.inventory_item_id=ANY($3::uuid[])
    ORDER BY balance.inventory_item_id FOR UPDATE
  `, [transaction.scope.tenantId,transaction.scope.storeId,itemIds])
  if (balances.rows.length !== itemIds.length) {
    throw failure('每日点心配方库存尚未建立完整余额，未创建暂留', 'DAILY_SNACK_INVENTORY_UNAVAILABLE')
  }
  for (const row of demand.rows) {
    const updated = await transaction.query(`
      UPDATE mbox.inventory_balances
      SET reserved_quantity=reserved_quantity+$4::numeric,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
        AND on_hand_quantity-reserved_quantity>=$4::numeric
    `, [transaction.scope.tenantId,transaction.scope.storeId,row.inventory_item_id,row.required_quantity])
    if (updated.rowCount !== 1) {
      throw failure(`每日点心库存不足（${row.sku}），本次没有占用权益`, 'DAILY_SNACK_INVENTORY_INSUFFICIENT')
    }
    const held = await transaction.query(`
      INSERT INTO mbox.annual_daily_snack_inventory_holds(
        tenant_id,store_id,claim_id,inventory_item_id,quantity,status
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::numeric,'reserved')
      ON CONFLICT (tenant_id,store_id,claim_id,inventory_item_id) DO UPDATE
      SET quantity=EXCLUDED.quantity,status='reserved',completed_at=NULL,completion_reason=NULL,
        reserved_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE annual_daily_snack_inventory_holds.status='released'
    `, [transaction.scope.tenantId,transaction.scope.storeId,claimId,row.inventory_item_id,row.required_quantity])
    if (held.rowCount !== 1) throw failure('每日点心库存暂留状态冲突，请刷新后再试', 'DAILY_SNACK_INVENTORY_HOLD_CONFLICT')
  }
}

async function findClaim(transaction: ScopedTransaction, membershipId: string, ruleId: string, businessDate: string) {
  const result = await transaction.query<ClaimRow>(`${claimSelectSql()}
    AND claim.membership_id=$3::uuid AND claim.rule_id=$4::uuid AND claim.business_date=$5::date FOR UPDATE`,
  [transaction.scope.tenantId, transaction.scope.storeId, membershipId, ruleId, businessDate])
  return mapClaim(result.rows[0])
}

async function tableClaimedQuantity(transaction: ScopedTransaction, tableSessionId: string, ruleId: string, businessDate: string) {
  const result = await transaction.query<{ quantity: string | number }>(`
    SELECT COALESCE(sum(quantity) FILTER (WHERE status IN ('reserved','redeemed','fulfilled')),0) AS quantity
    FROM mbox.annual_daily_snack_claims
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND table_session_id=$3::uuid AND rule_id=$4::uuid AND business_date=$5::date
  `, [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId, ruleId, businessDate])
  return Number(result.rows[0]?.quantity ?? 0)
}

function claimSelectSql() {
  return `SELECT claim.id,claim.claim_code,claim.benefit_id,claim.benefit_reservation_id,claim.gift_order_id,claim.attempt_no,
    claim.quantity,claim.status,claim.expires_at::text,claim.redeemed_by_employee_id,
    employee.display_name AS redeemed_by_employee_name,claim.redeemed_at::text,claim.fulfilled_at::text,
    rule.title,venue_table.code AS table_code,claim.table_session_id,
    membership.member_no,profile.display_name AS customer_name
    FROM mbox.annual_daily_snack_claims claim
    JOIN mbox.loyalty_annual_benefit_rules rule
      ON rule.tenant_id=claim.tenant_id AND rule.store_id=claim.store_id AND rule.id=claim.rule_id
    JOIN mbox.table_sessions session
      ON session.tenant_id=claim.tenant_id AND session.store_id=claim.store_id AND session.id=claim.table_session_id
    JOIN mbox.tables venue_table
      ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id AND venue_table.id=session.table_id
    LEFT JOIN mbox.customer_memberships membership
      ON membership.tenant_id=claim.tenant_id AND membership.store_id=claim.store_id
     AND membership.id=claim.membership_id
    LEFT JOIN mbox.customer_profiles profile
      ON profile.tenant_id=claim.tenant_id AND profile.store_id=claim.store_id
     AND profile.customer_id=claim.customer_id
    LEFT JOIN mbox.employees employee
      ON employee.tenant_id=claim.tenant_id AND employee.store_id=claim.store_id
     AND employee.id=claim.redeemed_by_employee_id
    WHERE claim.tenant_id=$1::uuid AND claim.store_id=$2::uuid`
}

function mapClaim(row: ClaimRow | undefined): AnnualDailySnackClaim | null {
  if (!row) return null
  return { id: row.id, claimCode: row.claim_code, benefitId: row.benefit_id, benefitReservationId: row.benefit_reservation_id,
    giftOrderId: row.gift_order_id, attemptNo: row.attempt_no, quantity: row.quantity, status: row.status, expiresAt: row.expires_at,
    redeemedByEmployeeId: row.redeemed_by_employee_id, redeemedByEmployeeName: row.redeemed_by_employee_name,
    redeemedAt: row.redeemed_at, fulfilledAt: row.fulfilled_at, title: row.title,
    ...(row.table_code === undefined ? {} : { tableCode: row.table_code }),
    ...(row.table_session_id === undefined ? {} : { tableSessionId: row.table_session_id }),
    ...(row.member_no === undefined ? {} : { memberNo: row.member_no }),
    ...(row.customer_name === undefined ? {} : { customerName: row.customer_name }) }
}

function outcome(context: AnnualDailySnackGuestContext, result: AnnualDailySnackClaim, action: string, objectId: string, afterData: JsonObject) {
  const actor: AuditActor = { type: 'guest', ref: context.actorRef }
  return { result, auditEvents: [{ actor, action, objectType: 'annual_daily_snack_claim', objectId, businessDate: context.businessDate, afterData }], outboxMessages: [{
    businessEventKey: `${action}:${objectId}`, aggregateType: 'annual_daily_snack_claim', aggregateId: objectId,
    aggregateVersion: 1, eventType: `${action}.v1`, payload: afterData,
  }] }
}
async function advisoryLock(transaction: ScopedTransaction, key: string) { await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]) }
function fingerprint(value: unknown) { return createHash('sha256').update(stable(value)).digest('hex') }
function stable(value: unknown): string { if(Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if(typeof value==='object'&&value!==null){const record=value as Record<string,unknown>;return `{${Object.keys(record).toSorted().map((key)=>`${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`}; return JSON.stringify(value) ?? 'null' }
function failure(message: string, code: string, statusCode = 409) { return new AnnualDailySnackClaimError(code, message, statusCode) }
const claimCodec: JsonCodec<AnnualDailySnackClaim> = { encode: (value) => value as unknown as JsonObject, decode: (value) => value as unknown as AnnualDailySnackClaim }
