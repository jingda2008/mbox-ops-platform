import type { JsonObject } from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type ObservationInputKind = 'text' | 'voice_transcript'
export type ObservationExpressionKind = 'objective_fact' | 'customer_quote' | 'staff_judgement' | 'system_inference'
export type ObservationScopeKind = 'table' | 'seat' | 'customer' | 'product'
export type ObservationEventType = 'remaining' | 'consumed_little' | 'praise' | 'complaint' | 'too_sweet'
  | 'too_cold' | 'served_late' | 'presentation' | 'portion' | 'other'
export type ObservationDegree = 'little' | 'half' | 'most' | 'almost_untouched' | 'unknown'

export interface ObservationCandidateView {
  id: string
  mentionIndex: number
  rawMention: string
  orderItemId: string
  productId: string
  productName: string
  rank: number
  confidence: number
  matchKind: 'exact_name' | 'search_text' | 'order_context' | 'manual'
}

export interface ObservationDraftView {
  publicId: string
  status: 'draft'
  inputKind: ObservationInputKind
  rawContent: string
  parseConfidence: number
  needsImmediateAction: boolean
  serviceTaskId: string | null
  candidates: ObservationCandidateView[]
  clarificationRequired: boolean
  clarificationPrompt: string | null
}

export interface ObservationEventInput {
  expressionKind: ObservationExpressionKind
  scopeKind: ObservationScopeKind
  eventType: ObservationEventType
  degree: ObservationDegree | null
  reasonCode: string | null
  seatLabel: string | null
  customerId: string | null
  candidateId: string | null
  productId: string | null
  confidence: number
  rawExcerpt: string
  preferenceEvidence?: Readonly<{
    key: string
    value: string
    polarity: 'supports' | 'contradicts'
    weight: number
    validUntil: string | null
    allowedForRecommendation: boolean
  }> | null
}

export interface ObservationHistoryEventView {
  id: string
  eventGroupId: string
  revision: number
  expressionKind: ObservationExpressionKind
  scopeKind: ObservationScopeKind
  eventType: ObservationEventType
  degree: ObservationDegree | null
  reasonCode: string | null
  seatLabel: string | null
  customerId: string | null
  productId: string | null
  productName: string | null
  orderItemId: string | null
  selectedCandidateId: string | null
  confidence: number
  rawExcerpt: string | null
  needsImmediateAction: boolean
  serviceTaskId: string | null
  createdAt: string
}

export interface ObservationRevisionView {
  id: string
  reason: string
  correctedBy: string
  createdAt: string
  before: JsonObject
  after: JsonObject
}

export interface ObservationHistoryView {
  publicId: string
  inputKind: ObservationInputKind
  rawContent: string | null
  parseConfidence: number
  needsImmediateAction: boolean
  serviceTaskId: string | null
  serviceTaskStatus: string | null
  recordedBy: string
  confirmedBy: string
  confirmedAt: string
  events: ObservationHistoryEventView[]
  revisions: ObservationRevisionView[]
}

interface SessionContextRow extends Record<string, unknown> {
  table_id: string
  order_id: string | null
  schedule_id: string | null
}

interface OrderedProductRow extends Record<string, unknown> {
  order_item_id: string
  product_id: string
  product_name: string
  product_code: string
  search_text: string
}

interface CandidateRow extends Record<string, unknown> {
  id: string
  mention_index: number
  raw_mention: string
  order_item_id: string
  product_id: string
  product_name: string
  candidate_rank: number
  confidence: string | number
  match_kind: ObservationCandidateView['matchKind']
}

interface ObservationInputRow extends Record<string, unknown> {
  id: string
  public_id: string
  table_session_id: string
  raw_content: string
  input_kind: ObservationInputKind
  needs_immediate_action: boolean
  service_task_id: string | null
  parse_confidence: string | number
  status: 'draft' | 'confirmed' | 'rejected'
}

interface ObservationEventRow extends Record<string, unknown> {
  id: string
  event_group_id: string
  revision_no: number
  expression_kind: ObservationExpressionKind
  scope_kind: ObservationScopeKind
  event_type: ObservationEventType
  degree: ObservationDegree | null
  reason_code: string | null
  seat_label: string | null
  customer_id: string | null
  product_id: string | null
  order_item_id: string | null
  selected_candidate_id: string | null
  confidence: string | number
  raw_excerpt: string
  needs_immediate_action: boolean
  service_task_id: string | null
}

interface ObservationHistoryRow extends Record<string, unknown> {
  id: string
  public_id: string
  input_kind: ObservationInputKind
  raw_content: string | null
  parse_confidence: string | number
  needs_immediate_action: boolean
  service_task_id: string | null
  service_task_status: string | null
  recorded_by: string
  confirmed_by: string
  confirmed_at: string
}

interface ObservationHistoryEventRow extends Record<string, unknown> {
  observation_input_id: string
  id: string
  event_group_id: string
  revision_no: number
  expression_kind: ObservationExpressionKind
  scope_kind: ObservationScopeKind
  event_type: ObservationEventType
  degree: ObservationDegree | null
  reason_code: string | null
  seat_label: string | null
  customer_id: string | null
  product_id: string | null
  order_item_id: string | null
  selected_candidate_id: string | null
  confidence: string | number
  product_name: string | null
  raw_excerpt: string | null
  needs_immediate_action: boolean
  service_task_id: string | null
  created_at: string
}

interface ObservationRevisionRow extends Record<string, unknown> {
  id: string
  observation_input_id: string
  correction_reason: string | null
  corrected_by: string
  before_snapshot: JsonObject
  after_snapshot: JsonObject
  created_at: string
}

export class CustomerExperienceObservationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async recent(input: Readonly<{
    tableSessionId: string
    employeeId: string
    allowAllTables: boolean
    includeRaw: boolean
    limit: number
  }>): Promise<ObservationHistoryView[]> {
    await this.assertEmployeeTableAccess(input.tableSessionId, input.employeeId, input.allowAllTables)
    const observations = await this.transaction.query<ObservationHistoryRow>(`
      SELECT observation.id, observation.public_id, observation.input_kind,
        CASE WHEN $4::boolean THEN observation.raw_content ELSE NULL END AS raw_content,
        observation.parse_confidence, observation.needs_immediate_action,
        observation.service_task_id, task.status AS service_task_status,
        recorder.display_name AS recorded_by, confirmer.display_name AS confirmed_by,
        observation.confirmed_at::text
      FROM mbox.observation_inputs observation
      JOIN mbox.employees recorder
        ON recorder.tenant_id=observation.tenant_id AND recorder.store_id=observation.store_id
       AND recorder.id=observation.recorded_by_employee_id
      JOIN mbox.employees confirmer
        ON confirmer.tenant_id=observation.tenant_id AND confirmer.store_id=observation.store_id
       AND confirmer.id=observation.confirmed_by_employee_id
      LEFT JOIN mbox.service_tasks task
        ON task.tenant_id=observation.tenant_id AND task.store_id=observation.store_id
       AND task.id=observation.service_task_id
      WHERE observation.tenant_id=$1::uuid AND observation.store_id=$2::uuid
        AND observation.table_session_id=$3::uuid AND observation.status='confirmed'
      ORDER BY observation.confirmed_at DESC, observation.id DESC
      LIMIT $5
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableSessionId,
      input.includeRaw,
      input.limit,
    ])
    if (observations.rows.length === 0) return []
    const observationIds = observations.rows.map((row) => row.id)
    const events = await this.transaction.query<ObservationHistoryEventRow>(`
      SELECT DISTINCT ON (event.observation_input_id, event.event_group_id)
        event.observation_input_id, event.id, event.event_group_id, event.revision_no,
        event.expression_kind, event.scope_kind, event.event_type, event.degree,
        event.reason_code, event.seat_label, event.customer_id, event.product_id,
        event.order_item_id, event.selected_candidate_id, event.confidence,
        CASE WHEN $4::boolean THEN event.raw_excerpt ELSE NULL END AS raw_excerpt,
        event.needs_immediate_action, event.service_task_id,
        product.name AS product_name, event.created_at::text
      FROM mbox.observation_events event
      LEFT JOIN mbox.products product
        ON product.tenant_id=event.tenant_id AND product.store_id=event.store_id
       AND product.id=event.product_id
      WHERE event.tenant_id=$1::uuid AND event.store_id=$2::uuid
        AND event.observation_input_id=ANY($3::uuid[])
      ORDER BY event.observation_input_id, event.event_group_id,
        event.revision_no DESC, event.id DESC
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, observationIds, input.includeRaw])
    const revisions = await this.transaction.query<ObservationRevisionRow>(`
      SELECT revision.id, revision.observation_input_id,
        CASE WHEN $4::boolean THEN revision.correction_reason ELSE NULL END AS correction_reason,
        employee.display_name AS corrected_by,
        revision.before_snapshot, revision.after_snapshot, revision.created_at::text
      FROM mbox.observation_revisions revision
      JOIN mbox.employees employee
        ON employee.tenant_id=revision.tenant_id AND employee.store_id=revision.store_id
       AND employee.id=revision.corrected_by_employee_id
      WHERE revision.tenant_id=$1::uuid AND revision.store_id=$2::uuid
        AND revision.observation_input_id=ANY($3::uuid[])
      ORDER BY revision.created_at DESC, revision.id DESC
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, observationIds, input.includeRaw])
    return observations.rows.map((observation) => ({
      publicId: observation.public_id,
      inputKind: observation.input_kind,
      rawContent: observation.raw_content,
      parseConfidence: number(observation.parse_confidence),
      needsImmediateAction: observation.needs_immediate_action,
      serviceTaskId: observation.service_task_id,
      serviceTaskStatus: observation.service_task_status,
      recordedBy: observation.recorded_by,
      confirmedBy: observation.confirmed_by,
      confirmedAt: observation.confirmed_at,
      events: events.rows.filter((event) => event.observation_input_id === observation.id)
        .map(historyEventView),
      revisions: revisions.rows.filter((revision) => revision.observation_input_id === observation.id)
        .map((revision) => ({
          id: revision.id,
          reason: revision.correction_reason ?? '修订原因仅授权人员可见',
          correctedBy: revision.corrected_by,
          createdAt: revision.created_at,
          before: input.includeRaw ? revision.before_snapshot : withoutRaw(revision.before_snapshot),
          after: input.includeRaw ? revision.after_snapshot : withoutRaw(revision.after_snapshot),
        })),
    }))
  }

  async parse(input: Readonly<{
    publicId: string
    tableSessionId: string
    employeeId: string
    rawContent: string
    inputKind: ObservationInputKind
    needsImmediateAction: boolean
    allowAllTables: boolean
    idempotencyKey: string
  }>): Promise<ObservationDraftView> {
    const session = await this.loadSessionContext(input.tableSessionId)
    await this.assertEmployeeTableAccess(input.tableSessionId, input.employeeId, input.allowAllTables)
    const orderedProducts = await this.loadOrderedProducts(input.tableSessionId)
    const matches = matchOrderedProducts(input.rawContent, orderedProducts)
    const parseConfidence = matches[0]?.confidence ?? 0.4

    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.observation_inputs (
        tenant_id, store_id, public_id, table_session_id, order_id, schedule_id,
        recorded_by_employee_id, input_kind, raw_content, needs_immediate_action,
        service_task_id, parse_confidence
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid,
        $7::uuid, $8, $9, $10, $11::uuid, $12::numeric
      ) RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.tableSessionId,
      session.order_id,
      session.schedule_id,
      input.employeeId,
      input.inputKind,
      input.rawContent,
      input.needsImmediateAction,
      null,
      parseConfidence,
    ])
    const observationId = required(inserted.rows[0], 'observation input').id
    await this.transaction.query(`
      INSERT INTO mbox.observation_parse_runs (
        tenant_id, store_id, observation_input_id, parser_kind, parser_version,
        overall_confidence, raw_result_snapshot
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'deterministic', 'ordered-products-v1', $4::numeric, $5::jsonb)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      observationId,
      parseConfidence,
      JSON.stringify({ candidateCount: matches.length, evidenceBoundary: 'current_table_real_orders_only' }),
    ])
    for (const match of matches) {
      await this.transaction.query(`
        INSERT INTO mbox.observation_match_candidates (
          tenant_id, store_id, observation_input_id, mention_index, raw_mention,
          order_item_id, product_id, candidate_rank, confidence, match_kind
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, 0, $4, $5::uuid, $6::uuid, $7, $8::numeric, $9)
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        observationId,
        match.rawMention,
        match.orderItemId,
        match.productId,
        match.rank,
        match.confidence,
        match.matchKind,
      ])
    }
    const candidates = await this.listCandidates(observationId)
    return draftView({
      id: observationId,
      public_id: input.publicId,
      table_session_id: input.tableSessionId,
      raw_content: input.rawContent,
      input_kind: input.inputKind,
      needs_immediate_action: input.needsImmediateAction,
      service_task_id: null,
      parse_confidence: parseConfidence,
      status: 'draft',
    }, candidates)
  }

  async confirm(input: Readonly<{
    publicId: string
    employeeId: string
    allowAllTables: boolean
    events: readonly ObservationEventInput[]
  }>): Promise<{ publicId: string; status: 'confirmed'; events: JsonObject[]; serviceTaskId: string | null }> {
    const observation = await this.lockDraft(input.publicId)
    await this.assertEmployeeTableAccess(observation.table_session_id, input.employeeId, input.allowAllTables)
    const candidates = await this.listCandidates(observation.id)
    const events = input.events.length > 0 ? input.events : [defaultEvent(observation, candidates)]
    const resolvedEvents: Array<{
      event: ObservationEventInput
      references: { candidateId: string | null; productId: string | null; orderItemId: string | null }
    }> = []
    for (const event of events) {
      resolvedEvents.push({
        event,
        references: await this.resolveEventReferences(observation, candidates, event),
      })
    }
    let serviceTaskId: string | null = null
    if (observation.needs_immediate_action) {
      const session = await this.loadSessionContext(observation.table_session_id)
      const task = await new ServiceTaskRepository(this.transaction).create({
        tableId: session.table_id,
        tableSessionId: observation.table_session_id,
        publicId: `observation-task-${observation.id}`,
        taskType: 'customer_experience.attention',
        title: '桌台体验情况需处理',
        detail: null,
        priority: 'high',
        source: 'employee',
        requestedRoleCode: 'SERVER',
        createdByEmployeeId: input.employeeId,
        actor: { type: 'employee', employeeId: input.employeeId },
        eventIdempotencyKey: `observation-confirmed:${observation.id}`,
        requestSnapshot: {
          source: 'confirmed_observation',
          observationPublicId: observation.public_id,
          eventCount: events.length,
          eventTypes: [...new Set(events.map((event) => event.eventType))],
          scopeKinds: [...new Set(events.map((event) => event.scopeKind))],
        },
      })
      serviceTaskId = task.id
    }
    const created: JsonObject[] = []
    for (const { event, references: resolved } of resolvedEvents) {
      const result = await this.transaction.query<ObservationEventRow>(`
        INSERT INTO mbox.observation_events (
          tenant_id, store_id, observation_input_id, expression_kind, scope_kind,
          event_type, degree, reason_code, seat_label, customer_id, product_id,
          order_item_id, selected_candidate_id, confidence, raw_excerpt,
          needs_immediate_action, service_task_id, confirmation_state,
          confirmed_by_employee_id
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9,
          $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14::numeric, $15,
          $16, $17::uuid, 'confirmed', $18::uuid
        ) RETURNING id, event_group_id, revision_no, expression_kind, scope_kind,
          event_type, degree, reason_code, seat_label, customer_id, product_id,
          order_item_id, selected_candidate_id, confidence, raw_excerpt,
          needs_immediate_action, service_task_id
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        observation.id,
        event.expressionKind,
        event.scopeKind,
        event.eventType,
        event.degree,
        event.reasonCode,
        event.seatLabel,
        event.customerId,
        resolved.productId,
        resolved.orderItemId,
        resolved.candidateId,
        event.confidence,
        event.rawExcerpt,
        observation.needs_immediate_action,
        serviceTaskId,
        input.employeeId,
      ])
      const row = required(result.rows[0], 'observation event')
      if (event.preferenceEvidence) await this.insertPreferenceEvidence(row.id, event, input.employeeId)
      created.push(eventView(row))
    }
    await this.transaction.query(`
      UPDATE mbox.observation_inputs
      SET status='confirmed', confirmed_by_employee_id=$4::uuid,
        confirmed_at=clock_timestamp(), service_task_id=$5::uuid
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='draft'
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      observation.id,
      input.employeeId,
      serviceTaskId,
    ])
    return { publicId: observation.public_id, status: 'confirmed', events: created, serviceTaskId }
  }

  async revise(input: Readonly<{
    publicId: string
    previousEventId: string
    employeeId: string
    allowAllTables: boolean
    reason: string
    replacement: ObservationEventInput
  }>): Promise<JsonObject> {
    const observation = await this.loadConfirmed(input.publicId)
    await this.assertEmployeeTableAccess(observation.table_session_id, input.employeeId, input.allowAllTables)
    const previousResult = await this.transaction.query<ObservationEventRow>(`
      SELECT id, event_group_id, revision_no, expression_kind, scope_kind,
        event_type, degree, reason_code, seat_label, customer_id, product_id,
        order_item_id, selected_candidate_id, confidence, raw_excerpt,
        needs_immediate_action, service_task_id
      FROM mbox.observation_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND observation_input_id=$4::uuid
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.previousEventId, observation.id])
    const previous = required(previousResult.rows[0], 'previous observation event')
    const latest = await this.transaction.query<{ revision_no: number }>(`
      SELECT revision_no FROM mbox.observation_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND event_group_id=$3::uuid
      ORDER BY revision_no DESC LIMIT 1 FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, previous.event_group_id])
    if (latest.rows[0]?.revision_no !== previous.revision_no) {
      throw new CustomerExperienceRequestError('这条记录已有更新版本，请刷新后再修正', 'OBSERVATION_REVISION_CONFLICT', 409)
    }
    const candidates = await this.listCandidates(observation.id)
    const resolved = await this.resolveEventReferences(observation, candidates, input.replacement)
    const replacementResult = await this.transaction.query<ObservationEventRow>(`
      INSERT INTO mbox.observation_events (
        tenant_id, store_id, observation_input_id, event_group_id, revision_no,
        expression_kind, scope_kind, event_type, degree, reason_code, seat_label,
        customer_id, product_id, order_item_id, selected_candidate_id, confidence,
        raw_excerpt, needs_immediate_action, service_task_id, confirmation_state,
        confirmed_by_employee_id
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10,
        $11, $12::uuid, $13::uuid, $14::uuid, $15::uuid, $16::numeric, $17,
        $18, $19::uuid, 'corrected', $20::uuid
      ) RETURNING id, event_group_id, revision_no, expression_kind, scope_kind,
        event_type, degree, reason_code, seat_label, customer_id, product_id,
        order_item_id, selected_candidate_id, confidence, raw_excerpt,
        needs_immediate_action, service_task_id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      observation.id,
      previous.event_group_id,
      previous.revision_no + 1,
      input.replacement.expressionKind,
      input.replacement.scopeKind,
      input.replacement.eventType,
      input.replacement.degree,
      input.replacement.reasonCode,
      input.replacement.seatLabel,
      input.replacement.customerId,
      resolved.productId,
      resolved.orderItemId,
      resolved.candidateId,
      input.replacement.confidence,
      input.replacement.rawExcerpt,
      observation.needs_immediate_action,
      observation.service_task_id,
      input.employeeId,
    ])
    const replacement = required(replacementResult.rows[0], 'replacement observation event')
    if (input.replacement.preferenceEvidence) {
      await this.insertPreferenceEvidence(replacement.id, input.replacement, input.employeeId)
    }
    await this.transaction.query(`
      INSERT INTO mbox.observation_revisions (
        tenant_id, store_id, observation_input_id, previous_event_id,
        replacement_event_id, corrected_by_employee_id, correction_reason,
        before_snapshot, after_snapshot
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8::jsonb, $9::jsonb)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      observation.id,
      previous.id,
      replacement.id,
      input.employeeId,
      input.reason,
      JSON.stringify(eventView(previous)),
      JSON.stringify(eventView(replacement)),
    ])
    return eventView(replacement)
  }

  private async loadSessionContext(tableSessionId: string): Promise<SessionContextRow> {
    const result = await this.transaction.query<SessionContextRow>(`
      SELECT session.table_id,
        (SELECT orders.id FROM mbox.orders
          WHERE orders.tenant_id=session.tenant_id AND orders.store_id=session.store_id
            AND orders.table_session_id=session.id AND orders.status<>'cancelled'
          ORDER BY orders.created_at DESC, orders.id DESC LIMIT 1) AS order_id,
        (SELECT schedule.id FROM mbox.schedules schedule
          WHERE schedule.tenant_id=session.tenant_id AND schedule.store_id=session.store_id
            AND schedule.status IN ('scheduled','performing')
            AND schedule.starts_at <= clock_timestamp()
            AND schedule.ends_at > clock_timestamp()
          ORDER BY schedule.starts_at, schedule.id LIMIT 1) AS schedule_id
      FROM mbox.table_sessions session
      WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
        AND session.id=$3::uuid AND session.status IN ('open','closing')
      FOR KEY SHARE OF session
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId])
    const row = result.rows[0]
    if (!row) throw new CustomerExperienceRequestError('桌次已结束，不能继续记录', 'OBSERVATION_TABLE_SESSION_INACTIVE', 409)
    return row
  }

  private async loadOrderedProducts(tableSessionId: string): Promise<OrderedProductRow[]> {
    const result = await this.transaction.query<OrderedProductRow>(`
      SELECT item.id AS order_item_id, product.id AS product_id,
        product.name AS product_name, product.code AS product_code,
        product.search_text
      FROM mbox.orders orders
      JOIN mbox.order_items item
        ON item.tenant_id=orders.tenant_id AND item.store_id=orders.store_id
       AND item.order_id=orders.id AND item.status<>'cancelled'
      JOIN mbox.products product
        ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id
       AND product.id=item.product_id
      WHERE orders.tenant_id=$1::uuid AND orders.store_id=$2::uuid
        AND orders.table_session_id=$3::uuid AND orders.status<>'cancelled'
      ORDER BY item.created_at DESC, item.id
      LIMIT 100
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId])
    return result.rows
  }

  private async assertEmployeeTableAccess(
    tableSessionId: string,
    employeeId: string,
    allowAllTables: boolean,
  ): Promise<void> {
    if (allowAllTables) return
    const result = await this.transaction.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM mbox.table_sessions session
        JOIN mbox.table_assignments assignment
          ON assignment.tenant_id=session.tenant_id
         AND assignment.store_id=session.store_id
         AND assignment.table_id=session.table_id
         AND assignment.employee_id=$4::uuid
         AND assignment.assignment_type IN ('primary','backup','temporary')
         AND assignment.starts_at <= clock_timestamp()
         AND (assignment.ends_at IS NULL OR assignment.ends_at > clock_timestamp())
        WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
          AND session.id=$3::uuid AND session.status IN ('open','closing')
      ) AS allowed
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId, employeeId])
    if (result.rows[0]?.allowed !== true) {
      throw new CustomerExperienceRequestError(
        '只能记录当前主责、候补或临时分配桌台；全店记录需要单独授权',
        'OBSERVATION_TABLE_SCOPE_DENIED',
        403,
      )
    }
  }

  private async listCandidates(observationId: string): Promise<ObservationCandidateView[]> {
    const result = await this.transaction.query<CandidateRow>(`
      SELECT candidate.id, candidate.mention_index, candidate.raw_mention,
        candidate.order_item_id, candidate.product_id, product.name AS product_name,
        candidate.candidate_rank, candidate.confidence, candidate.match_kind
      FROM mbox.observation_match_candidates candidate
      JOIN mbox.products product
        ON product.tenant_id=candidate.tenant_id AND product.store_id=candidate.store_id
       AND product.id=candidate.product_id
      WHERE candidate.tenant_id=$1::uuid AND candidate.store_id=$2::uuid
        AND candidate.observation_input_id=$3::uuid
      ORDER BY candidate.mention_index, candidate.candidate_rank, candidate.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, observationId])
    return result.rows.map(candidateView)
  }

  private async lockDraft(publicId: string): Promise<ObservationInputRow> {
    const result = await this.transaction.query<ObservationInputRow>(`
      SELECT id, public_id, table_session_id, raw_content, input_kind,
        needs_immediate_action, service_task_id, parse_confidence, status
      FROM mbox.observation_inputs
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    const row = result.rows[0]
    if (!row || row.status !== 'draft') {
      throw new CustomerExperienceRequestError('观察记录已经确认或不存在', 'OBSERVATION_NOT_DRAFT', 409)
    }
    return row
  }

  private async loadConfirmed(publicId: string): Promise<ObservationInputRow> {
    const result = await this.transaction.query<ObservationInputRow>(`
      SELECT id, public_id, table_session_id, raw_content, input_kind,
        needs_immediate_action, service_task_id, parse_confidence, status
      FROM mbox.observation_inputs
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3 AND status='confirmed'
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    const row = result.rows[0]
    if (!row) throw new CustomerExperienceRequestError('已确认观察记录不存在', 'OBSERVATION_NOT_CONFIRMED', 404)
    return row
  }

  private async resolveEventReferences(
    observation: ObservationInputRow,
    candidates: readonly ObservationCandidateView[],
    event: ObservationEventInput,
  ): Promise<{ candidateId: string | null; productId: string | null; orderItemId: string | null }> {
    const candidate = event.candidateId === null ? null : candidates.find((entry) => entry.id === event.candidateId)
    if (event.candidateId !== null && !candidate) {
      throw new CustomerExperienceRequestError('所选商品候选不属于这条观察', 'OBSERVATION_CANDIDATE_INVALID', 409)
    }
    let productId = candidate?.productId ?? event.productId
    let orderItemId = candidate?.orderItemId ?? null
    if (productId !== null && candidate === null) {
      const actual = await this.transaction.query<{ order_item_id: string }>(`
        SELECT item.id AS order_item_id
        FROM mbox.orders orders
        JOIN mbox.order_items item
          ON item.tenant_id=orders.tenant_id AND item.store_id=orders.store_id
         AND item.order_id=orders.id AND item.status<>'cancelled'
        WHERE orders.tenant_id=$1::uuid AND orders.store_id=$2::uuid
          AND orders.table_session_id=$3::uuid AND orders.status<>'cancelled'
          AND item.product_id=$4::uuid
        ORDER BY item.created_at DESC, item.id LIMIT 1
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, observation.table_session_id, productId])
      const row = actual.rows[0]
      if (!row) throw new CustomerExperienceRequestError('只能关联这桌真实点过的商品', 'OBSERVATION_PRODUCT_NOT_ORDERED', 409)
      orderItemId = row.order_item_id
    }
    if (event.scopeKind === 'customer' && event.customerId === null) {
      throw new CustomerExperienceRequestError('客户级观察必须先明确本桌客户身份', 'OBSERVATION_CUSTOMER_REQUIRED', 409)
    }
    if (event.scopeKind === 'customer' && event.customerId !== null) {
      const membership = await this.transaction.query(`
        SELECT id FROM mbox.table_session_customer_participations
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND table_session_id=$3::uuid AND customer_id=$4::uuid
          AND confirmation_state IN ('confirmed','corrected')
        ORDER BY joined_at DESC LIMIT 1
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, observation.table_session_id, event.customerId])
      if (membership.rowCount !== 1) {
        throw new CustomerExperienceRequestError('缺少明确的客户与桌次关系，不能写入个人证据', 'OBSERVATION_CUSTOMER_SCOPE_UNPROVEN', 409)
      }
    }
    if (event.scopeKind === 'product' && productId === null) {
      throw new CustomerExperienceRequestError('商品级观察必须确认真实商品', 'OBSERVATION_PRODUCT_REQUIRED', 409)
    }
    if (event.scopeKind === 'seat' && (event.seatLabel === null || event.seatLabel.trim() === '')) {
      throw new CustomerExperienceRequestError('座位级观察必须明确座位', 'OBSERVATION_SEAT_REQUIRED', 409)
    }
    return { candidateId: candidate?.id ?? null, productId, orderItemId }
  }

  private async insertPreferenceEvidence(
    eventId: string,
    event: ObservationEventInput,
    employeeId: string,
  ): Promise<void> {
    const evidence = event.preferenceEvidence
    if (!evidence || event.scopeKind !== 'customer' || event.customerId === null) {
      throw new CustomerExperienceRequestError('只有明确客户级证据可以进入偏好候选', 'PREFERENCE_EVIDENCE_SCOPE_INVALID', 409)
    }
    if (!['customer_quote', 'objective_fact'].includes(event.expressionKind)) {
      throw new CustomerExperienceRequestError('员工判断和系统推断不能直接形成个人偏好', 'PREFERENCE_EVIDENCE_SOURCE_INVALID', 409)
    }
    await this.transaction.query(`
      INSERT INTO mbox.preference_evidence (
        tenant_id, store_id, customer_id, observation_event_id,
        preference_key, preference_value, polarity, evidence_weight,
        confidence, valid_until, allowed_for_recommendation
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::numeric, $10::timestamptz, $11)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      event.customerId,
      eventId,
      evidence.key,
      evidence.value,
      evidence.polarity,
      evidence.weight,
      event.confidence,
      evidence.validUntil,
      evidence.allowedForRecommendation,
    ])
    void employeeId
  }
}

function matchOrderedProducts(rawContent: string, products: readonly OrderedProductRow[]): Array<{
  rawMention: string
  orderItemId: string
  productId: string
  rank: number
  confidence: number
  matchKind: ObservationCandidateView['matchKind']
}> {
  const normalized = normalize(rawContent)
  const matches: Array<{
    product: OrderedProductRow
    rawMention: string
    confidence: number
    matchKind: ObservationCandidateView['matchKind']
  }> = []
  for (const product of products) {
    const name = normalize(product.product_name)
    const code = normalize(product.product_code)
    if (name.length > 0 && normalized.includes(name)) {
      matches.push({ product, rawMention: product.product_name, confidence: 0.98, matchKind: 'exact_name' })
      continue
    }
    const terms = product.search_text.split(/\s+/u).map(normalize)
      .filter((term) => term.length >= 2)
      .toSorted((left, right) => right.length - left.length)
    const term = terms.find((candidate) => normalized.includes(candidate))
    if (term) {
      matches.push({ product, rawMention: term, confidence: 0.78, matchKind: 'search_text' })
      continue
    }
    if (code.length >= 2 && normalized.includes(code)) {
      matches.push({ product, rawMention: product.product_code, confidence: 0.75, matchKind: 'search_text' })
    }
  }
  matches.sort((left, right) => right.confidence - left.confidence
    || left.product.product_name.localeCompare(right.product.product_name))
  const candidates = matches.length > 0 ? matches : products.length === 1
    ? [{ product: products[0]!, rawMention: rawContent.slice(0, 200), confidence: 0.55, matchKind: 'order_context' as const }]
    : []
  return candidates.slice(0, 3).map((match, index) => ({
    rawMention: match.rawMention,
    orderItemId: match.product.order_item_id,
    productId: match.product.product_id,
    rank: index + 1,
    confidence: match.confidence,
    matchKind: match.matchKind,
  }))
}

function defaultEvent(observation: ObservationInputRow, candidates: readonly ObservationCandidateView[]): ObservationEventInput {
  const candidate = candidates[0] && candidates[0].confidence >= 0.6 ? candidates[0] : null
  return {
    expressionKind: 'staff_judgement',
    scopeKind: candidate ? 'product' : 'table',
    eventType: 'other',
    degree: 'unknown',
    reasonCode: null,
    seatLabel: null,
    customerId: null,
    candidateId: candidate?.id ?? null,
    productId: null,
    confidence: candidate?.confidence ?? number(observation.parse_confidence),
    rawExcerpt: observation.raw_content.slice(0, 1000),
  }
}

function draftView(row: ObservationInputRow, candidates: ObservationCandidateView[]): ObservationDraftView {
  const confidence = number(row.parse_confidence)
  return {
    publicId: row.public_id,
    status: 'draft',
    inputKind: row.input_kind,
    rawContent: row.raw_content,
    parseConfidence: confidence,
    needsImmediateAction: row.needs_immediate_action,
    serviceTaskId: row.service_task_id,
    candidates,
    clarificationRequired: confidence < 0.6,
    clarificationPrompt: confidence < 0.6 ? '这条记录暂时无法确认具体商品，请选择该桌真实订单中的商品，或按桌台情况保存。' : null,
  }
}

function candidateView(row: CandidateRow): ObservationCandidateView {
  return {
    id: row.id,
    mentionIndex: row.mention_index,
    rawMention: row.raw_mention,
    orderItemId: row.order_item_id,
    productId: row.product_id,
    productName: row.product_name,
    rank: row.candidate_rank,
    confidence: number(row.confidence),
    matchKind: row.match_kind,
  }
}

function eventView(row: ObservationEventRow): JsonObject {
  return {
    id: row.id,
    eventGroupId: row.event_group_id,
    revision: row.revision_no,
    expressionKind: row.expression_kind,
    scopeKind: row.scope_kind,
    eventType: row.event_type,
    degree: row.degree,
    reasonCode: row.reason_code,
    seatLabel: row.seat_label,
    customerId: row.customer_id,
    productId: row.product_id,
    orderItemId: row.order_item_id,
    selectedCandidateId: row.selected_candidate_id,
    confidence: number(row.confidence),
    rawExcerpt: row.raw_excerpt,
    needsImmediateAction: row.needs_immediate_action,
    serviceTaskId: row.service_task_id,
  }
}

function historyEventView(row: ObservationHistoryEventRow): ObservationHistoryEventView {
  return {
    id: row.id,
    eventGroupId: row.event_group_id,
    revision: row.revision_no,
    expressionKind: row.expression_kind,
    scopeKind: row.scope_kind,
    eventType: row.event_type,
    degree: row.degree,
    reasonCode: row.reason_code,
    seatLabel: row.seat_label,
    customerId: row.customer_id,
    productId: row.product_id,
    productName: row.product_name,
    orderItemId: row.order_item_id,
    selectedCandidateId: row.selected_candidate_id,
    confidence: number(row.confidence),
    rawExcerpt: row.raw_excerpt,
    needsImmediateAction: row.needs_immediate_action,
    serviceTaskId: row.service_task_id,
    createdAt: row.created_at,
  }
}

function withoutRaw(snapshot: JsonObject): JsonObject {
  const { rawExcerpt: _rawExcerpt, ...redacted } = snapshot
  return redacted
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '')
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new TypeError('observation confidence is invalid')
  return parsed
}

function required<Row>(row: Row | undefined, label: string): Row {
  if (!row) throw new Error(`${label} did not return a row`)
  return row
}
