import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  BenefitAuthorizationError,
  BenefitCommandService,
  BenefitIdempotencyConflictError,
  BenefitNotFoundError,
  BenefitOwnershipError,
  BenefitRepository,
  BenefitReservationNotFoundError,
  BenefitUnavailableError,
} from './benefit-repository.js'
import { appendAuditEvent,appendOutboxMessage,type JsonObject } from './command-executor.js'
import {
  CustomerCommandService,
  CustomerIdentityConflictError,
  CustomerMergeConflictError,
  CustomerNotFoundError,
  CustomerRepository,
  type CustomerIdentityKind,
} from './customer-repository.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import {
  GuestAuthenticationRequiredError,
  GuestDeviceBindingError,
  GuestStoreScopeError,
} from './guest-request-context.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import { ReservationGuestSessionInvalidError } from './reservation-guest-session.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'
import { AnnualDailySnackClaimError, AnnualDailySnackClaimService } from './annual-daily-snack-claim-service.js'
import {
  ComplimentaryFulfillmentResolutionError,
  ComplimentaryFulfillmentResolutionService,
} from './complimentary-fulfillment-resolution-service.js'
import { EmployeeTableAccessDeniedError } from './employee-table-access.js'
import { assertEmployeeTableSessionAccess } from './employee-table-access.js'
import { createBenefitClaimQrDataUrl } from './member-code-qr.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export interface CustomerBenefitGuestContext {
  scope: Readonly<StoreScope>
  customerId: string
  tableSessionId: string | null
  businessDate: string
  actorRef: string
}

export interface CustomerBenefitStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export interface CustomerBenefitApiOptions {
  transactions: TransactionRunner
  customers: CustomerCommandService
  benefits: BenefitCommandService
  dailySnackClaims?: AnnualDailySnackClaimService
  now?: () => Date
  resolveSelfContext(request: FastifyRequest): Promise<CustomerBenefitGuestContext> | CustomerBenefitGuestContext
  resolveGuestContext(request: FastifyRequest): Promise<CustomerBenefitGuestContext> | CustomerBenefitGuestContext
  resolveStaffContext(request: FastifyRequest): Promise<CustomerBenefitStaffContext> | CustomerBenefitStaffContext
  createCustomerRepository?(transaction: ScopedTransaction): CustomerRepository
  createBenefitRepository?(transaction: ScopedTransaction): BenefitRepository
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository, 'assertPermission'>
}

interface StaffAnnualBenefitReservationRow extends Record<string, unknown> {
  reservation_id: string
  benefit_id: string
  customer_id: string
  table_session_id: string
  table_code: string
  member_no: string | null
  customer_name: string | null
  rule_kind: 'birthday' | 'festival'
  rule_title: string
  quantity: number
  reserved_at: string
  expires_at: string
  original_product_id: string
  original_product_name: string
  allowed_products: Array<{ productId: string; name: string; isOriginal: boolean; configuredReason: string | null }>
}

interface ComplimentaryFulfillmentExceptionRow extends Record<string, unknown> {
  id:string
  order_id:string
  benefit_id:string
  table_session_id:string
  table_code:string
  order_public_id:string
  status:'pending'|'retry'|'dispatched'|'failed'
  attempt_count:number
  last_error_code:string|null
  last_error_at:string|null
  member_no:string|null
  customer_name:string|null
  title:string|null
  updated_at:string
}

interface ApiErrorBody { error: { code: string; message: string } }

class CustomerBenefitRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustomerBenefitRequestError'
  }
}

export const customerBenefitApiPlugin: FastifyPluginAsync<CustomerBenefitApiOptions> = async (
  app,
  options,
) => {
  app.get('/public/mini/customer/profile', async (request, reply) => {
    privateNoStore(reply)
    return handleRoute(reply, async () => {
      const context = await options.resolveSelfContext(request)
      const customer = await options.transactions.run(context.scope, (transaction) => (
        customerRepository(options, transaction).findPublicById(context.customerId)
      ), { readOnly: true })
      if (customer === null) throw new CustomerNotFoundError(context.customerId)
      return reply.send({ data: customer })
    })
  })

  app.get('/public/mini/customer/benefits', async (request, reply) => {
    privateNoStore(reply)
    return handleRoute(reply, async () => {
      const context = await options.resolveSelfContext(request)
      const benefits = await options.transactions.run(context.scope, (transaction) => (
        benefitRepository(options, transaction).listAvailableForCustomer(context.customerId)
      ), { readOnly: true })
      return reply.send({ data: benefits.map(toPublicBenefit) })
    })
  })

  app.get('/guest/customer/profile', async (request, reply) => {
    privateNoStore(reply)
    return handleRoute(reply, async () => {
      const context = await options.resolveGuestContext(request)
      const customer = await options.transactions.run(context.scope, async (transaction) => {
        if (context.tableSessionId === null) throw new GuestAuthenticationRequiredError()
        if (!await lockBoundGuestTablePosition(transaction, {
          tableSessionId: context.tableSessionId,
          customerId: context.customerId,
          actorRef: context.actorRef,
        })) {
          throw new GuestAuthenticationRequiredError()
        }
        return customerRepository(options, transaction).findPublicById(context.customerId)
      })
      if (customer === null) throw new CustomerNotFoundError(context.customerId)
      return reply.send({ data: customer })
    })
  })

  app.get('/guest/customer/benefits', async (request, reply) => {
    privateNoStore(reply)
    return handleRoute(reply, async () => {
      const context = await options.resolveGuestContext(request)
      const benefits = await options.transactions.run(context.scope, async (transaction) => {
        if (context.tableSessionId === null) throw new GuestAuthenticationRequiredError()
        if (!await lockBoundGuestTablePosition(transaction, {
          tableSessionId: context.tableSessionId,
          customerId: context.customerId,
          actorRef: context.actorRef,
        })) {
          throw new GuestAuthenticationRequiredError()
        }
        return benefitRepository(options, transaction).listAvailableForCustomer(context.customerId)
      })
      return reply.send({ data: benefits.map(toPublicBenefit) })
    })
  })

  app.post('/guest/customer/benefits/:benefitId/reservations', async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveGuestContext(request)
      if (context.tableSessionId === null) throw new CustomerBenefitRequestError('请在入座后预约使用权益')
      const body = readObject(request.body)
      const benefitId = readRouteId(request.params, 'benefitId')
      const idempotencyKey = readIdempotencyKey(request)
      const quantity = readInteger(body.quantity, '数量', 1, 100, 1)
      const result = await options.benefits.reserve({
        scope: context.scope,
        actor: { type: 'guest', ref: context.actorRef },
        businessDate: context.businessDate,
        benefitId,
        customerId: context.customerId,
        tableSessionId: context.tableSessionId,
        quantity,
        expiresAt: reservationExpiresAt(options),
        reservationIdempotencyKey: idempotencyKey,
        reservationFingerprint: fingerprint({
          benefitId,
          customerId: context.customerId,
          tableSessionId: context.tableSessionId,
          quantity,
        }),
      })
      return reply.code(201).send({ data: toPublicReservation(result.value), meta: { replayed: result.replayed } })
    }))

  app.post('/guest/customer/annual-daily-snacks/claim', async (request, reply) =>
    handleRoute(reply, async () => {
      if (options.dailySnackClaims === undefined) throw new CustomerBenefitRequestError('每日点心服务尚未启用')
      const context = await options.resolveGuestContext(request)
      const result = await options.dailySnackClaims.claim(context, { idempotencyKey: readIdempotencyKey(request) })
      const claimCodeQrDataUrl = await createBenefitClaimQrDataUrl(result.value.claimCode)
      return reply.code(result.replayed ? 200 : 201).send({
        data: { ...result.value, claimCodeQrDataUrl }, meta: { replayed: result.replayed },
      })
    }))

  app.post('/guest/customer/benefit-reservations/:reservationId/cancel', async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveGuestContext(request)
      if (context.tableSessionId === null) throw new CustomerBenefitRequestError('当前没有可操作的桌次')
      const body = readObject(request.body)
      const reservationId = readRouteId(request.params, 'reservationId')
      const idempotencyKey = readIdempotencyKey(request)
      const reason = readString(body.reason, '取消原因', 256, 2)
      const result = await options.benefits.cancelReservation({
        scope: context.scope,
        actor: { type: 'guest', ref: context.actorRef },
        businessDate: context.businessDate,
        benefitReservationId: reservationId,
        customerId: context.customerId,
        tableSessionId: context.tableSessionId,
        reason,
        cancellationIdempotencyKey: idempotencyKey,
        cancellationFingerprint: fingerprint({ reservationId, reason, tableSessionId: context.tableSessionId }),
      })
      return reply.send({ data: toPublicReservation(result.value), meta: { replayed: result.replayed } })
    }))

  app.get('/staff/annual-benefit-reservations', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    const query = readObject(request.query)
    const tableSessionId = optionalUuid(query.tableSessionId, '桌次')
    const data = await options.transactions.run(context.scope, async (transaction) => {
      await staffAccess(options, transaction).assertPermission(context.employeeId, 'loyalty.redemption.fulfill')
      return listStaffAnnualBenefitReservations(transaction, context.employeeId, tableSessionId)
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.post('/staff/annual-benefit-reservations/:reservationId/cancel',async (request,reply)=>handleRoute(reply,async()=>{
    const context=await options.resolveStaffContext(request)
    const reservationId=readRouteId(request.params,'reservationId')
    const body=readObject(request.body)
    const customerId=readString(body.customerId,'客户',64,8)
    const tableSessionId=readString(body.tableSessionId,'桌次',64,8)
    const reason=readString(body.reason,'取消原因',256,2)
    const authorized=await options.transactions.run(context.scope,async(transaction)=>{
      await staffAccess(options,transaction).assertPermission(context.employeeId,'loyalty.redemption.fulfill')
      const rows=await listStaffAnnualBenefitReservations(
        transaction,context.employeeId,tableSessionId,reservationId,
      )
      return rows.some((row)=>row.reservationId===reservationId&&row.customerId===customerId
        &&row.tableSessionId===tableSessionId)
    },{readOnly:true})
    if (!authorized) throw new CustomerBenefitRequestError('该生日或节日礼遇暂留不存在、已过期或不属于当前负责桌台')
    const idempotencyKey=readIdempotencyKey(request)
    const result=await options.benefits.cancelReservation({
      scope:context.scope,actor:{type:'employee',employeeId:context.employeeId},businessDate:context.businessDate,
      benefitReservationId:reservationId,customerId,tableSessionId,reason,
      cancellationIdempotencyKey:idempotencyKey,
      cancellationFingerprint:fingerprint({reservationId,customerId,tableSessionId,reason,kind:'annual-benefit'}),
      employeePermission:'loyalty.redemption.fulfill',
    })
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))

  app.get('/staff/complimentary-fulfillment-exceptions',async (request,reply) => handleRoute(reply,async () => {
    const context=await options.resolveStaffContext(request)
    const data=await options.transactions.run(context.scope,async (transaction) => {
      await staffAccess(options,transaction).assertPermission(context.employeeId,'loyalty.redemption.exception')
      return listComplimentaryFulfillmentExceptions(transaction,context.employeeId)
    },{ readOnly:true })
    return reply.send({ data })
  }))

  app.post('/staff/complimentary-fulfillment-exceptions/:intentId/retry',async (request,reply) => (
    handleRoute(reply,async () => {
      const context=await options.resolveStaffContext(request)
      const retryRequestKey=readIdempotencyKey(request)
      const intentId=optionalUuid(readRouteId(request.params,'intentId'),'履约任务')
      if (intentId===null) throw new CustomerBenefitRequestError('履约任务格式不正确')
      const reason=readString(readObject(request.body).reason,'重试原因',240,2)
      const data=await options.transactions.run(context.scope,async (transaction) => {
        await staffAccess(options,transaction).assertPermission(context.employeeId,'loyalty.redemption.exception')
        const locked=await transaction.query<ComplimentaryFulfillmentExceptionRow>(`
          SELECT intent.id,intent.order_id,intent.benefit_id,order_row.table_session_id,
            venue_table.code AS table_code,order_row.public_id AS order_public_id,intent.status,
            intent.attempt_count,intent.last_error_code,intent.last_error_at::text,
            membership.member_no,profile.display_name AS customer_name,rule.title,intent.updated_at::text
          FROM mbox.complimentary_fulfillment_intents intent
          JOIN mbox.orders order_row
            ON order_row.tenant_id=intent.tenant_id AND order_row.store_id=intent.store_id
           AND order_row.id=intent.order_id
          JOIN mbox.table_sessions session
            ON session.tenant_id=order_row.tenant_id AND session.store_id=order_row.store_id
           AND session.id=order_row.table_session_id
          JOIN mbox.tables venue_table
            ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
           AND venue_table.id=session.table_id
          LEFT JOIN mbox.membership_annual_benefit_grants grant_row
            ON grant_row.tenant_id=intent.tenant_id AND grant_row.store_id=intent.store_id
           AND grant_row.benefit_id=intent.benefit_id
          LEFT JOIN mbox.loyalty_annual_benefit_rules rule
            ON rule.tenant_id=grant_row.tenant_id AND rule.store_id=grant_row.store_id
           AND rule.id=grant_row.rule_id
          LEFT JOIN mbox.customer_memberships membership
            ON membership.tenant_id=grant_row.tenant_id AND membership.store_id=grant_row.store_id
           AND membership.id=grant_row.membership_id
          LEFT JOIN mbox.customer_profiles profile
            ON profile.tenant_id=membership.tenant_id AND profile.store_id=membership.store_id
           AND profile.customer_id=membership.customer_id
          WHERE intent.tenant_id=$1::uuid AND intent.store_id=$2::uuid AND intent.id=$3::uuid
          FOR UPDATE OF intent
        `,[transaction.scope.tenantId,transaction.scope.storeId,intentId])
        const before=locked.rows[0]
        if (!before) throw new CustomerBenefitRequestError('履约异常不存在')
        await assertEmployeeTableSessionAccess(transaction,{
          employeeId:context.employeeId,tableSessionId:before.table_session_id,
          allTablePermissionCodes:['table.view_all'],lockTableSession:true,
        })
        if (before.status==='pending') {
          return { ...before,status:'pending',attemptCount:before.attempt_count,
            lastErrorCode:before.last_error_code,replayed:true }
        }
        if (!['retry','failed'].includes(before.status)) {
          throw new CustomerBenefitRequestError('该履约任务当前不需要人工重试')
        }
        const updated=await transaction.query(`
          UPDATE mbox.complimentary_fulfillment_intents
          SET status='pending',attempt_count=0,next_attempt_at=clock_timestamp(),dispatched_at=NULL
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
            AND status IN ('retry','failed')
        `,[transaction.scope.tenantId,transaction.scope.storeId,intentId])
        if (updated.rowCount!==1) throw new CustomerBenefitRequestError('履约任务状态已变化，请刷新后重试')
        await appendAuditEvent(transaction,{
          actor:{ type:'employee',employeeId:context.employeeId },
          action:'loyalty.complimentary-fulfillment.manual-retry',objectType:'complimentary_fulfillment_intent',
          objectId:intentId,businessDate:context.businessDate,
          beforeData:{ status:before.status,attemptCount:before.attempt_count,lastErrorCode:before.last_error_code },
          afterData:{ status:'pending',attemptCount:0,orderId:before.order_id,benefitId:before.benefit_id },reason,
        })
        await appendOutboxMessage(transaction,{
          businessEventKey:`benefit-gift-fulfillment-manual-retry:${intentId}:${createHash('sha256').update(retryRequestKey).digest('hex').slice(0,32)}`,
          aggregateType:'order',aggregateId:before.order_id,aggregateVersion:2,
          eventType:'benefit.gift.fulfillment-manual-retry.v1',
          payload:{ intentId,orderId:before.order_id,benefitId:before.benefit_id,
            employeeId:context.employeeId,reason },
        })
        return { ...before,status:'pending',attemptCount:0,lastErrorCode:before.last_error_code,replayed:false }
      })
      return reply.send({ data })
    })
  ))

  app.post('/staff/complimentary-fulfillment-exceptions/:intentId/resolve',async (request,reply) => (
    handleRoute(reply,async () => {
      const context=await options.resolveStaffContext(request)
      const intentId=optionalUuid(readRouteId(request.params,'intentId'),'履约任务')
      if (intentId===null) throw new CustomerBenefitRequestError('履约任务格式不正确')
      const body=readObject(request.body)
      const action=readEnum(body.action,['cancel_release','external_compensation'] as const,'结案方式')
      const reason=readString(body.reason,'结案原因',500,2)
      const compensationReference=action==='external_compensation'
        ? readString(body.compensationReference,'线下补偿凭证',200,2)
        : null
      const data=await new ComplimentaryFulfillmentResolutionService(options.transactions).resolve({
        scope:context.scope,employeeId:context.employeeId,businessDate:context.businessDate,
        intentId,action,reason,compensationReference,idempotencyKey:readIdempotencyKey(request),
      })
      return reply.send({ data,meta:{ replayed:data.replayed } })
    })
  ))

  app.get('/customers/:publicId', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    const customer = await options.transactions.run(context.scope, async (transaction) => {
      await staffAccess(options, transaction).assertPermission(context.employeeId, 'customer.view')
      return customerRepository(options, transaction).findByPublicId(readRouteId(request.params, 'publicId'))
    }, { readOnly: true })
    if (customer === null) throw new CustomerNotFoundError('public')
    return reply.send({ data: toStaffCustomer(customer) })
  }))

  app.get('/customers/:publicId/history', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      await staffAccess(options, transaction).assertPermission(context.employeeId, 'customer.view')
      const repository = customerRepository(options, transaction)
      const customer = await repository.findByPublicId(readRouteId(request.params, 'publicId'))
      if (customer === null) throw new CustomerNotFoundError('public')
      return repository.listHistory(customer.id, readLimit(request.query))
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.patch('/customers/:customerId/profile', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'customer.manage')
    const body = readObject(request.body)
    const customerId = readRouteId(request.params, 'customerId')
    const idempotencyKey = readIdempotencyKey(request)
    const reason = readString(body.reason, '修改原因', 256, 2)
    const profile = readProfile(body.profile)
    const result = await options.customers.updateProfile({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      customerId,
      profile,
      reason,
      idempotencyKey,
      requestFingerprint: fingerprint({ customerId, profile, reason }),
    })
    return reply.send({ data: toStaffCustomer(result.value), meta: { replayed: result.replayed } })
  }))

  app.post('/customers/:customerId/identities', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'customer.manage')
    const body = readObject(request.body)
    const customerId = readRouteId(request.params, 'customerId')
    const identityKind = readIdentityKind(body.identityKind)
    const identityHash = readHash(body.identityHash)
    const reason = readString(body.reason, '绑定原因', 256, 2)
    const idempotencyKey = readIdempotencyKey(request)
    const result = await options.customers.linkIdentity({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      customerId,
      identityKind,
      identityHash,
      reason,
      idempotencyKey,
      requestFingerprint: fingerprint({ customerId, identityKind, identityHash, reason }),
    })
    return reply.send({ data: toStaffCustomer(result.value), meta: { replayed: result.replayed } })
  }))

  app.post('/customers/merge', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'customer.manage')
    const body = readObject(request.body)
    const sourceCustomerId = readString(body.sourceCustomerId, '源客户', 64, 8)
    const targetCustomerId = readString(body.targetCustomerId, '目标客户', 64, 8)
    const reason = readString(body.reason, '合并原因', 256, 2)
    const idempotencyKey = readIdempotencyKey(request)
    const result = await options.customers.merge({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      sourceCustomerId,
      targetCustomerId,
      reason,
      idempotencyKey,
      requestFingerprint: fingerprint({ sourceCustomerId, targetCustomerId, reason }),
    })
    return reply.send({ data: toStaffCustomer(result.value), meta: { replayed: result.replayed } })
  }))

  app.post('/benefits', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'benefit.issue')
    const body = readObject(request.body)
    const idempotencyKey = readIdempotencyKey(request)
    const input = readIssueBenefit(body)
    const result = await options.benefits.issue({
      ...input,
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      issuedByEmployeeId: context.employeeId,
      issuanceIdempotencyKey: idempotencyKey,
      issuanceFingerprint: fingerprint(input),
    })
    return reply.code(201).send({ data: toStaffBenefit(result.value), meta: { replayed: result.replayed } })
  }))

  app.post('/benefits/:benefitId/reservations', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'loyalty.redemption.fulfill')
    const body = readObject(request.body)
    const benefitId = readRouteId(request.params, 'benefitId')
    const idempotencyKey = readIdempotencyKey(request)
    const customerId = readString(body.customerId, '客户', 64, 8)
    const tableSessionId = readString(body.tableSessionId, '桌次', 64, 8)
    const quantity = readInteger(body.quantity, '数量', 1, 100, 1)
    const result = await options.benefits.reserve({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      benefitId,
      customerId,
      tableSessionId,
      quantity,
      expiresAt: reservationExpiresAt(options),
      reservationIdempotencyKey: idempotencyKey,
      reservationFingerprint: fingerprint({ benefitId, customerId, tableSessionId, quantity }),
    })
    return reply.code(201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post('/benefit-reservations/:reservationId/redeem', async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveStaffContext(request)
      await assertPermission(options, context, 'loyalty.redemption.fulfill')
      const body = readObject(request.body)
      const reservationId = readRouteId(request.params, 'reservationId')
      const idempotencyKey = readIdempotencyKey(request)
      const benefitId = readString(body.benefitId, '权益', 64, 8)
      const customerId = readString(body.customerId, '客户', 64, 8)
      const tableSessionId = readString(body.tableSessionId, '桌次', 64, 8)
      const selectedProductId = optionalUuid(body.selectedProductId, '兑付商品')
      const substitutionReason = body.substitutionReason === undefined || body.substitutionReason === null
        ? null : readString(body.substitutionReason, '替换原因', 240, 2)
      const result = await options.benefits.redeem({
        scope: context.scope,
        actor: { type: 'employee', employeeId: context.employeeId },
        businessDate: context.businessDate,
        benefitId,
        benefitReservationId: reservationId,
        customerId,
        tableSessionId,
        selectedProductId,
        substitutionReason,
        redeemedByEmployeeId: context.employeeId,
        authorizationSource: { kind: 'employee', employeeId: context.employeeId },
        redemptionIdempotencyKey: idempotencyKey,
        redemptionFingerprint: fingerprint({ benefitId, reservationId, customerId, tableSessionId, selectedProductId, substitutionReason }),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }))

  app.post('/benefit-reservations/:reservationId/cancel', async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveStaffContext(request)
      await assertPermission(options, context, 'benefit.cancel')
      const body = readObject(request.body)
      const reservationId = readRouteId(request.params, 'reservationId')
      const customerId = readString(body.customerId, '客户', 64, 8)
      const tableSessionId = readString(body.tableSessionId, '桌次', 64, 8)
      const reason = readString(body.reason, '取消原因', 256, 2)
      const idempotencyKey = readIdempotencyKey(request)
      const result = await options.benefits.cancelReservation({
        scope: context.scope,
        actor: { type: 'employee', employeeId: context.employeeId },
        businessDate: context.businessDate,
        benefitReservationId: reservationId,
        customerId,
        tableSessionId,
        reason,
        cancellationIdempotencyKey: idempotencyKey,
        cancellationFingerprint: fingerprint({ reservationId, customerId, tableSessionId, reason }),
        employeePermission: 'benefit.cancel',
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }))

  app.get('/staff/annual-daily-snack-claims', async (request, reply) => handleRoute(reply, async () => {
    if (options.dailySnackClaims === undefined) throw new CustomerBenefitRequestError('每日点心服务尚未启用')
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'loyalty.redemption.fulfill')
    const query = readObject(request.query)
    return reply.send({ data: await options.dailySnackClaims.listForStaff(context, optionalUuid(query.tableSessionId, '桌次')) })
  }))

  app.post<{ Params: { claimCode: string } }>('/staff/annual-daily-snack-claims/:claimCode/redeem', async (request, reply) =>
    handleRoute(reply, async () => {
      if (options.dailySnackClaims === undefined) throw new CustomerBenefitRequestError('每日点心服务尚未启用')
      const context = await options.resolveStaffContext(request)
      await assertPermission(options, context, 'loyalty.redemption.fulfill')
      const claim = await options.dailySnackClaims.findRedeemableForStaff(context, String(request.params.claimCode || '').trim())
      if (claim.claim.status !== 'reserved') {
        return reply.send({
          data: { claim: claim.claim, redemption: null },
          meta: { replayed: true, alreadyProcessed: true },
        })
      }
      const idempotencyKey = readIdempotencyKey(request)
      const result = await options.benefits.redeem({
        scope: context.scope, actor: { type: 'employee', employeeId: context.employeeId }, businessDate: context.businessDate,
        benefitId: claim.claim.benefitId!, benefitReservationId: claim.claim.benefitReservationId!,
        customerId: claim.customerId, tableSessionId: claim.tableSessionId, redeemedByEmployeeId: context.employeeId,
        authorizationSource: { kind: 'annual_daily_snack', claimCode: claim.claim.claimCode, employeeId: context.employeeId },
        redemptionIdempotencyKey: idempotencyKey,
        redemptionFingerprint: fingerprint({ claimCode: claim.claim.claimCode, benefitId: claim.claim.benefitId, reservationId: claim.claim.benefitReservationId }),
      })
      const refreshed = await options.dailySnackClaims.findRedeemableForStaff(context, claim.claim.claimCode)
      return reply.send({ data: { claim: refreshed.claim, redemption: result.value }, meta: { replayed: result.replayed } })
    }))

  app.post<{ Params: { claimCode: string } }>('/staff/annual-daily-snack-claims/:claimCode/cancel', async (request, reply) =>
    handleRoute(reply, async () => {
      if (options.dailySnackClaims === undefined) throw new CustomerBenefitRequestError('每日点心服务尚未启用')
      const context = await options.resolveStaffContext(request)
      await assertPermission(options, context, 'loyalty.redemption.fulfill')
      const body = readObject(request.body)
      const claim = await options.dailySnackClaims.findCancellableForStaff(context, String(request.params.claimCode || '').trim())
      const reason = readString(body.reason, '取消原因', 256, 2)
      const idempotencyKey = readIdempotencyKey(request)
      const result = await options.benefits.cancelReservation({
        scope: context.scope, actor: { type: 'employee', employeeId: context.employeeId }, businessDate: context.businessDate,
        benefitReservationId: claim.claim.benefitReservationId!, customerId: claim.customerId, tableSessionId: claim.tableSessionId,
        reason, cancellationIdempotencyKey: idempotencyKey,
        cancellationFingerprint: fingerprint({ claimCode: claim.claim.claimCode, benefitId: claim.claim.benefitId,
          reservationId: claim.claim.benefitReservationId, reason }),
        employeePermission: 'loyalty.redemption.fulfill',
      })
      return reply.send({ data: { claim: claim.claim, cancellation: result.value }, meta: { replayed: result.replayed } })
    }))
}

async function assertPermission(
  options: CustomerBenefitApiOptions,
  context: CustomerBenefitStaffContext,
  permission: string,
): Promise<void> {
  await options.transactions.run(context.scope, async (transaction) =>
    staffAccess(options, transaction).assertPermission(context.employeeId, permission), { readOnly: true })
}

function customerRepository(options: CustomerBenefitApiOptions, transaction: ScopedTransaction): CustomerRepository {
  return options.createCustomerRepository?.(transaction) ?? new CustomerRepository(transaction)
}

async function listStaffAnnualBenefitReservations(
  transaction: ScopedTransaction,
  employeeId: string,
  tableSessionId: string | null,
  reservationId: string | null = null,
) {
  const result = await transaction.query<StaffAnnualBenefitReservationRow>(`
    SELECT reservation.id AS reservation_id,reservation.benefit_id,reservation.customer_id,
      reservation.table_session_id,venue_table.code AS table_code,membership.member_no,
      profile.display_name AS customer_name,rule.rule_kind,rule.title AS rule_title,reservation.quantity,
      reservation.reserved_at::text,reservation.expires_at::text,
      definition.product_id AS original_product_id,original_product.name AS original_product_name,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'productId',allowed.product_id,'name',product.name,
          'isOriginal',allowed.product_id=definition.product_id,
          'configuredReason',substitute.reason
        ) ORDER BY (allowed.product_id=definition.product_id) DESC,substitute.priority,product.name,product.id)
        FROM mbox.benefit_allowed_products allowed
        JOIN mbox.products product
          ON product.tenant_id=allowed.tenant_id AND product.store_id=allowed.store_id
         AND product.id=allowed.product_id AND product.status='active'
        LEFT JOIN mbox.loyalty_annual_benefit_rule_substitutes substitute
          ON substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id
         AND substitute.rule_id=rule.id AND substitute.product_id=allowed.product_id
        WHERE allowed.tenant_id=benefit.tenant_id AND allowed.store_id=benefit.store_id
          AND allowed.benefit_id=benefit.id
      ),'[]'::jsonb) AS allowed_products
    FROM mbox.benefit_reservations reservation
    JOIN mbox.benefits benefit
      ON benefit.tenant_id=reservation.tenant_id AND benefit.store_id=reservation.store_id
     AND benefit.id=reservation.benefit_id AND benefit.benefit_type='gift_product'
    JOIN mbox.membership_annual_benefit_grants grant_row
      ON grant_row.tenant_id=benefit.tenant_id AND grant_row.store_id=benefit.store_id
     AND grant_row.benefit_id=benefit.id AND grant_row.status='active'
    JOIN mbox.loyalty_annual_benefit_rules rule
      ON rule.tenant_id=grant_row.tenant_id AND rule.store_id=grant_row.store_id
     AND rule.id=grant_row.rule_id AND rule.rule_kind IN ('birthday','festival')
    JOIN mbox.loyalty_benefit_definitions definition
      ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id
     AND definition.id=rule.benefit_definition_id AND definition.product_id IS NOT NULL
    JOIN mbox.products original_product
      ON original_product.tenant_id=definition.tenant_id AND original_product.store_id=definition.store_id
     AND original_product.id=definition.product_id
    JOIN mbox.table_sessions session
      ON session.tenant_id=reservation.tenant_id AND session.store_id=reservation.store_id
     AND session.id=reservation.table_session_id AND session.status IN ('open','closing')
    JOIN mbox.tables venue_table
      ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
     AND venue_table.id=session.table_id
    LEFT JOIN mbox.customer_memberships membership
      ON membership.tenant_id=reservation.tenant_id AND membership.store_id=reservation.store_id
     AND membership.customer_id=reservation.customer_id
    LEFT JOIN mbox.customer_profiles profile
      ON profile.tenant_id=reservation.tenant_id AND profile.store_id=reservation.store_id
     AND profile.customer_id=reservation.customer_id
    WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
      AND reservation.status='reserved' AND reservation.expires_at>clock_timestamp()
      AND ($3::uuid IS NULL OR reservation.table_session_id=$3::uuid)
      AND ($5::uuid IS NULL OR reservation.id=$5::uuid)
      AND EXISTS (
        SELECT 1 FROM mbox.employees employee
        WHERE employee.tenant_id=reservation.tenant_id AND employee.store_id=reservation.store_id
          AND employee.id=$4::uuid AND employee.status='active'
          AND (
            mbox.employee_has_effective_permission(employee.tenant_id,employee.store_id,employee.id,'table.view_all')
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
    ORDER BY reservation.reserved_at,reservation.id
    LIMIT 200
  `, [transaction.scope.tenantId,transaction.scope.storeId,tableSessionId,employeeId,reservationId])
  return result.rows.map((row) => ({
    reservationId:row.reservation_id,benefitId:row.benefit_id,customerId:row.customer_id,
    tableSessionId:row.table_session_id,tableCode:row.table_code,memberNo:row.member_no,
    customerName:row.customer_name,ruleKind:row.rule_kind,title:row.rule_title,quantity:Number(row.quantity),
    reservedAt:row.reserved_at,expiresAt:row.expires_at,originalProductId:row.original_product_id,
    originalProductName:row.original_product_name,allowedProducts:row.allowed_products,
  }))
}

async function listComplimentaryFulfillmentExceptions(
  transaction:ScopedTransaction,
  employeeId:string,
) {
  const result=await transaction.query<ComplimentaryFulfillmentExceptionRow>(`
    SELECT intent.id,intent.order_id,intent.benefit_id,order_row.table_session_id,
      venue_table.code AS table_code,order_row.public_id AS order_public_id,intent.status,
      intent.attempt_count,intent.last_error_code,intent.last_error_at::text,
      membership.member_no,profile.display_name AS customer_name,rule.title,intent.updated_at::text
    FROM mbox.complimentary_fulfillment_intents intent
    JOIN mbox.orders order_row
      ON order_row.tenant_id=intent.tenant_id AND order_row.store_id=intent.store_id
     AND order_row.id=intent.order_id
    JOIN mbox.table_sessions session
      ON session.tenant_id=order_row.tenant_id AND session.store_id=order_row.store_id
     AND session.id=order_row.table_session_id
    JOIN mbox.tables venue_table
      ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
     AND venue_table.id=session.table_id
    LEFT JOIN mbox.membership_annual_benefit_grants grant_row
      ON grant_row.tenant_id=intent.tenant_id AND grant_row.store_id=intent.store_id
     AND grant_row.benefit_id=intent.benefit_id
    LEFT JOIN mbox.loyalty_annual_benefit_rules rule
      ON rule.tenant_id=grant_row.tenant_id AND rule.store_id=grant_row.store_id
     AND rule.id=grant_row.rule_id
    LEFT JOIN mbox.customer_memberships membership
      ON membership.tenant_id=grant_row.tenant_id AND membership.store_id=grant_row.store_id
     AND membership.id=grant_row.membership_id
    LEFT JOIN mbox.customer_profiles profile
      ON profile.tenant_id=membership.tenant_id AND profile.store_id=membership.store_id
     AND profile.customer_id=membership.customer_id
    WHERE intent.tenant_id=$1::uuid AND intent.store_id=$2::uuid
      AND intent.status IN ('retry','failed')
      AND EXISTS (
        SELECT 1 FROM mbox.employees employee
        WHERE employee.tenant_id=intent.tenant_id AND employee.store_id=intent.store_id
          AND employee.id=$3::uuid AND employee.status='active'
          AND (
            mbox.employee_has_effective_permission(employee.tenant_id,employee.store_id,employee.id,'table.view_all')
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
    ORDER BY (intent.status='failed') DESC,intent.last_error_at,intent.id
    LIMIT 200
  `,[transaction.scope.tenantId,transaction.scope.storeId,employeeId])
  return result.rows.map((row) => ({
    id:row.id,orderId:row.order_id,benefitId:row.benefit_id,tableSessionId:row.table_session_id,
    tableCode:row.table_code,orderPublicId:row.order_public_id,status:row.status,
    attemptCount:Number(row.attempt_count),lastErrorCode:row.last_error_code,lastErrorAt:row.last_error_at,
    memberNo:row.member_no,customerName:row.customer_name,title:row.title,updatedAt:row.updated_at,
  }))
}

function benefitRepository(options: CustomerBenefitApiOptions, transaction: ScopedTransaction): BenefitRepository {
  return options.createBenefitRepository?.(transaction) ?? new BenefitRepository(transaction)
}

function staffAccess(
  options: CustomerBenefitApiOptions,
  transaction: ScopedTransaction,
): Pick<StaffAccessRepository, 'assertPermission'> {
  return options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
}

function toPublicBenefit(benefit: Awaited<ReturnType<BenefitRepository['listAvailableForCustomer']>>[number]) {
  return {
    id: benefit.id,
    code: benefit.benefitCode,
    type: benefit.benefitType,
    valueAmountMinor: benefit.valueAmountMinor,
    currency: benefit.currency,
    display: publicDisplay(benefit.benefitSnapshot),
    quantityAvailable: benefit.quantityAvailable,
    validFrom: benefit.validFrom,
    validUntil: benefit.validUntil,
  }
}

function toStaffBenefit(benefit: Awaited<ReturnType<BenefitRepository['issue']>>) {
  return { ...toPublicBenefit(benefit), customerId: benefit.customerId, status: benefit.status,
    issuedByEmployeeId: benefit.issuedByEmployeeId, issuanceReason: benefit.issuanceReason }
}

function publicDisplay(snapshot: JsonObject): JsonObject {
  const display = snapshot.publicDisplay
  return isObject(display) ? display : {}
}

function toPublicReservation(value: { id: string; benefitId: string; quantity: number; status: string; expiresAt: string }) {
  return { id: value.id, benefitId: value.benefitId, quantity: value.quantity,
    status: value.status, expiresAt: value.expiresAt }
}

function toStaffCustomer(customer: Awaited<ReturnType<CustomerRepository['resolveCanonical']>>) {
  return {
    id: customer.id,
    publicId: customer.publicId,
    status: customer.status,
    firstSeenAt: customer.firstSeenAt,
    lastSeenAt: customer.lastSeenAt,
    profile: customer.profile,
    identityKinds: customer.identities.filter((identity) => identity.status === 'active')
      .map((identity) => identity.kind),
  }
}

function readIssueBenefit(body: JsonObject) {
  const authorizationLimitId = readString(body.authorizationLimitId, '审批额度来源', 64, 8)
  const validFrom = readOptionalTimestamp(body.validFrom, '生效时间')
  const validUntil = readOptionalTimestamp(body.validUntil, '失效时间')
  const benefitSnapshot = readOptionalObject(body.benefitSnapshot)
  if ('allowedProductIds' in benefitSnapshot) {
    throw new CustomerBenefitRequestError('适用商品必须使用强类型allowedProductIds字段，不能写入权益快照')
  }
  return {
    customerId: readString(body.customerId, '客户', 64, 8),
    benefitCode: readString(body.benefitCode, '权益编码', 64, 2),
    benefitType: readEnum(body.benefitType, ['gift_product', 'discount', 'credit', 'access', 'other'], '权益类型'),
    valueAmountMinor: readOptionalInteger(body.valueAmountMinor, '权益金额', 0, Number.MAX_SAFE_INTEGER),
    currency: readOptionalString(body.currency, '币种', 3, 3),
    quantity: readInteger(body.quantity, '数量', 1, 10_000, 1),
    allowedProductIds: readStringArray(body.allowedProductIds, '适用商品') ?? [],
    benefitSnapshot,
    ...(validFrom === null ? {} : { validFrom }),
    ...(validUntil === null ? {} : { validUntil }),
    authorizationLimitId,
    reason: readString(body.reason, '赠送原因', 256, 2),
    authorizationSource: { kind: 'role_approval_limit', approvalLimitId: authorizationLimitId },
  }
}

function readProfile(value: unknown) {
  const body = readObject(value)
  if ('consentSnapshot' in body) {
    throw new CustomerBenefitRequestError('通知同意不能写入自由JSON客户资料，必须由受控渠道记录强类型决定')
  }
  return {
    displayName: readOptionalString(body.displayName, '称呼', 128, 1),
    tags: readStringArray(body.tags, '标签'),
    publicTags: readStringArray(body.publicTags, '公开标签'),
    preferences: readOptionalObject(body.preferences),
    publicPreferenceKeys: readStringArray(body.publicPreferenceKeys, '公开偏好键'),
  }
}

async function handleRoute(reply: FastifyReply, operation: () => Promise<FastifyReply>): Promise<FastifyReply> {
  try { return await operation() } catch (error) {
    const mapped = mapError(error)
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function mapError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (error instanceof NormalizedAuthenticationRequiredError || error instanceof StaffSessionNotFoundError
    || error instanceof GuestAuthenticationRequiredError || error instanceof GuestDeviceBindingError
    || error instanceof ReservationGuestSessionInvalidError) {
    return apiError(401, 'CUSTOMER_BENEFIT_AUTH_REQUIRED', '登录或桌边会话已过期，请重新验证')
  }
  if (error instanceof TrustedStoreScopeError || error instanceof NormalizedStoreUnavailableError
    || error instanceof GuestStoreScopeError) {
    return apiError(403, 'CUSTOMER_BENEFIT_STORE_FORBIDDEN', '当前门店不可用或无权访问')
  }
  if (error instanceof StaffAccessDeniedError || error instanceof BenefitAuthorizationError) {
    return apiError(403, 'CUSTOMER_BENEFIT_FORBIDDEN', '当前账号无权执行此操作，或赠送额度不足')
  }
  if (error instanceof EmployeeTableAccessDeniedError) {
    return apiError(403, 'CUSTOMER_BENEFIT_TABLE_FORBIDDEN', '当前员工不是该桌负责人，无权处理该桌权益')
  }
  if (error instanceof CustomerNotFoundError || error instanceof BenefitNotFoundError
    || error instanceof BenefitReservationNotFoundError) {
    return apiError(404, 'CUSTOMER_BENEFIT_NOT_FOUND', '客户或权益不存在')
  }
  if (error instanceof BenefitOwnershipError) {
    return apiError(403, 'BENEFIT_OWNERSHIP_MISMATCH', '该权益不属于当前桌次客户')
  }
  if (error instanceof BenefitUnavailableError) {
    return apiError(409, 'BENEFIT_UNAVAILABLE', '权益已过期、已用完或状态已变化')
  }
  if (error instanceof BenefitIdempotencyConflictError || error instanceof CustomerIdentityConflictError
    || error instanceof CustomerMergeConflictError) {
    return apiError(409, 'CUSTOMER_BENEFIT_CONFLICT', error.message)
  }
  if (error instanceof AnnualDailySnackClaimError) {
    return apiError(error.statusCode, error.code, error.message)
  }
  if (error instanceof ComplimentaryFulfillmentResolutionError) {
    if (error.code === 'COMPLIMENTARY_FULFILLMENT_NOT_FOUND') {
      return apiError(404,error.code,error.message)
    }
    if (error.code === 'COMPLIMENTARY_FULFILLMENT_REQUEST_INVALID') {
      return apiError(400,error.code,error.message)
    }
    return apiError(409,error.code,error.message)
  }
  if (error instanceof CustomerBenefitRequestError || error instanceof TypeError) {
    return apiError(400, 'CUSTOMER_BENEFIT_REQUEST_INVALID', error.message)
  }
  return apiError(500, 'CUSTOMER_BENEFIT_INTERNAL_ERROR', '客户权益服务暂时不可用，请稍后再试')
}

function privateNoStore(reply: FastifyReply): void {
  reply.header('cache-control', 'private, no-store')
  reply.header('pragma', 'no-cache')
}

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } }
}

function readObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new CustomerBenefitRequestError('请求内容格式不正确')
  return value as JsonObject
}

function readOptionalObject(value: unknown): JsonObject {
  return value === undefined || value === null ? {} : readObject(value)
}

function readRouteId(value: unknown, key: string): string {
  const params = readObject(value)
  return readString(params[key], key, 128, 1)
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new CustomerBenefitRequestError('缺少有效的幂等请求标识')
  }
  return value
}

function readString(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new CustomerBenefitRequestError(`${label}格式不正确`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new CustomerBenefitRequestError(`${label}长度不正确`)
  }
  return normalized
}

function optionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = readString(value, label, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new CustomerBenefitRequestError(`${label}格式不正确`)
  }
  return parsed
}

function readOptionalString(value: unknown, label: string, maximum: number, minimum = 1): string | null {
  return value === undefined || value === null ? null : readString(value, label, maximum, minimum)
}

function readInteger(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CustomerBenefitRequestError(`${label}必须是有效整数`)
  }
  return value as number
}

function readOptionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | null {
  return value === undefined || value === null ? null : readInteger(value, label, minimum, maximum, minimum)
}

function readTimestamp(value: unknown, label: string): string {
  const timestamp = readString(value, label, 64, 10)
  if (!Number.isFinite(Date.parse(timestamp))) throw new CustomerBenefitRequestError(`${label}格式不正确`)
  return timestamp
}

function readOptionalTimestamp(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : readTimestamp(value, label)
}

function readStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== 'string')) {
    throw new CustomerBenefitRequestError(`${label}格式不正确`)
  }
  return value as string[]
}

function readIdentityKind(value: unknown): CustomerIdentityKind {
  return readEnum(value, ['anonymous', 'wechat', 'member', 'manual'], '身份类型')
}

function readHash(value: unknown): string {
  const hash = readString(value, '身份摘要', 64, 64)
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new CustomerBenefitRequestError('身份摘要格式不正确')
  return hash
}

function readEnum<const Value extends string>(value: unknown, values: readonly Value[], label: string): Value {
  if (typeof value !== 'string' || !values.includes(value as Value)) {
    throw new CustomerBenefitRequestError(`${label}不正确`)
  }
  return value as Value
}

function readLimit(query: unknown): number {
  if (!isObject(query) || query.limit === undefined) return 50
  const value = Number(query.limit)
  return Number.isSafeInteger(value) && value >= 1 && value <= 200 ? value : 50
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function reservationExpiresAt(options: CustomerBenefitApiOptions): string {
  const now = options.now?.() ?? new Date()
  return new Date(now.getTime() + 15 * 60_000).toISOString()
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isObject(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`
  return JSON.stringify(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
