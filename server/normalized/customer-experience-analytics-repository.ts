import type { ScopedTransaction } from './transaction-runner.js'

export type PerformancePhaseCode =
  | 'before_show' | 'acoustic' | 'band_live' | 'intermission' | 'after_show'

export type RecommendationOutcomeCode =
  | 'all' | 'paid' | 'refunded' | 'complaint' | 'follow_on_order'
  | 'repeat_purchase' | 'margin_unavailable'

export interface CustomerExperienceAnalyticsFilter {
  from: string
  until: string
  productId: string | null
  employeeId: string | null
  partySize: number | null
  occasion: string | null
  performancePhase: PerformancePhaseCode | null
  tableCode: string | null
  packageProductId: string | null
  recommendationOutcome: RecommendationOutcomeCode
}

export interface AnalyticsPackageOption { productId: string; productName: string }

export interface RecommendationAnalyticsRow {
  productId: string
  productName: string
  currency: string
  generated: number
  exposed: number
  selected: number
  ignored: number
  rejected: number
  staffModified: number
  ordered: number
  paid: number
  refunded: number
  paidAmountMinor: number
  refundedAmountMinor: number
  frozenCostMinor: number | null
  contributionAmountMinor: number | null
  complaintOrderCount: number
  followOnPaidOrderCount: number
  repeatPurchaseOrderCount: number
}

export interface ProductExperienceAnalyticsRow {
  productId: string
  productName: string
  paidOrderCount: number
  soldQuantity: number
  paidRevenueMinor: number
  refundedAmountMinor: number
  frozenCostMinor: number | null
  contributionAmountMinor: number | null
  observationCount: number
  praiseCount: number
  complaintCount: number
  remainingCount: number
  servedLateCount: number
  correctedCount: number
  averageObservationConfidence: number | null
}

export interface ObservationDataQualityRow {
  employeeId: string
  employeeName: string
  inputCount: number
  confirmedCount: number
  unmatchedInputCount: number
  correctedEventCount: number
  positiveEventCount: number
  neutralEventCount: number
  negativeEventCount: number
}

export interface ObservationEvidenceView {
  eventId: string
  tableCode: string
  productName: string | null
  employeeName: string
  performancePhase: PerformancePhaseCode | null
  expressionKind: string
  eventType: string
  degree: string | null
  rawExcerpt: string
  confidence: number
  revisionNo: number
  corrected: boolean
  occurredAt: string
}

export type WeeklySuggestionKind =
  | 'high_sales_low_experience'
  | 'low_sales_high_praise'
  | 'frequent_remaining'
  | 'likely_service_delay'

export interface WeeklyProductSuggestion {
  productId: string
  productName: string
  kind: WeeklySuggestionKind
  recommendation: string
  sampleSize: number
  supportingEvidence: number
  opposingEvidence: number
  confidence: number
  confidenceBasis: 'insufficient' | 'directional' | 'moderate' | 'strong'
}

export interface CustomerExperienceAnalyticsView {
  filter: CustomerExperienceAnalyticsFilter
  recommendation: RecommendationAnalyticsRow[]
  products: ProductExperienceAnalyticsRow[]
  dataQuality: {
    totalInputs: number
    confirmedInputs: number
    unmatchedInputs: number
    correctedEvents: number
    unmatchedRate: number
    correctionRate: number
    missingFacts: {
      recommendationWithoutExposureCount: number
      paidRecommendationCostUnavailableCount: number
      complaintWithoutOrderLinkCount: number
    }
    staff: ObservationDataQualityRow[]
  }
  weeklySuggestions: WeeklyProductSuggestion[]
  packageOptions: AnalyticsPackageOption[]
  filterCapabilities: {
    occasion: { available: true; basis: string }
    package: { available: true; basis: string }
    customerSegment: { available: false; reason: string; requiredFact: string }
  }
  generatedAt: string
  decisionBoundary: string
}

interface RecommendationRow extends Record<string, unknown> {
  product_id: string
  product_name: string
  currency: string
  generated: string | number
  exposed: string | number
  selected: string | number
  ignored: string | number
  rejected: string | number
  staff_modified: string | number
  ordered: string | number
  paid: string | number
  refunded: string | number
  paid_amount_minor: string | number
  refunded_amount_minor: string | number
  frozen_cost_minor: string | number | null
  unavailable_cost_count: string | number
  complaint_order_count: string | number
  follow_on_paid_order_count: string | number
  repeat_purchase_order_count: string | number
}

interface ProductRow extends Record<string, unknown> {
  product_id: string
  product_name: string
  paid_order_count: string | number
  sold_quantity: string | number
  paid_revenue_minor: string | number
  refunded_amount_minor: string | number
  frozen_cost_minor: string | number | null
  unavailable_cost_count: string | number
  observation_count: string | number
  praise_count: string | number
  complaint_count: string | number
  remaining_count: string | number
  served_late_count: string | number
  corrected_count: string | number
  average_observation_confidence: string | number | null
}

interface QualitySummaryRow extends Record<string, unknown> {
  total_inputs: string | number
  confirmed_inputs: string | number
  unmatched_inputs: string | number
  corrected_events: string | number
}

interface RecommendationQualityRow extends Record<string, unknown> {
  recommendation_without_exposure_count: string | number
  paid_recommendation_cost_unavailable_count: string | number
  complaint_without_order_link_count: string | number
}

interface QualityStaffRow extends Record<string, unknown> {
  employee_id: string
  employee_name: string
  input_count: string | number
  confirmed_count: string | number
  unmatched_input_count: string | number
  corrected_event_count: string | number
  positive_event_count: string | number
  neutral_event_count: string | number
  negative_event_count: string | number
}

export class CustomerExperienceAnalyticsRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async dashboard(filter: CustomerExperienceAnalyticsFilter): Promise<CustomerExperienceAnalyticsView> {
    validateFilter(filter)
    // A scoped transaction owns one PostgreSQL client. Keep reads sequential so
    // pg never receives overlapping queries on that client.
    const recommendation = (await this.recommendationRows(filter))
      .filter((row) => matchesRecommendationOutcome(row, filter.recommendationOutcome))
    const products = await this.productRows(filter)
    const qualitySummary = await this.qualitySummary(filter)
    const recommendationQuality = await this.recommendationQuality(filter)
    const staff = await this.qualityStaff(filter)
    const packageOptions = await this.packageOptions()
    const totalInputs = count(qualitySummary.total_inputs)
    const confirmedInputs = count(qualitySummary.confirmed_inputs)
    const unmatchedInputs = count(qualitySummary.unmatched_inputs)
    const correctedEvents = count(qualitySummary.corrected_events)
    return {
      filter,
      recommendation,
      products,
      dataQuality: {
        totalInputs,
        confirmedInputs,
        unmatchedInputs,
        correctedEvents,
        unmatchedRate: ratio(unmatchedInputs, totalInputs),
        correctionRate: ratio(correctedEvents, confirmedInputs),
        missingFacts: {
          recommendationWithoutExposureCount: count(
            recommendationQuality.recommendation_without_exposure_count,
          ),
          paidRecommendationCostUnavailableCount: count(
            recommendationQuality.paid_recommendation_cost_unavailable_count,
          ),
          complaintWithoutOrderLinkCount: count(
            recommendationQuality.complaint_without_order_link_count,
          ),
        },
        staff,
      },
      weeklySuggestions: buildWeeklySuggestions(products),
      packageOptions,
      filterCapabilities: {
        occasion: {
          available: true,
          basis: '该桌此次事实发生前最近一次推荐会话的强类型场景',
        },
        package: {
          available: true,
          basis: '套餐商品、BOM组成及订单行强父子关系；未关联订单行的观察不归入套餐',
        },
        customerSegment: {
          available: false,
          reason: '当前会员等级和生命周期只有当前值，不能代表事件发生时的客群',
          requiredFact: '需要关联canonical customer、客群类型、策略版本和生效时间窗的不可变分群事实',
        },
      },
      generatedAt: new Date().toISOString(),
      decisionBoundary: '分析仅用于人工复核；系统不得据此自动修改菜单、价格、权益或员工考核。',
    }
  }

  private async packageOptions(): Promise<AnalyticsPackageOption[]> {
    const result=await this.transaction.query<{ product_id:string;product_name:string }>(`
      SELECT product.id AS product_id,product.name AS product_name
      FROM mbox.products product
      WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
        AND product.product_kind='bundle' AND product.status='active'
      ORDER BY product.menu_sort_order,product.name,product.id
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId])
    return result.rows.map((row)=>({ productId:row.product_id,productName:row.product_name }))
  }

  async recentObservations(
    filter: CustomerExperienceAnalyticsFilter,
    limit = 50,
  ): Promise<ObservationEvidenceView[]> {
    validateFilter(filter)
    if (!Number.isInteger(limit) || limit<1 || limit>200) throw new TypeError('analytics evidence limit is invalid')
    const result = await this.transaction.query<{
      event_id: string; table_code: string; product_name: string | null; employee_name: string
      performance_phase: PerformancePhaseCode | null; expression_kind: string; event_type: string
      degree: string | null; raw_excerpt: string; confidence: string | number
      revision_no: number; corrected: boolean; occurred_at: string
    }>(`
      WITH latest_events AS (
        SELECT event.*,row_number() OVER (
          PARTITION BY event.event_group_id ORDER BY event.revision_no DESC,event.created_at DESC,event.id DESC
        ) AS latest_rank
        FROM mbox.observation_events event
        WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
          AND event.created_at>=$3::timestamptz AND event.created_at<$4::timestamptz
      )
      SELECT event.id AS event_id,venue_table.code AS table_code,product.name AS product_name,
        employee.display_name AS employee_name,live_phase.phase_code AS performance_phase,
        event.expression_kind,event.event_type,event.degree,event.raw_excerpt,event.confidence,
        event.revision_no,(event.revision_no>1) AS corrected,event.created_at::text AS occurred_at
      FROM latest_events event
      JOIN mbox.observation_inputs input
        ON input.tenant_id=event.tenant_id AND input.store_id=event.store_id
       AND input.id=event.observation_input_id
      JOIN mbox.table_sessions session
        ON session.tenant_id=input.tenant_id AND session.store_id=input.store_id
       AND session.id=input.table_session_id
      JOIN mbox.tables venue_table
        ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
       AND venue_table.id=session.table_id
      JOIN mbox.employees employee
        ON employee.tenant_id=input.tenant_id AND employee.store_id=input.store_id
       AND employee.id=input.recorded_by_employee_id
      LEFT JOIN mbox.products product
        ON product.tenant_id=event.tenant_id AND product.store_id=event.store_id
       AND product.id=event.product_id
      LEFT JOIN LATERAL (
        SELECT phase.phase_code
        FROM mbox.schedule_performance_phase_events phase
        WHERE phase.tenant_id=input.tenant_id AND phase.store_id=input.store_id
          AND phase.started_at<=event.created_at
          AND COALESCE(phase.ended_at,phase.cancelled_at,'infinity'::timestamptz)>event.created_at
          AND phase.status IN ('active','ended')
        ORDER BY phase.started_at DESC,phase.id DESC LIMIT 1
      ) live_phase ON true
      LEFT JOIN LATERAL (
        SELECT recommendation.occasion
        FROM mbox.recommendation_sessions recommendation
        WHERE recommendation.tenant_id=session.tenant_id AND recommendation.store_id=session.store_id
          AND recommendation.table_session_id=session.id AND recommendation.created_at<=event.created_at
        ORDER BY recommendation.created_at DESC,recommendation.id DESC LIMIT 1
      ) table_occasion ON true
      WHERE event.latest_rank=1 AND event.confirmation_state IN ('confirmed','corrected')
        AND ($5::uuid IS NULL OR event.product_id=$5::uuid)
        AND ($6::uuid IS NULL OR input.recorded_by_employee_id=$6::uuid)
        AND ($7::integer IS NULL OR session.guest_count=$7::integer)
        AND ($8::text IS NULL OR table_occasion.occasion=$8::text)
        AND ($9::text IS NULL OR live_phase.phase_code=$9::text)
        AND ($10::text IS NULL OR upper(venue_table.code)=upper($10::text))
        AND ($11::uuid IS NULL OR EXISTS (
          SELECT 1
          FROM mbox.order_items observed_item
          LEFT JOIN mbox.order_items parent_item
            ON parent_item.tenant_id=observed_item.tenant_id AND parent_item.store_id=observed_item.store_id
           AND parent_item.order_id=observed_item.order_id AND parent_item.id=observed_item.parent_order_item_id
          JOIN mbox.products package_product
            ON package_product.tenant_id=observed_item.tenant_id AND package_product.store_id=observed_item.store_id
           AND package_product.id=$11::uuid AND package_product.product_kind='bundle'
          WHERE observed_item.tenant_id=event.tenant_id AND observed_item.store_id=event.store_id
            AND observed_item.id=event.order_item_id
            AND (
              (observed_item.parent_order_item_id IS NULL AND observed_item.product_id=package_product.id)
              OR (parent_item.product_id=package_product.id AND EXISTS (
                SELECT 1 FROM mbox.product_bundle_components component
                WHERE component.tenant_id=observed_item.tenant_id AND component.store_id=observed_item.store_id
                  AND component.bundle_product_id=package_product.id
                  AND component.component_product_id=observed_item.product_id
              ))
            )
        ))
      ORDER BY event.created_at DESC,event.id DESC LIMIT $12
    `, [...params(this.transaction,filter),limit])
    return result.rows.map((row) => ({
      eventId: row.event_id,tableCode: row.table_code,productName: row.product_name,
      employeeName: row.employee_name,performancePhase: row.performance_phase,
      expressionKind: row.expression_kind,eventType: row.event_type,degree: row.degree,
      rawExcerpt: row.raw_excerpt,confidence: probability(row.confidence),
      revisionNo: row.revision_no,corrected: row.corrected,occurredAt: row.occurred_at,
    }))
  }

  private async recommendationRows(filter: CustomerExperienceAnalyticsFilter): Promise<RecommendationAnalyticsRow[]> {
    const result = await this.transaction.query<RecommendationRow>(`
      WITH scoped_sessions AS (
        SELECT session.id
        FROM mbox.recommendation_sessions session
        JOIN mbox.table_sessions table_session
          ON table_session.tenant_id=session.tenant_id AND table_session.store_id=session.store_id
         AND table_session.id=session.table_session_id
        JOIN mbox.tables venue_table
          ON venue_table.tenant_id=table_session.tenant_id AND venue_table.store_id=table_session.store_id
         AND venue_table.id=table_session.table_id
        LEFT JOIN LATERAL (
          SELECT phase.phase_code
          FROM mbox.schedule_performance_phase_events phase
          WHERE phase.tenant_id=session.tenant_id AND phase.store_id=session.store_id
            AND phase.started_at<=session.created_at
            AND COALESCE(phase.ended_at,phase.cancelled_at,'infinity'::timestamptz)>session.created_at
            AND phase.status IN ('active','ended')
          ORDER BY phase.started_at DESC,phase.id DESC LIMIT 1
        ) live_phase ON true
        WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
          AND session.created_at>=$3::timestamptz AND session.created_at<$4::timestamptz
          AND ($6::uuid IS NULL OR $6::uuid IS NOT NULL) -- employee applies only to staff observations
          AND ($7::integer IS NULL OR session.party_size=$7::integer)
          AND ($8::text IS NULL OR session.occasion=$8::text)
          AND ($9::text IS NULL OR live_phase.phase_code=$9::text)
          AND ($10::text IS NULL OR upper(venue_table.code)=upper($10::text))
      ), option_metrics AS (
        SELECT option.id,option.product_id,product.name AS product_name,option.currency,
          count(DISTINCT event.id) FILTER (WHERE event.event_type='generated')::bigint AS generated,
          count(DISTINCT event.id) FILTER (WHERE event.event_type='exposed')::bigint AS exposed,
          count(DISTINCT event.id) FILTER (WHERE event.event_type='selected')::bigint AS selected,
          count(DISTINCT event.id) FILTER (WHERE event.event_type='ignored')::bigint AS ignored,
          count(DISTINCT event.id) FILTER (WHERE event.event_type='rejected')::bigint AS rejected,
          count(DISTINCT event.id) FILTER (WHERE event.event_type='staff_modified')::bigint AS staff_modified,
          count(DISTINCT event.id) FILTER (WHERE event.event_type='ordered')::bigint AS ordered,
          count(DISTINCT event.id) FILTER (WHERE event.event_type='paid')::bigint AS paid,
          count(DISTINCT event.id) FILTER (WHERE event.event_type='refunded')::bigint AS refunded,
          COALESCE(sum(event.attributed_amount_minor) FILTER (WHERE event.event_type='paid'),0)::bigint AS paid_amount_minor,
          COALESCE(sum(event.attributed_amount_minor) FILTER (WHERE event.event_type='refunded'),0)::bigint AS refunded_amount_minor,
          cost.frozen_cost_minor,cost.unavailable_cost_count,
          complaint.complaint_order_count,follow_on.follow_on_paid_order_count,
          repeat_purchase.repeat_purchase_order_count
        FROM scoped_sessions scoped
        JOIN mbox.recommendation_options option
          ON option.tenant_id=$1::uuid AND option.store_id=$2::uuid
         AND option.recommendation_session_id=scoped.id
        JOIN mbox.products product
          ON product.tenant_id=option.tenant_id AND product.store_id=option.store_id
         AND product.id=option.product_id
        LEFT JOIN mbox.recommendation_behavior_events event
          ON event.tenant_id=option.tenant_id AND event.store_id=option.store_id
         AND event.recommendation_session_id=option.recommendation_session_id
         AND (event.recommendation_option_id=option.id OR (
           event.recommendation_option_id IS NULL AND event.event_type IN ('generated','exposed')
         ))
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(item.total_cost_minor_at_submission),0)::bigint AS frozen_cost_minor,
            count(*) FILTER (
              WHERE item.cost_source='unavailable' OR item.total_cost_minor_at_submission IS NULL
            )::bigint AS unavailable_cost_count
          FROM mbox.recommendation_behavior_events paid_event
          JOIN mbox.order_items item
            ON item.tenant_id=paid_event.tenant_id AND item.store_id=paid_event.store_id
           AND item.order_id=paid_event.order_id AND item.id=paid_event.order_item_id
          WHERE paid_event.tenant_id=option.tenant_id AND paid_event.store_id=option.store_id
            AND paid_event.recommendation_option_id=option.id AND paid_event.event_type='paid'
        ) cost ON true
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT complaint_group.id)::bigint AS complaint_order_count
          FROM mbox.recommendation_behavior_events ordered_event
          JOIN mbox.guest_service_request_groups complaint_group
            ON complaint_group.tenant_id=ordered_event.tenant_id
           AND complaint_group.store_id=ordered_event.store_id
           AND complaint_group.related_order_id=ordered_event.order_id
           AND complaint_group.request_type='complaint'
          WHERE ordered_event.tenant_id=option.tenant_id AND ordered_event.store_id=option.store_id
            AND ordered_event.recommendation_option_id=option.id AND ordered_event.event_type='ordered'
            AND complaint_group.last_requested_at>=$3::timestamptz
            AND complaint_group.last_requested_at<$4::timestamptz
        ) complaint ON true
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT later_order.id)::bigint AS follow_on_paid_order_count
          FROM mbox.recommendation_behavior_events ordered_event
          JOIN mbox.orders source_order
            ON source_order.tenant_id=ordered_event.tenant_id AND source_order.store_id=ordered_event.store_id
           AND source_order.id=ordered_event.order_id
          JOIN mbox.orders later_order
            ON later_order.tenant_id=source_order.tenant_id AND later_order.store_id=source_order.store_id
           AND later_order.table_session_id=source_order.table_session_id
           AND (later_order.submitted_at,later_order.id)>(source_order.submitted_at,source_order.id)
           AND later_order.submitted_at<$4::timestamptz
           AND later_order.status<>'cancelled'
           AND later_order.payment_status IN ('paid','partially_refunded')
          WHERE ordered_event.tenant_id=option.tenant_id AND ordered_event.store_id=option.store_id
            AND ordered_event.recommendation_option_id=option.id AND ordered_event.event_type='ordered'
        ) follow_on ON true
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT later_order.id)::bigint AS repeat_purchase_order_count
          FROM mbox.recommendation_behavior_events ordered_event
          JOIN mbox.orders source_order
            ON source_order.tenant_id=ordered_event.tenant_id AND source_order.store_id=ordered_event.store_id
           AND source_order.id=ordered_event.order_id
          JOIN mbox.table_sessions source_session
            ON source_session.tenant_id=source_order.tenant_id AND source_session.store_id=source_order.store_id
           AND source_session.id=source_order.table_session_id
          JOIN mbox.orders later_order
            ON later_order.tenant_id=source_order.tenant_id AND later_order.store_id=source_order.store_id
           AND later_order.created_by_customer_id IS NOT NULL
           AND later_order.status<>'cancelled'
           AND later_order.payment_status IN ('paid','partially_refunded')
           AND later_order.submitted_at<$4::timestamptz
          JOIN mbox.table_sessions later_session
            ON later_session.tenant_id=later_order.tenant_id AND later_session.store_id=later_order.store_id
           AND later_session.id=later_order.table_session_id
           AND later_session.business_date>source_session.business_date
          JOIN mbox.order_items later_item
            ON later_item.tenant_id=later_order.tenant_id AND later_item.store_id=later_order.store_id
           AND later_item.order_id=later_order.id AND later_item.product_id=option.product_id
           AND later_item.parent_order_item_id IS NULL AND later_item.status<>'cancelled'
          WHERE ordered_event.tenant_id=option.tenant_id AND ordered_event.store_id=option.store_id
            AND ordered_event.recommendation_option_id=option.id AND ordered_event.event_type='ordered'
            AND mbox.canonical_customer_id(
              ordered_event.tenant_id,ordered_event.store_id,later_order.created_by_customer_id
            )=mbox.canonical_customer_id(
              ordered_event.tenant_id,ordered_event.store_id,ordered_event.customer_id
            )
        ) repeat_purchase ON true
        WHERE ($5::uuid IS NULL OR option.product_id=$5::uuid)
          AND ($11::uuid IS NULL OR (option.product_id=$11::uuid AND product.product_kind='bundle'))
        GROUP BY option.id,option.product_id,product.name,option.currency,
          cost.frozen_cost_minor,cost.unavailable_cost_count,complaint.complaint_order_count,
          follow_on.follow_on_paid_order_count,repeat_purchase.repeat_purchase_order_count
      )
      SELECT product_id,product_name,currency,
        sum(generated)::bigint AS generated,sum(exposed)::bigint AS exposed,
        sum(selected)::bigint AS selected,sum(ignored)::bigint AS ignored,
        sum(rejected)::bigint AS rejected,sum(staff_modified)::bigint AS staff_modified,
        sum(ordered)::bigint AS ordered,sum(paid)::bigint AS paid,sum(refunded)::bigint AS refunded,
        sum(paid_amount_minor)::bigint AS paid_amount_minor,
        sum(refunded_amount_minor)::bigint AS refunded_amount_minor,
        sum(frozen_cost_minor)::bigint AS frozen_cost_minor,
        sum(unavailable_cost_count)::bigint AS unavailable_cost_count,
        sum(complaint_order_count)::bigint AS complaint_order_count,
        sum(follow_on_paid_order_count)::bigint AS follow_on_paid_order_count,
        sum(repeat_purchase_order_count)::bigint AS repeat_purchase_order_count
      FROM option_metrics
      GROUP BY product_id,product_name,currency
      ORDER BY paid_amount_minor DESC,selected DESC,product_name,product_id
    `, params(this.transaction, filter))
    return result.rows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      currency: row.currency,
      generated: count(row.generated),
      exposed: count(row.exposed),
      selected: count(row.selected),
      ignored: count(row.ignored),
      rejected: count(row.rejected),
      staffModified: count(row.staff_modified),
      ordered: count(row.ordered),
      paid: count(row.paid),
      refunded: count(row.refunded),
      paidAmountMinor: money(row.paid_amount_minor),
      refundedAmountMinor: money(row.refunded_amount_minor),
      frozenCostMinor: count(row.unavailable_cost_count)>0 || row.frozen_cost_minor===null
        ? null : money(row.frozen_cost_minor),
      contributionAmountMinor: count(row.unavailable_cost_count)>0 || row.frozen_cost_minor===null
        ? null
        : money(row.paid_amount_minor)-money(row.refunded_amount_minor)-money(row.frozen_cost_minor),
      complaintOrderCount: count(row.complaint_order_count),
      followOnPaidOrderCount: count(row.follow_on_paid_order_count),
      repeatPurchaseOrderCount: count(row.repeat_purchase_order_count),
    }))
  }

  private async productRows(filter: CustomerExperienceAnalyticsFilter): Promise<ProductExperienceAnalyticsRow[]> {
    const result = await this.transaction.query<ProductRow>(`
      WITH paid_sales AS (
        SELECT item.product_id,count(DISTINCT ordering.id)::bigint AS paid_order_count,
          COALESCE(sum(item.quantity),0)::bigint AS sold_quantity,
          COALESCE(sum(item.total_amount_minor),0)::bigint AS paid_revenue_minor,
          COALESCE(sum(item.total_cost_minor_at_submission)
            FILTER (WHERE item.cost_source<>'unavailable'),0)::bigint AS frozen_cost_minor,
          count(*) FILTER (WHERE item.cost_source='unavailable')::bigint AS unavailable_cost_count
        FROM mbox.orders ordering
        JOIN mbox.table_sessions table_session
          ON table_session.tenant_id=ordering.tenant_id AND table_session.store_id=ordering.store_id
         AND table_session.id=ordering.table_session_id
        JOIN mbox.tables venue_table
          ON venue_table.tenant_id=table_session.tenant_id AND venue_table.store_id=table_session.store_id
         AND venue_table.id=table_session.table_id
        JOIN mbox.order_items item
          ON item.tenant_id=ordering.tenant_id AND item.store_id=ordering.store_id
         AND item.order_id=ordering.id AND item.status<>'cancelled'
        LEFT JOIN mbox.order_items parent_item
          ON parent_item.tenant_id=item.tenant_id AND parent_item.store_id=item.store_id
         AND parent_item.order_id=item.order_id AND parent_item.id=item.parent_order_item_id
        LEFT JOIN LATERAL (
          SELECT phase.phase_code
          FROM mbox.schedule_performance_phase_events phase
          WHERE phase.tenant_id=ordering.tenant_id AND phase.store_id=ordering.store_id
            AND phase.started_at<=ordering.submitted_at
            AND COALESCE(phase.ended_at,phase.cancelled_at,'infinity'::timestamptz)>ordering.submitted_at
            AND phase.status IN ('active','ended')
          ORDER BY phase.started_at DESC,phase.id DESC LIMIT 1
        ) live_phase ON true
        LEFT JOIN LATERAL (
          SELECT recommendation.occasion
          FROM mbox.recommendation_sessions recommendation
          WHERE recommendation.tenant_id=ordering.tenant_id AND recommendation.store_id=ordering.store_id
            AND recommendation.table_session_id=ordering.table_session_id
            AND recommendation.created_at<=ordering.submitted_at
          ORDER BY recommendation.created_at DESC,recommendation.id DESC LIMIT 1
        ) table_occasion ON true
        WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
          AND ordering.payment_status IN ('paid','partially_refunded','refunded')
          AND ordering.submitted_at>=$3::timestamptz AND ordering.submitted_at<$4::timestamptz
          AND ($5::uuid IS NULL OR item.product_id=$5::uuid)
          AND ($7::integer IS NULL OR table_session.guest_count=$7::integer)
          AND ($8::text IS NULL OR table_occasion.occasion=$8::text)
          AND ($9::text IS NULL OR live_phase.phase_code=$9::text)
          AND ($10::text IS NULL OR upper(venue_table.code)=upper($10::text))
          AND (($11::uuid IS NULL AND item.parent_order_item_id IS NULL) OR (
            $11::uuid IS NOT NULL
            AND (
              (item.parent_order_item_id IS NULL AND item.product_id=$11::uuid)
              OR (parent_item.product_id=$11::uuid AND EXISTS (
                SELECT 1 FROM mbox.product_bundle_components component
                WHERE component.tenant_id=item.tenant_id AND component.store_id=item.store_id
                  AND component.bundle_product_id=$11::uuid AND component.component_product_id=item.product_id
              ))
            )
            AND EXISTS (
              SELECT 1 FROM mbox.products package_product
              WHERE package_product.tenant_id=item.tenant_id AND package_product.store_id=item.store_id
                AND package_product.id=$11::uuid AND package_product.product_kind='bundle'
            )
          ))
        GROUP BY item.product_id
      ), refunded AS (
        SELECT item.product_id,COALESCE(sum(refund_item.amount_minor),0)::bigint AS refunded_amount_minor
        FROM mbox.refunds refund
        JOIN mbox.refund_items refund_item
          ON refund_item.tenant_id=refund.tenant_id AND refund_item.store_id=refund.store_id
         AND refund_item.refund_id=refund.id
        JOIN mbox.order_items item
         ON item.tenant_id=refund_item.tenant_id AND item.store_id=refund_item.store_id
         AND item.id=refund_item.order_item_id
        LEFT JOIN mbox.order_items parent_item
          ON parent_item.tenant_id=item.tenant_id AND parent_item.store_id=item.store_id
         AND parent_item.order_id=item.order_id AND parent_item.id=item.parent_order_item_id
        JOIN mbox.orders ordering
          ON ordering.tenant_id=item.tenant_id AND ordering.store_id=item.store_id AND ordering.id=item.order_id
        JOIN mbox.table_sessions table_session
          ON table_session.tenant_id=ordering.tenant_id AND table_session.store_id=ordering.store_id
         AND table_session.id=ordering.table_session_id
        JOIN mbox.tables venue_table
          ON venue_table.tenant_id=table_session.tenant_id AND venue_table.store_id=table_session.store_id
         AND venue_table.id=table_session.table_id
        LEFT JOIN LATERAL (
          SELECT phase.phase_code
          FROM mbox.schedule_performance_phase_events phase
          WHERE phase.tenant_id=ordering.tenant_id AND phase.store_id=ordering.store_id
            AND phase.started_at<=ordering.submitted_at
            AND COALESCE(phase.ended_at,phase.cancelled_at,'infinity'::timestamptz)>ordering.submitted_at
            AND phase.status IN ('active','ended')
          ORDER BY phase.started_at DESC,phase.id DESC LIMIT 1
        ) live_phase ON true
        LEFT JOIN LATERAL (
          SELECT recommendation.occasion
          FROM mbox.recommendation_sessions recommendation
          WHERE recommendation.tenant_id=ordering.tenant_id AND recommendation.store_id=ordering.store_id
            AND recommendation.table_session_id=ordering.table_session_id
            AND recommendation.created_at<=ordering.submitted_at
          ORDER BY recommendation.created_at DESC,recommendation.id DESC LIMIT 1
        ) table_occasion ON true
        WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid
          AND refund.status='succeeded' AND refund.completed_at>=$3::timestamptz
          AND refund.completed_at<$4::timestamptz
          AND ($5::uuid IS NULL OR item.product_id=$5::uuid)
          AND ($7::integer IS NULL OR table_session.guest_count=$7::integer)
          AND ($8::text IS NULL OR table_occasion.occasion=$8::text)
          AND ($9::text IS NULL OR live_phase.phase_code=$9::text)
          AND ($10::text IS NULL OR upper(venue_table.code)=upper($10::text))
          AND (($11::uuid IS NULL AND item.parent_order_item_id IS NULL) OR (
            $11::uuid IS NOT NULL
            AND (
              (item.parent_order_item_id IS NULL AND item.product_id=$11::uuid)
              OR (parent_item.product_id=$11::uuid AND EXISTS (
                SELECT 1 FROM mbox.product_bundle_components component
                WHERE component.tenant_id=item.tenant_id AND component.store_id=item.store_id
                  AND component.bundle_product_id=$11::uuid AND component.component_product_id=item.product_id
              ))
            )
            AND EXISTS (
              SELECT 1 FROM mbox.products package_product
              WHERE package_product.tenant_id=item.tenant_id AND package_product.store_id=item.store_id
                AND package_product.id=$11::uuid AND package_product.product_kind='bundle'
            )
          ))
        GROUP BY item.product_id
      ), latest_events AS (
        SELECT event.*,row_number() OVER (
          PARTITION BY event.event_group_id ORDER BY event.revision_no DESC,event.created_at DESC,event.id DESC
        ) AS latest_rank
        FROM mbox.observation_events event
        WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
          AND event.created_at>=$3::timestamptz AND event.created_at<$4::timestamptz
      ), observations AS (
        SELECT event.product_id,count(*)::bigint AS observation_count,
          count(*) FILTER (WHERE event.event_type='praise')::bigint AS praise_count,
          count(*) FILTER (WHERE event.event_type='complaint')::bigint AS complaint_count,
          count(*) FILTER (WHERE event.event_type IN ('remaining','consumed_little'))::bigint AS remaining_count,
          count(*) FILTER (WHERE event.event_type='served_late')::bigint AS served_late_count,
          count(*) FILTER (WHERE event.revision_no>1)::bigint AS corrected_count,
          avg(event.confidence)::numeric AS average_observation_confidence
        FROM latest_events event
        JOIN mbox.observation_inputs input
          ON input.tenant_id=event.tenant_id AND input.store_id=event.store_id
         AND input.id=event.observation_input_id
        JOIN mbox.table_sessions table_session
          ON table_session.tenant_id=input.tenant_id AND table_session.store_id=input.store_id
         AND table_session.id=input.table_session_id
        JOIN mbox.tables venue_table
          ON venue_table.tenant_id=table_session.tenant_id AND venue_table.store_id=table_session.store_id
         AND venue_table.id=table_session.table_id
        LEFT JOIN LATERAL (
          SELECT phase.phase_code
          FROM mbox.schedule_performance_phase_events phase
          WHERE phase.tenant_id=input.tenant_id AND phase.store_id=input.store_id
            AND phase.started_at<=event.created_at
            AND COALESCE(phase.ended_at,phase.cancelled_at,'infinity'::timestamptz)>event.created_at
            AND phase.status IN ('active','ended')
          ORDER BY phase.started_at DESC,phase.id DESC LIMIT 1
        ) live_phase ON true
        LEFT JOIN LATERAL (
          SELECT recommendation.occasion
          FROM mbox.recommendation_sessions recommendation
          WHERE recommendation.tenant_id=table_session.tenant_id
            AND recommendation.store_id=table_session.store_id
            AND recommendation.table_session_id=table_session.id
            AND recommendation.created_at<=event.created_at
          ORDER BY recommendation.created_at DESC,recommendation.id DESC LIMIT 1
        ) table_occasion ON true
        WHERE event.latest_rank=1 AND event.confirmation_state IN ('confirmed','corrected')
          AND event.product_id IS NOT NULL
          AND ($5::uuid IS NULL OR event.product_id=$5::uuid)
          AND ($6::uuid IS NULL OR input.recorded_by_employee_id=$6::uuid)
          AND ($7::integer IS NULL OR table_session.guest_count=$7::integer)
          AND ($8::text IS NULL OR table_occasion.occasion=$8::text)
          AND ($9::text IS NULL OR live_phase.phase_code=$9::text)
          AND ($10::text IS NULL OR upper(venue_table.code)=upper($10::text))
          AND ($11::uuid IS NULL OR EXISTS (
            SELECT 1
            FROM mbox.order_items observed_item
            LEFT JOIN mbox.order_items parent_item
              ON parent_item.tenant_id=observed_item.tenant_id AND parent_item.store_id=observed_item.store_id
             AND parent_item.order_id=observed_item.order_id AND parent_item.id=observed_item.parent_order_item_id
            JOIN mbox.products package_product
              ON package_product.tenant_id=observed_item.tenant_id AND package_product.store_id=observed_item.store_id
             AND package_product.id=$11::uuid AND package_product.product_kind='bundle'
            WHERE observed_item.tenant_id=event.tenant_id AND observed_item.store_id=event.store_id
              AND observed_item.id=event.order_item_id
              AND (
                (observed_item.parent_order_item_id IS NULL AND observed_item.product_id=package_product.id)
                OR (parent_item.product_id=package_product.id AND EXISTS (
                  SELECT 1 FROM mbox.product_bundle_components component
                  WHERE component.tenant_id=observed_item.tenant_id AND component.store_id=observed_item.store_id
                    AND component.bundle_product_id=package_product.id
                    AND component.component_product_id=observed_item.product_id
                ))
              )
          ))
        GROUP BY event.product_id
      )
      SELECT product.id AS product_id,product.name AS product_name,
        COALESCE(paid_sales.paid_order_count,0)::bigint AS paid_order_count,
        COALESCE(paid_sales.sold_quantity,0)::bigint AS sold_quantity,
        COALESCE(paid_sales.paid_revenue_minor,0)::bigint AS paid_revenue_minor,
        COALESCE(refunded.refunded_amount_minor,0)::bigint AS refunded_amount_minor,
        paid_sales.frozen_cost_minor,COALESCE(paid_sales.unavailable_cost_count,0)::bigint AS unavailable_cost_count,
        COALESCE(observations.observation_count,0)::bigint AS observation_count,
        COALESCE(observations.praise_count,0)::bigint AS praise_count,
        COALESCE(observations.complaint_count,0)::bigint AS complaint_count,
        COALESCE(observations.remaining_count,0)::bigint AS remaining_count,
        COALESCE(observations.served_late_count,0)::bigint AS served_late_count,
        COALESCE(observations.corrected_count,0)::bigint AS corrected_count,
        observations.average_observation_confidence
      FROM mbox.products product
      LEFT JOIN paid_sales ON paid_sales.product_id=product.id
      LEFT JOIN refunded ON refunded.product_id=product.id
      LEFT JOIN observations ON observations.product_id=product.id
      WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
        AND ($5::uuid IS NULL OR product.id=$5::uuid)
        AND (paid_sales.product_id IS NOT NULL OR observations.product_id IS NOT NULL)
      ORDER BY paid_revenue_minor DESC,observation_count DESC,product.name,product.id
    `, params(this.transaction, filter))
    return result.rows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      paidOrderCount: count(row.paid_order_count),
      soldQuantity: count(row.sold_quantity),
      paidRevenueMinor: money(row.paid_revenue_minor),
      refundedAmountMinor: money(row.refunded_amount_minor),
      frozenCostMinor: count(row.unavailable_cost_count) > 0 || row.frozen_cost_minor === null
        ? null : money(row.frozen_cost_minor),
      contributionAmountMinor: count(row.unavailable_cost_count) > 0 || row.frozen_cost_minor === null
        ? null : money(row.paid_revenue_minor)-money(row.refunded_amount_minor)-money(row.frozen_cost_minor),
      observationCount: count(row.observation_count),
      praiseCount: count(row.praise_count),
      complaintCount: count(row.complaint_count),
      remainingCount: count(row.remaining_count),
      servedLateCount: count(row.served_late_count),
      correctedCount: count(row.corrected_count),
      averageObservationConfidence: row.average_observation_confidence === null
        ? null : probability(row.average_observation_confidence),
    }))
  }

  private async qualitySummary(filter: CustomerExperienceAnalyticsFilter): Promise<QualitySummaryRow> {
    const result = await this.transaction.query<QualitySummaryRow>(`
      WITH filtered_inputs AS (
        SELECT input.*
        FROM mbox.observation_inputs input
        JOIN mbox.table_sessions table_session
          ON table_session.tenant_id=input.tenant_id AND table_session.store_id=input.store_id
         AND table_session.id=input.table_session_id
        JOIN mbox.tables venue_table
          ON venue_table.tenant_id=table_session.tenant_id AND venue_table.store_id=table_session.store_id
         AND venue_table.id=table_session.table_id
        LEFT JOIN LATERAL (
          SELECT recommendation.occasion
          FROM mbox.recommendation_sessions recommendation
          WHERE recommendation.tenant_id=table_session.tenant_id
            AND recommendation.store_id=table_session.store_id
            AND recommendation.table_session_id=table_session.id
            AND recommendation.created_at<=input.created_at
          ORDER BY recommendation.created_at DESC,recommendation.id DESC LIMIT 1
        ) table_occasion ON true
        WHERE input.tenant_id=$1::uuid AND input.store_id=$2::uuid
          AND input.created_at>=$3::timestamptz AND input.created_at<$4::timestamptz
          AND ($6::uuid IS NULL OR input.recorded_by_employee_id=$6::uuid)
          AND ($7::integer IS NULL OR table_session.guest_count=$7::integer)
          AND ($8::text IS NULL OR table_occasion.occasion=$8::text)
          AND ($10::text IS NULL OR upper(venue_table.code)=upper($10::text))
          AND (($5::uuid IS NULL AND $9::text IS NULL AND $11::uuid IS NULL) OR EXISTS (
            SELECT 1
            FROM mbox.observation_events event
            LEFT JOIN LATERAL (
              SELECT phase.phase_code
              FROM mbox.schedule_performance_phase_events phase
              WHERE phase.tenant_id=event.tenant_id AND phase.store_id=event.store_id
                AND phase.started_at<=event.created_at
                AND COALESCE(phase.ended_at,phase.cancelled_at,'infinity'::timestamptz)>event.created_at
                AND phase.status IN ('active','ended')
              ORDER BY phase.started_at DESC,phase.id DESC LIMIT 1
            ) live_phase ON true
            WHERE event.tenant_id=input.tenant_id AND event.store_id=input.store_id
              AND event.observation_input_id=input.id
              AND event.confirmation_state IN ('confirmed','corrected')
              AND NOT EXISTS (
                SELECT 1 FROM mbox.observation_events newer
                WHERE newer.tenant_id=event.tenant_id AND newer.store_id=event.store_id
                  AND newer.event_group_id=event.event_group_id
                  AND (newer.revision_no,newer.created_at,newer.id)>(event.revision_no,event.created_at,event.id)
              )
              AND ($5::uuid IS NULL OR event.product_id=$5::uuid)
              AND ($9::text IS NULL OR live_phase.phase_code=$9::text)
              AND ($11::uuid IS NULL OR EXISTS (
                SELECT 1
                FROM mbox.order_items observed_item
                LEFT JOIN mbox.order_items parent_item
                  ON parent_item.tenant_id=observed_item.tenant_id AND parent_item.store_id=observed_item.store_id
                 AND parent_item.order_id=observed_item.order_id AND parent_item.id=observed_item.parent_order_item_id
                JOIN mbox.products package_product
                  ON package_product.tenant_id=observed_item.tenant_id
                 AND package_product.store_id=observed_item.store_id
                 AND package_product.id=$11::uuid AND package_product.product_kind='bundle'
                WHERE observed_item.tenant_id=event.tenant_id AND observed_item.store_id=event.store_id
                  AND observed_item.id=event.order_item_id
                  AND (
                    (observed_item.parent_order_item_id IS NULL AND observed_item.product_id=package_product.id)
                    OR (parent_item.product_id=package_product.id AND EXISTS (
                      SELECT 1 FROM mbox.product_bundle_components component
                      WHERE component.tenant_id=observed_item.tenant_id AND component.store_id=observed_item.store_id
                        AND component.bundle_product_id=package_product.id
                        AND component.component_product_id=observed_item.product_id
                    ))
                  )
              ))
          ))
      )
      SELECT count(DISTINCT input.id)::bigint AS total_inputs,
        count(DISTINCT input.id) FILTER (WHERE input.status='confirmed')::bigint AS confirmed_inputs,
        count(DISTINCT input.id) FILTER (
          WHERE input.status='confirmed' AND NOT EXISTS (
            SELECT 1 FROM mbox.observation_match_candidates candidate
            WHERE candidate.tenant_id=input.tenant_id AND candidate.store_id=input.store_id
              AND candidate.observation_input_id=input.id
          )
        )::bigint AS unmatched_inputs,
        count(DISTINCT revision.id)::bigint AS corrected_events
      FROM filtered_inputs input
      LEFT JOIN mbox.observation_revisions revision
        ON revision.tenant_id=input.tenant_id AND revision.store_id=input.store_id
       AND revision.observation_input_id=input.id
    `, params(this.transaction, filter))
    return result.rows[0] ?? {
      total_inputs: 0, confirmed_inputs: 0, unmatched_inputs: 0, corrected_events: 0,
    }
  }

  private async recommendationQuality(filter: CustomerExperienceAnalyticsFilter): Promise<RecommendationQualityRow> {
    const result = await this.transaction.query<RecommendationQualityRow>(`
      WITH scoped_sessions AS (
        SELECT session.id
        FROM mbox.recommendation_sessions session
        JOIN mbox.table_sessions table_session
          ON table_session.tenant_id=session.tenant_id AND table_session.store_id=session.store_id
         AND table_session.id=session.table_session_id
        JOIN mbox.tables venue_table
          ON venue_table.tenant_id=table_session.tenant_id AND venue_table.store_id=table_session.store_id
         AND venue_table.id=table_session.table_id
        LEFT JOIN LATERAL (
          SELECT phase.phase_code
          FROM mbox.schedule_performance_phase_events phase
          WHERE phase.tenant_id=session.tenant_id AND phase.store_id=session.store_id
            AND phase.started_at<=session.created_at
            AND COALESCE(phase.ended_at,phase.cancelled_at,'infinity'::timestamptz)>session.created_at
            AND phase.status IN ('active','ended')
          ORDER BY phase.started_at DESC,phase.id DESC LIMIT 1
        ) live_phase ON true
        WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
          AND session.created_at>=$3::timestamptz AND session.created_at<$4::timestamptz
          AND ($6::uuid IS NULL OR $6::uuid IS NOT NULL) -- employee applies only to staff observations
          AND ($7::integer IS NULL OR session.party_size=$7::integer)
          AND ($8::text IS NULL OR session.occasion=$8::text)
          AND ($9::text IS NULL OR live_phase.phase_code=$9::text)
          AND ($10::text IS NULL OR upper(venue_table.code)=upper($10::text))
          AND ($5::uuid IS NULL OR EXISTS (
            SELECT 1 FROM mbox.recommendation_options option
            WHERE option.tenant_id=session.tenant_id AND option.store_id=session.store_id
              AND option.recommendation_session_id=session.id AND option.product_id=$5::uuid
          ))
          AND ($11::uuid IS NULL OR EXISTS (
            SELECT 1
            FROM mbox.recommendation_options option
            JOIN mbox.products package_product
              ON package_product.tenant_id=option.tenant_id AND package_product.store_id=option.store_id
             AND package_product.id=option.product_id AND package_product.product_kind='bundle'
            WHERE option.tenant_id=session.tenant_id AND option.store_id=session.store_id
              AND option.recommendation_session_id=session.id AND option.product_id=$11::uuid
          ))
      ), unlinked_complaints AS (
        SELECT complaint.id
        FROM mbox.guest_service_request_groups complaint
        JOIN mbox.table_sessions table_session
          ON table_session.tenant_id=complaint.tenant_id AND table_session.store_id=complaint.store_id
         AND table_session.id=complaint.table_session_id
        JOIN mbox.tables venue_table
          ON venue_table.tenant_id=table_session.tenant_id AND venue_table.store_id=table_session.store_id
         AND venue_table.id=table_session.table_id
        LEFT JOIN LATERAL (
          SELECT phase.phase_code
          FROM mbox.schedule_performance_phase_events phase
          WHERE phase.tenant_id=complaint.tenant_id AND phase.store_id=complaint.store_id
            AND phase.started_at<=complaint.last_requested_at
            AND COALESCE(phase.ended_at,phase.cancelled_at,'infinity'::timestamptz)>complaint.last_requested_at
            AND phase.status IN ('active','ended')
          ORDER BY phase.started_at DESC,phase.id DESC LIMIT 1
        ) live_phase ON true
        LEFT JOIN LATERAL (
          SELECT recommendation.occasion
          FROM mbox.recommendation_sessions recommendation
          WHERE recommendation.tenant_id=table_session.tenant_id
            AND recommendation.store_id=table_session.store_id
            AND recommendation.table_session_id=table_session.id
            AND recommendation.created_at<=complaint.last_requested_at
          ORDER BY recommendation.created_at DESC,recommendation.id DESC LIMIT 1
        ) table_occasion ON true
        WHERE complaint.tenant_id=$1::uuid AND complaint.store_id=$2::uuid
          AND complaint.request_type='complaint' AND complaint.related_order_id IS NULL
          AND complaint.last_requested_at>=$3::timestamptz AND complaint.last_requested_at<$4::timestamptz
          AND $5::uuid IS NULL AND $11::uuid IS NULL
          AND ($7::integer IS NULL OR table_session.guest_count=$7::integer)
          AND ($8::text IS NULL OR table_occasion.occasion=$8::text)
          AND ($9::text IS NULL OR live_phase.phase_code=$9::text)
          AND ($10::text IS NULL OR upper(venue_table.code)=upper($10::text))
      )
      SELECT
        (SELECT count(*)::bigint FROM scoped_sessions session WHERE NOT EXISTS (
          SELECT 1 FROM mbox.recommendation_behavior_events event
          WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
            AND event.recommendation_session_id=session.id AND event.event_type='exposed'
        )) AS recommendation_without_exposure_count,
        (SELECT count(DISTINCT paid_event.id)::bigint
          FROM scoped_sessions session
          JOIN mbox.recommendation_behavior_events paid_event
            ON paid_event.tenant_id=$1::uuid AND paid_event.store_id=$2::uuid
           AND paid_event.recommendation_session_id=session.id AND paid_event.event_type='paid'
          JOIN mbox.recommendation_options option
            ON option.tenant_id=paid_event.tenant_id AND option.store_id=paid_event.store_id
           AND option.id=paid_event.recommendation_option_id
          JOIN mbox.order_items item
            ON item.tenant_id=paid_event.tenant_id AND item.store_id=paid_event.store_id
           AND item.order_id=paid_event.order_id AND item.id=paid_event.order_item_id
          WHERE ($5::uuid IS NULL OR option.product_id=$5::uuid)
            AND ($11::uuid IS NULL OR option.product_id=$11::uuid)
            AND (item.cost_source='unavailable' OR item.total_cost_minor_at_submission IS NULL)
        ) AS paid_recommendation_cost_unavailable_count,
        (SELECT count(*)::bigint FROM unlinked_complaints) AS complaint_without_order_link_count
    `, params(this.transaction,filter))
    return result.rows[0] ?? {
      recommendation_without_exposure_count: 0,
      paid_recommendation_cost_unavailable_count: 0,
      complaint_without_order_link_count: 0,
    }
  }

  private async qualityStaff(filter: CustomerExperienceAnalyticsFilter): Promise<ObservationDataQualityRow[]> {
    const result = await this.transaction.query<QualityStaffRow>(`
      WITH inputs AS (
        SELECT input.id,input.recorded_by_employee_id,input.status,
          NOT EXISTS (
            SELECT 1 FROM mbox.observation_match_candidates candidate
            WHERE candidate.tenant_id=input.tenant_id AND candidate.store_id=input.store_id
              AND candidate.observation_input_id=input.id
          ) AS unmatched
        FROM mbox.observation_inputs input
        JOIN mbox.table_sessions table_session
          ON table_session.tenant_id=input.tenant_id AND table_session.store_id=input.store_id
         AND table_session.id=input.table_session_id
        JOIN mbox.tables venue_table
          ON venue_table.tenant_id=table_session.tenant_id AND venue_table.store_id=table_session.store_id
         AND venue_table.id=table_session.table_id
        LEFT JOIN LATERAL (
          SELECT recommendation.occasion
          FROM mbox.recommendation_sessions recommendation
          WHERE recommendation.tenant_id=table_session.tenant_id
            AND recommendation.store_id=table_session.store_id
            AND recommendation.table_session_id=table_session.id
            AND recommendation.created_at<=input.created_at
          ORDER BY recommendation.created_at DESC,recommendation.id DESC LIMIT 1
        ) table_occasion ON true
        WHERE input.tenant_id=$1::uuid AND input.store_id=$2::uuid
          AND input.created_at>=$3::timestamptz AND input.created_at<$4::timestamptz
          AND ($6::uuid IS NULL OR input.recorded_by_employee_id=$6::uuid)
          AND ($7::integer IS NULL OR table_session.guest_count=$7::integer)
          AND ($8::text IS NULL OR table_occasion.occasion=$8::text)
          AND ($10::text IS NULL OR upper(venue_table.code)=upper($10::text))
          AND (($5::uuid IS NULL AND $9::text IS NULL AND $11::uuid IS NULL) OR EXISTS (
            SELECT 1
            FROM mbox.observation_events filtered_event
            LEFT JOIN LATERAL (
              SELECT phase.phase_code
              FROM mbox.schedule_performance_phase_events phase
              WHERE phase.tenant_id=filtered_event.tenant_id AND phase.store_id=filtered_event.store_id
                AND phase.started_at<=filtered_event.created_at
                AND COALESCE(phase.ended_at,phase.cancelled_at,'infinity'::timestamptz)>filtered_event.created_at
                AND phase.status IN ('active','ended')
              ORDER BY phase.started_at DESC,phase.id DESC LIMIT 1
            ) live_phase ON true
            WHERE filtered_event.tenant_id=input.tenant_id AND filtered_event.store_id=input.store_id
              AND filtered_event.observation_input_id=input.id
              AND filtered_event.confirmation_state IN ('confirmed','corrected')
              AND NOT EXISTS (
                SELECT 1 FROM mbox.observation_events newer
                WHERE newer.tenant_id=filtered_event.tenant_id AND newer.store_id=filtered_event.store_id
                  AND newer.event_group_id=filtered_event.event_group_id
                  AND (newer.revision_no,newer.created_at,newer.id)>
                    (filtered_event.revision_no,filtered_event.created_at,filtered_event.id)
              )
              AND ($5::uuid IS NULL OR filtered_event.product_id=$5::uuid)
              AND ($9::text IS NULL OR live_phase.phase_code=$9::text)
              AND ($11::uuid IS NULL OR EXISTS (
                SELECT 1
                FROM mbox.order_items observed_item
                LEFT JOIN mbox.order_items parent_item
                  ON parent_item.tenant_id=observed_item.tenant_id AND parent_item.store_id=observed_item.store_id
                 AND parent_item.order_id=observed_item.order_id AND parent_item.id=observed_item.parent_order_item_id
                JOIN mbox.products package_product
                  ON package_product.tenant_id=observed_item.tenant_id
                 AND package_product.store_id=observed_item.store_id
                 AND package_product.id=$11::uuid AND package_product.product_kind='bundle'
                WHERE observed_item.tenant_id=filtered_event.tenant_id
                  AND observed_item.store_id=filtered_event.store_id
                  AND observed_item.id=filtered_event.order_item_id
                  AND (
                    (observed_item.parent_order_item_id IS NULL AND observed_item.product_id=package_product.id)
                    OR (parent_item.product_id=package_product.id AND EXISTS (
                      SELECT 1 FROM mbox.product_bundle_components component
                      WHERE component.tenant_id=observed_item.tenant_id AND component.store_id=observed_item.store_id
                        AND component.bundle_product_id=package_product.id
                        AND component.component_product_id=observed_item.product_id
                    ))
                  )
              ))
          ))
      ), latest_events AS (
        SELECT event.*,row_number() OVER (
          PARTITION BY event.event_group_id ORDER BY event.revision_no DESC,event.created_at DESC,event.id DESC
        ) AS latest_rank
        FROM mbox.observation_events event JOIN inputs ON inputs.id=event.observation_input_id
        WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
      )
      SELECT employee.id AS employee_id,employee.display_name AS employee_name,
        count(DISTINCT inputs.id)::bigint AS input_count,
        count(DISTINCT inputs.id) FILTER (WHERE inputs.status='confirmed')::bigint AS confirmed_count,
        count(DISTINCT inputs.id) FILTER (WHERE inputs.status='confirmed' AND inputs.unmatched)::bigint AS unmatched_input_count,
        count(DISTINCT event.event_group_id) FILTER (WHERE event.latest_rank=1 AND event.revision_no>1)::bigint AS corrected_event_count,
        count(DISTINCT event.event_group_id) FILTER (WHERE event.latest_rank=1 AND event.event_type='praise')::bigint AS positive_event_count,
        count(DISTINCT event.event_group_id) FILTER (WHERE event.latest_rank=1 AND event.event_type IN ('presentation','portion','other'))::bigint AS neutral_event_count,
        count(DISTINCT event.event_group_id) FILTER (WHERE event.latest_rank=1 AND event.event_type IN (
          'remaining','consumed_little','complaint','too_sweet','too_cold','served_late'
        ))::bigint AS negative_event_count
      FROM inputs
      JOIN mbox.employees employee
        ON employee.tenant_id=$1::uuid AND employee.store_id=$2::uuid
       AND employee.id=inputs.recorded_by_employee_id
      LEFT JOIN latest_events event ON event.observation_input_id=inputs.id
      GROUP BY employee.id,employee.display_name
      ORDER BY input_count DESC,employee.display_name,employee.id
    `, params(this.transaction, filter))
    return result.rows.map((row) => ({
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      inputCount: count(row.input_count),
      confirmedCount: count(row.confirmed_count),
      unmatchedInputCount: count(row.unmatched_input_count),
      correctedEventCount: count(row.corrected_event_count),
      positiveEventCount: count(row.positive_event_count),
      neutralEventCount: count(row.neutral_event_count),
      negativeEventCount: count(row.negative_event_count),
    }))
  }
}

export function buildWeeklySuggestions(rows: readonly ProductExperienceAnalyticsRow[]): WeeklyProductSuggestion[] {
  if (rows.length === 0) return []
  const sold = rows.map((row) => row.soldQuantity).toSorted((left, right) => left-right)
  const medianSales = sold[Math.floor(sold.length/2)] ?? 0
  const suggestions: WeeklyProductSuggestion[] = []
  for (const row of rows) {
    const negative = row.complaintCount + row.remainingCount
    const positive = row.praiseCount
    if (row.soldQuantity>=Math.max(3,medianSales) && negative>=3) {
      suggestions.push(suggestion(row,'high_sales_low_experience',
        '保留销售入口，先复核份量、搭配与现场反馈，再做小范围调整测试。',negative,positive))
    }
    if (row.soldQuantity<Math.max(3,medianSales) && positive>=3 && positive>negative) {
      suggestions.push(suggestion(row,'low_sales_high_praise',
        '检查曝光、命名和菜单位置，先做小范围展示测试，不直接改价。',positive,negative))
    }
    if (row.remainingCount>=3) {
      suggestions.push(suggestion(row,'frequent_remaining',
        '复核份量、套餐搭配和上桌顺序，保留相反证据后再决定是否调整。',row.remainingCount,positive))
    }
    if (row.servedLateCount>=3) {
      suggestions.push(suggestion(row,'likely_service_delay',
        '优先核对KDS时间与产能，不要把出品延迟直接归因于商品本身。',row.servedLateCount,
        Math.max(0,row.complaintCount-row.servedLateCount)))
    }
  }
  return suggestions.toSorted((left,right) => right.confidence-left.confidence
    || right.sampleSize-left.sampleSize || left.productName.localeCompare(right.productName))
}

function suggestion(
  row: ProductExperienceAnalyticsRow,
  kind: WeeklySuggestionKind,
  recommendation: string,
  supportingEvidence: number,
  opposingEvidence: number,
): WeeklyProductSuggestion {
  const sampleSize = row.observationCount
  const effective = Math.max(0,supportingEvidence-opposingEvidence)
  const coverage = Math.min(1,sampleSize/20)
  const direction = supportingEvidence===0 ? 0 : effective/supportingEvidence
  const confidence = Number(Math.min(0.95,coverage*0.7+direction*0.25).toFixed(2))
  return {
    productId: row.productId,
    productName: row.productName,
    kind,
    recommendation,
    sampleSize,
    supportingEvidence,
    opposingEvidence,
    confidence,
    confidenceBasis: sampleSize<3 ? 'insufficient' : sampleSize<8 ? 'directional' : sampleSize<20 ? 'moderate' : 'strong',
  }
}

function params(transaction: ScopedTransaction, filter: CustomerExperienceAnalyticsFilter): readonly unknown[] {
  return [
    transaction.scope.tenantId,transaction.scope.storeId,filter.from,filter.until,
    filter.productId,filter.employeeId,filter.partySize,filter.occasion,filter.performancePhase,filter.tableCode,
    filter.packageProductId,
  ]
}

function validateFilter(filter: CustomerExperienceAnalyticsFilter): void {
  const from = Date.parse(filter.from)
  const until = Date.parse(filter.until)
  if (!Number.isFinite(from) || !Number.isFinite(until) || until<=from) throw new TypeError('analytics range is invalid')
  if (until-from>93*24*60*60*1000) throw new TypeError('analytics range cannot exceed 93 days')
  if (filter.partySize!==null && (!Number.isInteger(filter.partySize) || filter.partySize<1 || filter.partySize>100)) {
    throw new TypeError('analytics party size is invalid')
  }
  if (filter.occasion!==null && ![
    'business','friends','date','birthday','music','relax','other',
  ].includes(filter.occasion)) throw new TypeError('analytics occasion is invalid')
  if (filter.packageProductId!==null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(filter.packageProductId)) throw new TypeError('analytics package product is invalid')
  if (![
    'all','paid','refunded','complaint','follow_on_order','repeat_purchase','margin_unavailable',
  ].includes(filter.recommendationOutcome)) throw new TypeError('analytics recommendation outcome is invalid')
}

function matchesRecommendationOutcome(
  row: RecommendationAnalyticsRow,
  outcome: RecommendationOutcomeCode,
): boolean {
  if (outcome==='all') return true
  if (outcome==='paid') return row.paid>0
  if (outcome==='refunded') return row.refunded>0
  if (outcome==='complaint') return row.complaintOrderCount>0
  if (outcome==='follow_on_order') return row.followOnPaidOrderCount>0
  if (outcome==='repeat_purchase') return row.repeatPurchaseOrderCount>0
  return row.paid>0 && row.frozenCostMinor===null
}

function count(value: string | number): number {
  const parsed = typeof value==='number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed<0) throw new Error('analytics count is invalid')
  return parsed
}

function money(value: string | number): number {
  const parsed = typeof value==='number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed<0) throw new Error('analytics amount is invalid')
  return parsed
}

function probability(value: string | number): number {
  const parsed = typeof value==='number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed<0 || parsed>1) throw new Error('analytics confidence is invalid')
  return Number(parsed.toFixed(4))
}

function ratio(numerator: number,denominator: number): number {
  return denominator===0 ? 0 : Number((numerator/denominator).toFixed(4))
}
