import { createHash, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import type { JsonObject } from './command-executor.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
  StaffNotFoundError,
} from './staff-access-repository.js'
import {
  CapacityOverrideReasonRequiredError,
  TableManagementCommandService,
  TableManagementConflictError,
  TableManagementNotFoundError,
  TableManagementRepository,
  TABLE_ASSIGNMENT_MANAGE_PERMISSION,
  TABLE_PARTICIPATION_MANAGE_PERMISSION,
  type AreaStatus,
  type ManagedArea,
  type ManagedTable,
  type TableStatus,
} from './table-management-repository.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  OutboxMessageConflictError,
} from './command-executor.js'

type TransactionRunnerPort = Pick<ScopedPostgresTransactionRunner, 'run'>
type TableManagementCommandPort = Pick<TableManagementCommandService,
  'createArea' | 'updateArea' | 'createTable' | 'updateTable' | 'assign' |
  'assignMany' | 'endAssignment' | 'open' | 'transfer' | 'moveParticipants'>

export interface TableManagementApiOptions {
  transactions: TransactionRunnerPort
  commands: TableManagementCommandPort
  resolveContext(request: FastifyRequest): Promise<NormalizedOperationsRequestContext> | NormalizedOperationsRequestContext
}

interface ApiErrorBody {
  error: { code: string; message: string }
}

class TableManagementRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableManagementRequestError'
  }
}

export const tableManagementApiPlugin: FastifyPluginAsync<TableManagementApiOptions> = async (app, options) => {
  app.get('/table-management/areas', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const access = await new StaffAccessRepository(transaction).resolve(context.employeeId)
      return new TableManagementRepository(transaction).listAreas(access)
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.get('/table-management/tables', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const access = await new StaffAccessRepository(transaction).resolve(context.employeeId)
      return new TableManagementRepository(transaction).listTables(access)
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.get('/table-management/assignments', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const access = await new StaffAccessRepository(transaction).resolve(context.employeeId)
      return new TableManagementRepository(transaction).listAssignments(access)
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.get('/table-management/assignment-options', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      await new StaffAccessRepository(transaction).assertPermission(
        context.employeeId,
        TABLE_ASSIGNMENT_MANAGE_PERMISSION,
      )
      return new TableManagementRepository(transaction).listAssignmentOptions()
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.post('/table-management/areas', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const input = readArea(body, true)
    const execution = await options.commands.createArea(commandBase(request, context, body, '配置新区域', {
      ...input,
      code: requiredString(body.code, 'code', 32),
    }))
    return reply.code(201).send(commandResponse(execution))
  }))

  app.patch('/table-management/areas/:areaId', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const input = readArea(body, false)
    const execution = await options.commands.updateArea(commandBase(request, context, body, '调整区域配置', {
      ...input,
      areaId: readUuid(readParams(request).areaId, 'areaId'),
    }))
    return reply.send(commandResponse(execution))
  }))

  app.post('/table-management/tables', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const input = readTable(body, true)
    const execution = await options.commands.createTable(commandBase(request, context, body, '配置新桌台', {
      ...input,
      areaId: readUuid(body.areaId, 'areaId'),
      code: requiredString(body.code, 'code', 32),
    }))
    return reply.code(201).send(commandResponse(execution))
  }))

  app.patch('/table-management/tables/:tableId', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const input = readTable(body, false)
    const execution = await options.commands.updateTable(commandBase(request, context, body, '调整桌台配置', {
      ...input,
      tableId: readUuid(readParams(request).tableId, 'tableId'),
      areaId: readUuid(body.areaId, 'areaId'),
      code: requiredString(body.code, 'code', 32),
    }))
    return reply.send(commandResponse(execution))
  }))

  app.post('/table-management/assignments', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const execution = await options.commands.assign(commandBase(request, context, body, '分配桌台责任', {
      tableId: readUuid(body.tableId, 'tableId'),
      employeeId: readUuid(body.employeeId, 'employeeId'),
      roleId: readUuid(body.roleId, 'roleId'),
      assignmentType: readEnum(body.assignmentType, 'assignmentType', ['primary', 'backup', 'temporary']),
      startsAt: readTimestamp(body.startsAt, 'startsAt'),
      endsAt: optionalTimestamp(body.endsAt, 'endsAt'),
    }))
    return reply.code(201).send(commandResponse(execution))
  }))

  app.post('/table-management/assignments/batch', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const execution = await options.commands.assignMany(commandBase(request, context, body, '批量分配桌台责任', {
      tableIds: readUuidArray(body.tableIds, 'tableIds', 80),
      employeeId: readUuid(body.employeeId, 'employeeId'),
      roleId: readUuid(body.roleId, 'roleId'),
      assignmentType: readEnum(body.assignmentType, 'assignmentType', ['primary', 'backup', 'temporary']),
      startsAt: readTimestamp(body.startsAt, 'startsAt'),
      endsAt: optionalTimestamp(body.endsAt, 'endsAt'),
    }))
    return reply.code(201).send(commandResponse(execution))
  }))

  app.post('/table-management/assignments/:assignmentId/end', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const execution = await options.commands.endAssignment(commandBase(request, context, body, '结束桌台责任', {
      assignmentId: readUuid(readParams(request).assignmentId, 'assignmentId'),
      endsAt: readTimestamp(body.endsAt, 'endsAt'),
    }))
    return reply.send(commandResponse(execution))
  }))

  app.post('/table-management/sessions/open', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const execution = await options.commands.open(commandBase(request, context, body, '现场开台', {
      tableId: readUuid(body.tableId, 'tableId'),
      publicId: optionalString(body.publicId, 'publicId', 128) ?? `table-session-${randomUUID()}`,
      guestCount: readInteger(body.guestCount, 'guestCount', 1, 200),
      capacityOverrideReason: optionalString(body.capacityOverrideReason, 'capacityOverrideReason', 1000),
      guestProfileSnapshot: readOpenTableGuestProfileSnapshot(body),
    }))
    return reply.code(201).send(commandResponse(execution))
  }))

  app.post('/table-management/sessions/:tableSessionId/transfer', async (request, reply) => handle(reply, async () => {
    const context = await authorizedContext(options, request)
    const body = readObject(request.body)
    const execution = await options.commands.transfer(commandBase(request, context, body, '现场转桌', {
      tableSessionId: readUuid(readParams(request).tableSessionId, 'tableSessionId'),
      targetTableId: readUuid(body.targetTableId, 'targetTableId'),
      capacityOverrideReason: optionalString(body.capacityOverrideReason, 'capacityOverrideReason', 1000),
    }))
    return reply.send(commandResponse(execution))
  }))

  app.get('/table-management/sessions/:tableSessionId/participants', async (request, reply) => handle(reply, async () => {
    const context=await authorizedContext(options,request)
    const tableSessionId=readUuid(readParams(request).tableSessionId,'tableSessionId')
    const data=await options.transactions.run(context.scope,async (transaction) => {
      await new StaffAccessRepository(transaction).assertPermission(
        context.employeeId,TABLE_PARTICIPATION_MANAGE_PERMISSION,
      )
      return new TableManagementRepository(transaction).listParticipants(tableSessionId)
    },{ readOnly:true })
    return reply.send({ data,meta:{ count:data.length } })
  }))

  app.post('/table-management/sessions/:tableSessionId/participant-movements/preview', async (request, reply) => handle(reply, async () => {
    const context=await authorizedContext(options,request)
    const body=readObject(request.body)
    const tableSessionId=readUuid(readParams(request).tableSessionId,'tableSessionId')
    const participantPublicIds=readPublicIdArray(body.participantPublicIds,'participantPublicIds',200,true)
    const movementKind=readEnum(body.movementKind,'movementKind',['participant_split','participant_merge'] as const)
    const movedGuestCount=readInteger(body.movedGuestCount,'movedGuestCount',1,200)
    const targetTableId=readUuid(body.targetTableId,'targetTableId')
    const targetTableSessionId=body.targetTableSessionId===null || body.targetTableSessionId===undefined
      ? null : readUuid(body.targetTableSessionId,'targetTableSessionId')
    const capacityOverrideReason=optionalString(body.capacityOverrideReason,'capacityOverrideReason',1000)
    const targetState=await options.transactions.run(context.scope,async (transaction) => {
      await new StaffAccessRepository(transaction).assertPermission(
        context.employeeId,TABLE_PARTICIPATION_MANAGE_PERMISSION,
      )
      const active=await new TableManagementRepository(transaction).listParticipants(tableSessionId)
      if (participantPublicIds.some((id) => !active.some((item) => item.publicId===id))) {
        throw new TableManagementConflictError('所选顾客位置已变化，请刷新后重新选择')
      }
      const result=await transaction.query<{ capacity:number; target_guest_count:number; target_session_id:string|null; source_guest_count:number; source_table_id:string; target_has_organizer:boolean }>(`
        SELECT CASE WHEN $5::text='participant_merge' THEN target_session.capacity_at_open
            ELSE venue_table.capacity END AS capacity,
          source_session.guest_count AS source_guest_count,
          source_session.table_id AS source_table_id,
          COALESCE(target_session.guest_count,0)::integer AS target_guest_count,
          target_session.id AS target_session_id,
          EXISTS (
            SELECT 1 FROM mbox.table_session_customer_participations target_participation
            WHERE target_participation.tenant_id=venue_table.tenant_id
              AND target_participation.store_id=venue_table.store_id
              AND target_participation.table_session_id=target_session.id
              AND target_participation.table_id=venue_table.id
              AND target_participation.left_at IS NULL
              AND target_participation.participation_role='organizer'
          ) AS target_has_organizer
        FROM mbox.tables venue_table
        JOIN mbox.areas target_area ON target_area.tenant_id=venue_table.tenant_id
          AND target_area.store_id=venue_table.store_id AND target_area.id=venue_table.area_id
          AND target_area.status='active'
        JOIN mbox.table_sessions source_session
          ON source_session.tenant_id=venue_table.tenant_id AND source_session.store_id=venue_table.store_id
         AND source_session.id=$4::uuid AND source_session.status='open'
        LEFT JOIN mbox.table_sessions target_session
          ON target_session.tenant_id=venue_table.tenant_id AND target_session.store_id=venue_table.store_id
         AND target_session.table_id=venue_table.id AND target_session.status='open'
        WHERE venue_table.tenant_id=$1::uuid AND venue_table.store_id=$2::uuid
          AND venue_table.id=$3::uuid AND venue_table.status='available'
      `,[context.scope.tenantId,context.scope.storeId,targetTableId,tableSessionId,movementKind])
      const row=result.rows[0]
      if (!row) throw new TableManagementConflictError('目标桌台当前不可用')
      if (row.source_table_id===targetTableId) throw new TableManagementRequestError('目标桌不能与源桌相同')
      if (movementKind==='participant_split' && targetTableSessionId!==null) {
        throw new TableManagementRequestError('人员拆桌必须选择空闲目标桌')
      }
      if (movementKind==='participant_split' && row.target_session_id!==null) {
        throw new TableManagementConflictError('拆桌目标已被占用，请刷新后重新选择')
      }
      if (movementKind==='participant_merge' && row.target_session_id!==targetTableSessionId) {
        throw new TableManagementConflictError('并桌目标桌次已变化，请刷新后重试')
      }
      const closesSource=movementKind==='participant_merge' && movedGuestCount===row.source_guest_count
      const blockerResult=await transaction.query<{
        order_item_unresolved:string;kds_active:string;payment_pending:string
        refund_pending:string;service_active:string;inventory_reserved:string
        order_unsettled:string;pricing_reserved:string;song_active:string
        benefit_reserved:string;experience_active:string;redemption_pending:string
        checkout_offer_active:string
      }>(`WITH selected_customers AS (
        SELECT DISTINCT mbox.canonical_customer_id(
          participation.tenant_id,participation.store_id,participation.customer_id
        ) AS customer_id
        FROM mbox.table_session_customer_participations participation
        WHERE participation.tenant_id=$1::uuid AND participation.store_id=$2::uuid
          AND participation.table_session_id=$3::uuid
          AND participation.public_id=ANY($4::text[]) AND participation.left_at IS NULL
      ), scoped_orders AS (
        SELECT order_row.id,order_row.status,order_row.payment_status
        FROM mbox.orders order_row
        WHERE order_row.tenant_id=$1::uuid AND order_row.store_id=$2::uuid
          AND order_row.table_session_id=$3::uuid
          AND ($5::boolean OR order_row.created_by_customer_id IS NULL OR
            mbox.canonical_customer_id(
              order_row.tenant_id,order_row.store_id,order_row.created_by_customer_id
            )=ANY(SELECT customer_id FROM selected_customers))
      ) SELECT
        (SELECT count(*)::text FROM scoped_orders order_row
          WHERE NOT ((order_row.status<>'cancelled'
              AND order_row.payment_status IN ('paid','partially_refunded','refunded'))
            OR (order_row.status='cancelled' AND order_row.payment_status='refunded')
            OR (order_row.status='cancelled' AND order_row.payment_status='unpaid'
              AND NOT EXISTS (
                SELECT 1 FROM mbox.order_items delivered_item
                WHERE delivered_item.tenant_id=$1::uuid AND delivered_item.store_id=$2::uuid
                  AND delivered_item.order_id=order_row.id AND delivered_item.status='delivered'
              ))
            OR (order_row.status='cancelled' AND order_row.payment_status='unpaid'
              AND EXISTS (
                SELECT 1 FROM mbox.order_settlement_exception_events settlement_exception
                WHERE settlement_exception.tenant_id=$1::uuid AND settlement_exception.store_id=$2::uuid
                  AND settlement_exception.order_id=order_row.id
              )))) AS order_unsettled,
        (SELECT count(*)::text FROM mbox.order_items item
          WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid
            AND item.order_id=ANY(SELECT id FROM scoped_orders)
            AND item.fulfillment_station IN ('bar','kitchen')
            AND item.status NOT IN ('delivered','cancelled')) AS order_item_unresolved,
        (SELECT count(*)::text FROM mbox.kds_tasks task
          JOIN mbox.order_items item ON item.tenant_id=task.tenant_id
            AND item.store_id=task.store_id AND item.id=task.order_item_id
          WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid
            AND item.order_id=ANY(SELECT id FROM scoped_orders)
            AND (task.status IN ('pending','accepted','preparing')
              OR (task.status='ready' AND item.status<>'delivered')
              OR (task.status='failed' AND item.status<>'cancelled'))) AS kds_active,
        (SELECT count(*)::text FROM mbox.payments payment
          WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
            AND payment.order_id=ANY(SELECT id FROM scoped_orders)
            AND payment.status IN ('created','pending')) AS payment_pending,
        (SELECT count(*)::text FROM mbox.inventory_order_reservations reservation
          WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
            AND reservation.order_id=ANY(SELECT id FROM scoped_orders)
            AND reservation.status='reserved') AS inventory_reserved,
        (SELECT count(*)::text FROM mbox.refunds refund
          JOIN mbox.payments payment ON payment.tenant_id=refund.tenant_id
            AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
          WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid
            AND payment.order_id=ANY(SELECT id FROM scoped_orders)
            AND refund.status IN ('requested','approved','processing')) AS refund_pending,
        (SELECT count(*)::text FROM mbox.service_tasks task
          WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid
            AND task.table_session_id=$3::uuid
            AND task.status IN ('pending','acknowledged','in_progress')) AS service_active,
        (SELECT count(*)::text FROM mbox.pricing_authorizations pricing_auth
          WHERE pricing_auth.tenant_id=$1::uuid AND pricing_auth.store_id=$2::uuid
            AND pricing_auth.table_session_id=$3::uuid
            AND pricing_auth.status='reserved') AS pricing_reserved,
        (SELECT count(*)::text FROM mbox.song_requests song
          WHERE song.tenant_id=$1::uuid AND song.store_id=$2::uuid
            AND song.table_session_id=$3::uuid
            AND song.status IN ('requested','confirming','accepted','paid')
            AND ($5::boolean OR song.customer_id IS NULL OR mbox.canonical_customer_id(
              song.tenant_id,song.store_id,song.customer_id
            )=ANY(SELECT customer_id FROM selected_customers))) AS song_active,
        (SELECT count(*)::text FROM mbox.benefit_reservations reservation
          WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
            AND reservation.table_session_id=$3::uuid AND reservation.status='reserved'
            AND ($5::boolean OR mbox.canonical_customer_id(
              reservation.tenant_id,reservation.store_id,reservation.customer_id
            )=ANY(SELECT customer_id FROM selected_customers))) AS benefit_reserved,
        (SELECT count(*)::text FROM mbox.customer_experience_plans plan
          WHERE plan.tenant_id=$1::uuid AND plan.store_id=$2::uuid
            AND plan.table_session_id=$3::uuid
            AND plan.plan_state IN ('planned','active','paused')
            AND ($5::boolean OR mbox.canonical_customer_id(
              plan.tenant_id,plan.store_id,plan.customer_id
            )=ANY(SELECT customer_id FROM selected_customers))) AS experience_active,
        (SELECT count(*)::text FROM mbox.member_redemptions redemption
          WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
            AND redemption.table_session_id=$3::uuid
            AND redemption.status IN ('authorizing','awaiting_fulfillment')
            AND ($5::boolean OR mbox.canonical_customer_id(
              redemption.tenant_id,redemption.store_id,redemption.customer_id
            )=ANY(SELECT customer_id FROM selected_customers))) AS redemption_pending,
        (SELECT count(*)::text FROM mbox.checkout_upgrade_offers offer
          WHERE offer.tenant_id=$1::uuid AND offer.store_id=$2::uuid
            AND offer.table_session_id=$3::uuid AND offer.status IN ('offered','selected')
            AND ($5::boolean OR mbox.canonical_customer_id(
              offer.tenant_id,offer.store_id,offer.customer_id
            )=ANY(SELECT customer_id FROM selected_customers))) AS checkout_offer_active
      `,[context.scope.tenantId,context.scope.storeId,tableSessionId,participantPublicIds,closesSource])
      const blockerCounts=blockerResult.rows[0] ?? {
        order_item_unresolved:'0',kds_active:'0',payment_pending:'0',refund_pending:'0',service_active:'0',
        order_unsettled:'0',inventory_reserved:'0',pricing_reserved:'0',song_active:'0',benefit_reserved:'0',
        experience_active:'0',redemption_pending:'0',checkout_offer_active:'0',
      }
      return { ...row,activeParticipantCount:active.length,activeParticipants:active,blockerCounts }
    },{ readOnly:true })
    if (movementKind==='participant_split' && participantPublicIds.length===0) {
      throw new TableManagementRequestError('拆桌至少要选择一名已识别顾客')
    }
    if (movedGuestCount<participantPublicIds.length) {
      throw new TableManagementRequestError('移动人数不能少于已选择的顾客人数')
    }
    if (movementKind==='participant_split' && movedGuestCount>=targetState.source_guest_count) {
      throw new TableManagementRequestError('拆桌后源桌必须至少保留一人；全员移动请使用人员并桌')
    }
    if (movementKind==='participant_merge') {
      if (movedGuestCount>targetState.source_guest_count) {
        throw new TableManagementRequestError('移动人数不能超过源桌当前人数')
      }
      if (movedGuestCount===targetState.source_guest_count
        && participantPublicIds.length!==targetState.activeParticipantCount) {
        throw new TableManagementRequestError('全员并桌必须选择源桌全部已识别顾客')
      }
      if (movedGuestCount<targetState.source_guest_count && participantPublicIds.length===0) {
        throw new TableManagementRequestError('部分人员并桌至少选择一名已识别顾客')
      }
    }
    const projectedGuestCount=targetState.target_guest_count+movedGuestCount
    const requiresCapacityOverride=projectedGuestCount>targetState.capacity
    if (requiresCapacityOverride && capacityOverrideReason===null) {
      throw new CapacityOverrideReasonRequiredError(targetState.capacity,projectedGuestCount)
    }
    if (!requiresCapacityOverride && capacityOverrideReason!==null) {
      throw new TableManagementRequestError('目标桌容量足够，不应填写加座说明')
    }
    const roleAdjustments=movementKind==='participant_merge' && targetState.target_has_organizer
      ? targetState.activeParticipants.filter((participant) => participantPublicIds.includes(participant.publicId)
          && participant.role==='organizer')
        .map((participant) => ({ participantPublicId:participant.publicId,
          fromRole:'organizer' as const,toRole:'companion' as const,
          reason:'保留目标桌主联系人，迁入主联系人调整为同行顾客' }))
      : []
    const blockerDefinitions=[
      ['ORDER_UNSETTLED','order_unsettled','仍有未结订单','请先完成付款、退款或取消订单'],
      ['ORDER_ITEM_UNRESOLVED','order_item_unresolved','仍有未完成出品','请先完成或取消相关订单行'],
      ['KDS_ACTIVE','kds_active','仍有进行中的出品任务','请先完成或取消相关KDS任务'],
      ['PAYMENT_PENDING','payment_pending','仍有待确认付款','请先确认付款终态'],
      ['INVENTORY_RESERVED','inventory_reserved','仍有占用中库存','请先完成出品或取消并释放库存'],
      ['REFUND_PENDING','refund_pending','仍有处理中退款','请先完成退款流程'],
      ['SERVICE_ACTIVE','service_active','仍有进行中的服务任务','请先完成或取消服务任务'],
      ['PRICING_RESERVED','pricing_reserved','仍有占用中的定价授权','请先完成或释放定价授权'],
      ['SONG_ACTIVE','song_active','仍有进行中的点歌请求','请先完成或取消点歌请求'],
      ['BENEFIT_RESERVED','benefit_reserved','仍有占用中的权益','请先完成或释放权益'],
      ['EXPERIENCE_ACTIVE','experience_active','仍有进行中的体验计划','请先完成或结束体验计划'],
      ['REDEMPTION_PENDING','redemption_pending','仍有待履约兑换','请先完成或取消兑换'],
      ['CHECKOUT_OFFER_ACTIVE','checkout_offer_active','仍有待处理加单报价','请先接受、拒绝或失效报价'],
    ] as const
    const blockers=blockerDefinitions.flatMap(([code,key,label,resolution]) => {
      const count=Number(targetState.blockerCounts[key])
      return count>0 ? [{ code,count,label,resolution }] : []
    })
    return reply.send({ data:{ movementKind,movedGuestCount,
      selectedParticipantCount:participantPublicIds.length,
      targetTableId,targetTableSessionId,targetCapacity:targetState.capacity,
      projectedGuestCount,requiresCapacityOverride,
      roleAdjustments,
      blockers,
      finalRevalidationRequired:true,
      accountingBoundary:'历史订单、支付、任务和观察不会迁移；有未结对象时执行将被拒绝',
    } })
  }))

  app.post('/table-management/sessions/:tableSessionId/participant-movements', async (request, reply) => handle(reply, async () => {
    const context=await authorizedContext(options,request)
    const body=readObject(request.body)
    const movementKind=readEnum(body.movementKind,'movementKind',['participant_split','participant_merge'] as const)
    const participantPublicIds=readPublicIdArray(body.participantPublicIds,'participantPublicIds',200,true)
    if (movementKind==='participant_split' && participantPublicIds.length===0) {
      throw new TableManagementRequestError('拆桌至少要选择一名已识别顾客')
    }
    const movedGuestCount=readInteger(body.movedGuestCount,'movedGuestCount',1,200)
    if (movedGuestCount<participantPublicIds.length) {
      throw new TableManagementRequestError('移动人数不能少于已选择的顾客人数')
    }
    const execution=await options.commands.moveParticipants(commandBase(request,context,body,'调整顾客所在桌次',{
      movementKind,sourceTableSessionId:readUuid(readParams(request).tableSessionId,'tableSessionId'),
      targetTableId:readUuid(body.targetTableId,'targetTableId'),
      targetTableSessionId:body.targetTableSessionId===null || body.targetTableSessionId===undefined
        ? null : readUuid(body.targetTableSessionId,'targetTableSessionId'),
      movedGuestCount,
      participantPublicIds,
      capacityOverrideReason:optionalString(body.capacityOverrideReason,'capacityOverrideReason',1000),
    }))
    return reply.send(commandResponse(execution))
  }))
}

async function authorizedContext(options: TableManagementApiOptions, request: FastifyRequest) {
  const context = await options.resolveContext(request)
  readUuid(context.scope.tenantId, 'tenantId')
  readUuid(context.scope.storeId, 'storeId')
  readUuid(context.employeeId, 'employeeId')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(context.businessDate)) throw new TableManagementRequestError('营业日格式无效')
  return context
}

function commandBase<Input extends Record<string, unknown>>(
  request: FastifyRequest,
  context: NormalizedOperationsRequestContext,
  body: Record<string, unknown>,
  defaultReason: string,
  input: Input,
) {
  const reason = optionalString(body.reason, 'reason', 1000) ?? defaultReason
  const idempotencyKey = readIdempotencyKey(request)
  return {
    ...input,
    scope: context.scope,
    actor: { type: 'employee' as const, employeeId: context.employeeId },
    businessDate: context.businessDate,
    reason,
    idempotencyKey,
    requestFingerprint: createHash('sha256').update(JSON.stringify({
      method: request.method,
      url: request.url,
      employeeId: context.employeeId,
      body,
    })).digest('hex'),
  }
}

function readArea(body: Record<string, unknown>, includeCode: boolean): Omit<ManagedArea,
  'id' | 'code' | 'createdAt' | 'updatedAt'> & { code?: string } {
  return {
    ...(includeCode ? { code: requiredString(body.code, 'code', 32) } : {}),
    name: requiredString(body.name, 'name', 120),
    areaType: readEnum(body.areaType, 'areaType', ['indoor', 'outdoor', 'bar', 'stage', 'vip', 'other']),
    sortOrder: readInteger(body.sortOrder, 'sortOrder', -100_000, 100_000),
    layoutSnapshot: optionalObject(body.layoutSnapshot, 'layoutSnapshot') ?? {},
    status: readEnum(body.status, 'status', ['active', 'paused', 'retired']) as AreaStatus,
  }
}

function readTable(body: Record<string, unknown>, includeCode: boolean): Omit<ManagedTable,
  'id' | 'areaId' | 'areaCode' | 'areaName' | 'code' | 'assignedToActor' | 'activeSessionId' |
  'activeGuestCount' | 'createdAt' | 'updatedAt'> & { code?: string } {
  return {
    ...(includeCode ? { code: requiredString(body.code, 'code', 32) } : {}),
    displayName: requiredString(body.displayName, 'displayName', 120),
    capacity: readInteger(body.capacity, 'capacity', 1, 200),
    minimumSpendMinor: optionalInteger(body.minimumSpendMinor, 'minimumSpendMinor', 0, Number.MAX_SAFE_INTEGER),
    currency: optionalString(body.currency, 'currency', 3) ?? 'CNY',
    layoutSnapshot: optionalObject(body.layoutSnapshot, 'layoutSnapshot') ?? {},
    status: readEnum(body.status, 'status', ['available', 'paused', 'retired']) as TableStatus,
  }
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['x-idempotency-key'] ?? request.headers['idempotency-key']
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 160) {
    throw new TableManagementRequestError('请提供有效的X-Idempotency-Key')
  }
  return value.trim()
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TableManagementRequestError('请求正文必须是对象')
  return value as Record<string, unknown>
}

function optionalObject(value: unknown, field: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TableManagementRequestError(`${field}必须是对象`)
  return value as JsonObject
}

function readOpenTableGuestProfileSnapshot(body: Record<string, unknown>): JsonObject | undefined {
  const snapshot = optionalObject(body.guestProfileSnapshot, 'guestProfileSnapshot')
  if (snapshot === undefined) return undefined
  const keys = Object.keys(snapshot)
  if (keys.length !== 1 || keys[0] !== 'recommendationScene') {
    throw new TableManagementRequestError('guestProfileSnapshot仅支持recommendationScene')
  }
  return {
    recommendationScene: readEnum(
      snapshot.recommendationScene,
      'guestProfileSnapshot.recommendationScene',
      ['friends', 'business', 'date', 'other'] as const,
    ),
  }
}

function readParams(request: FastifyRequest): Record<string, unknown> {
  return readObject(request.params)
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) throw new TableManagementRequestError(`${field}无效`)
  return value.trim()
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredString(value, field, max)
}

function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new TableManagementRequestError(`${field}无效`)
  return value as number
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null
  return readInteger(value, field, min, max)
}

function readTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field, 64)
  if (!Number.isFinite(Date.parse(timestamp))) throw new TableManagementRequestError(`${field}时间格式无效`)
  return timestamp
}

function optionalTimestamp(value: unknown, field: string): string | null {
  return value === undefined || value === null || value === '' ? null : readTimestamp(value, field)
}

function readUuid(value: unknown, field: string): string {
  const uuid = requiredString(value, field, 64)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new TableManagementRequestError(`${field}格式无效`)
  }
  return uuid
}

function readUuidArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new TableManagementRequestError(`${field}必须包含1至${max}项`)
  }
  const parsed = value.map((item, index) => readUuid(item, `${field}[${index}]`))
  if (new Set(parsed).size !== parsed.length) throw new TableManagementRequestError(`${field}不能包含重复桌台`)
  return parsed
}

function readPublicIdArray(value:unknown,field:string,max:number,allowEmpty=false):string[] {
  if (!Array.isArray(value) || value.length>max || (!allowEmpty && value.length===0)) {
    throw new TableManagementRequestError(`${field}数量无效`)
  }
  const parsed=value.map((item,index) => {
    if (typeof item!=='string' || !/^[A-Za-z0-9-]{8,128}$/.test(item)) {
      throw new TableManagementRequestError(`${field}[${index}]格式无效`)
    }
    return item
  })
  if (new Set(parsed).size!==parsed.length) throw new TableManagementRequestError(`${field}不能重复`)
  return parsed
}

function readEnum<const Value extends string>(value: unknown, field: string, allowed: readonly Value[]): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) throw new TableManagementRequestError(`${field}无效`)
  return value as Value
}

function commandResponse<Result>(execution: { value: Result; replayed: boolean }) {
  return { data: execution.value, meta: { replayed: execution.replayed } }
}

async function handle(reply: FastifyReply, operation: () => Promise<unknown>) {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } } satisfies ApiErrorBody)
  }
}

function mapError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof TableManagementRequestError || error instanceof TypeError) {
    return { status: 400, code: 'TABLE_REQUEST_INVALID', message: error.message }
  }
  if (error instanceof NormalizedAuthenticationRequiredError) return { status: 401, code: 'AUTH_REQUIRED', message: error.message }
  if (error instanceof StaffAccessDeniedError) return { status: 403, code: 'TABLE_PERMISSION_DENIED', message: '当前岗位无权执行该桌台操作' }
  if (error instanceof StaffNotFoundError) return { status: 401, code: 'STAFF_NOT_FOUND', message: '员工账号不可用，请重新登录' }
  if (error instanceof TableManagementNotFoundError) return { status: 404, code: 'TABLE_RESOURCE_NOT_FOUND', message: error.message }
  if (error instanceof CapacityOverrideReasonRequiredError) return { status: 422, code: 'CAPACITY_OVERRIDE_REASON_REQUIRED', message: error.message }
  if (error instanceof TableManagementConflictError || error instanceof IdempotencyConflictError
    || error instanceof IdempotencyInProgressError || error instanceof OutboxMessageConflictError) {
    return { status: 409, code: 'TABLE_OPERATION_CONFLICT', message: error.message }
  }
  if (error instanceof IdempotencyRecordError) return { status: 503, code: 'IDEMPOTENCY_UNAVAILABLE', message: '操作暂时无法确认，请稍后重试' }
  if (error instanceof TrustedStoreScopeError || error instanceof NormalizedStoreUnavailableError) {
    return { status: 503, code: 'STORE_UNAVAILABLE', message: error.message }
  }
  throw error
}
