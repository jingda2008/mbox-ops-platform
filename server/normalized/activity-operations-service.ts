import {readDraftRoster,saveDraftRoster} from './ticket-draft-roster.js'
import {planTicketCashRefund} from './table-ticket-auto-review.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {publicTableTickets} from './table-ticket-purchase.js'
import {ActivityOperationsError} from './activity-operations-repository.js'
import {proposeTicketDining,type DiningSplit} from './table-ticket-dining.js'
import {correctTicketGift} from './table-ticket-correction.js'
import {ticketReception,assignTicketTable,admitTicketBatch,updateTicketContact} from './table-ticket-reception.js'
import {requestTicketRefund,decideTicketCase,submitTicketCashRefund} from './table-ticket-refund.js'
import { approveEventTicketTerms,type EventTicketTerms,saveTicketOffer, ticketOfferCatalog, type TableTicketOfferInput } from './table-ticket-offer-repository.js'
import {readRefundApprovalLimits} from './refund-approval-limits.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {refundReviewBlockReason} from '../../src/shared/refund-review-availability.js'
import { staffAuthorizedCommands } from './staff-authorized-command.js'
import {ActivityServiceRepository} from './activity-service-repository.js'
import type {ActivityDoorCommand} from '../../src/shared/activity-service.js'
import { createHash } from 'node:crypto'
import type {
  AuditEvent,
  CommandExecution,
  JsonCodec,
  JsonValue,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { assertEmployeeEffectivePermission } from './employee-table-access.js'
import {
  ActivityOperationsRepository,
  type ActivityDraftInput,
  type ActivityOperationsActivity,
  type ActivityOperationsRegistration,
  type ActivityPackageAvailabilityOperation,
  type ActivityRegistrationOperation,
  type ActivityWaitlistRetry,
} from './activity-operations-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface ActivityOperationsStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export class ActivityOperationsService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly commands: Pick<NormalizedCommandExecutor,'execute'>,
    private readonly ticketPhones?: ActivityContactProtectionKeyring,
  ) {}

  serviceView(context:ActivityOperationsStaffContext,publicId:string){return this.transactions.run(context.scope,tx=>new ActivityServiceRepository(tx).view(publicId),{readOnly:true})}
  scanService(context:ActivityOperationsStaffContext,code:string){return this.transactions.run(context.scope,tx=>new ActivityServiceRepository(tx).scan(code),{readOnly:true})}
  serviceCommand(context:ActivityOperationsStaffContext,publicId:string,command:ActivityDoorCommand,key:string){return staffAuthorizedCommands(this.commands, context.employeeId, ['recover','restore_plaque'].includes(command.action) ? 'community.activity.manage' : ['community.activity.manage','community.activity.verify'], true).execute({scope:context.scope,operationScope:'activity.service.door',idempotencyKey:key,requestFingerprint:JSON.stringify({employeeId:context.employeeId,publicId,command}),resultCodec:objectCodec<import('../../src/shared/activity-service.js').ActivityServiceView>(),retainReceipt:true},async tx=>{const result=await new ActivityServiceRepository(tx).door(publicId,command,key,context.employeeId,context.businessDate);return {result,auditEvents:[audit(context,{action:`activity.service.${command.action}`,objectType:'community_activity_registration',objectId:publicId,afterData:{action:command.action,arrivedCount:command.arrivedCount??0}})],outboxMessages:[]}})}

  ticketReception(context:ActivityOperationsStaffContext,activity:string) {
    return this.transactions.run(context.scope,tx=>ticketReception(tx,activity),{readOnly:true})
  }

  ticketFrontDesk(context:ActivityOperationsStaffContext,id:string,input:{status:string}|{code:string;quantity:number},key:string) {
    const door='code' in input
    return staffAuthorizedCommands(this.commands,context.employeeId,['community.activity.verify','community.activity.manage']).execute({
      scope:context.scope,operationScope:door?'table_ticket.admit':'table_ticket.contact',idempotencyKey:key,
      requestFingerprint:fingerprint({id,input,actor:context.employeeId}),retainReceipt:true,resultCodec:objectCodec<{id:string}>(),
    },async tx=>{
      const result='code' in input?await admitTicketBatch(tx,id,input.code,input.quantity,context.employeeId,key):await updateTicketContact(tx,id,input.status,context.employeeId)
      return {result,auditEvents:[audit(context,{action:door?'table_ticket.admitted':'table_ticket.contact',objectType:door?'table_ticket':'community_activity_registration',objectId:result.id,
        afterData:'code' in input?{quantity:input.quantity}:{status:input.status}})],outboxMessages:[]}
    })
  }

  assignTicket(context:ActivityOperationsStaffContext,id:string,tableId:string,reservation:string|null,key:string) {
    return staffAuthorizedCommands(this.commands,context.employeeId,['community.activity.verify','community.activity.manage']).execute({
      scope:context.scope,operationScope:'table_ticket.assign',idempotencyKey:key,requestFingerprint:fingerprint({id,tableId,reservation}),
      retainReceipt:true,resultCodec:objectCodec<{id:string;tableId:string}>(),
    },async tx=>{
      const result=await assignTicketTable(tx,id,tableId,context.employeeId,reservation)
      return {result,auditEvents:[audit(context,{action:'table_ticket.assigned',objectType:'table_ticket',objectId:id,afterData:{tableId,reservation}})],outboxMessages:[]}
    })
  }

  offerTicketToMember(context:ActivityOperationsStaffContext,offerId:string,quantity:number,phone:string,key:string) {
    if(!this.ticketPhones)throw new ActivityOperationsError('会员手机号核对暂不可用','TICKET_PHONE_UNAVAILABLE',503)
    const protectedPhone=this.ticketPhones.protectPhone('+86'+phone)
    return staffAuthorizedCommands(this.commands,context.employeeId,['community.activity.verify','community.activity.manage']).execute({
      scope:context.scope,operationScope:'table_ticket.assistance',idempotencyKey:key,
      requestFingerprint:fingerprint({offerId,quantity,contact:protectedPhone.contactHash,employee:context.employeeId}),
      retainReceipt:true,resultCodec:objectCodec<{id:string}>(),
    },async tx=>{
      const offer=(await publicTableTickets(tx)).find(item=>item.id===offerId)
      if(!offer)throw new ActivityOperationsError('请重新选择有余量的在售票档','TICKET_OFFER_CHANGED',409)
      const result=(await tx.query<{id:string}>(`INSERT INTO mbox.table_ticket_assistance(tenant_id,store_id,employee_id,offer_id,quantity,phone_hashes)
        VALUES($1,$2,$3,$4,$5,$6::text[]) RETURNING id`,[context.scope.tenantId,context.scope.storeId,context.employeeId,offerId,quantity,protectedPhone.matchHashes])).rows[0]!
      return {result,auditEvents:[audit(context,{action:'table_ticket.assisted',objectType:'table_ticket_assistance',objectId:result.id,afterData:{offerId,quantity}})],outboxMessages:[]}
    })
  }

  proposeTicketDining(context:ActivityOperationsStaffContext,id:string,reason:string,key:string,split?:DiningSplit,refundAmountMinor?:number) {
    return staffAuthorizedCommands(this.commands,context.employeeId,'refund.approve').execute({
      scope:context.scope,operationScope:'table_ticket.dining.propose',idempotencyKey:key,requestFingerprint:fingerprint({id,reason,...(split&&{split}),refundAmountMinor,employee:context.employeeId}),
      retainReceipt:true,resultCodec:objectCodec<{caseId:string;amountMinor:number}>(),
    },async tx=>{
      const result=await proposeTicketDining(tx,id,context.employeeId,reason,split)
      if(refundAmountMinor!==undefined)await planTicketCashRefund(tx,id,context.employeeId,refundAmountMinor,true)
      return {result,auditEvents:[audit(context,{action:'table_ticket.dining.proposed',objectType:'table_ticket_refund',objectId:id,afterData:{reason,amountMinor:result.amountMinor,...split,...(refundAmountMinor!==undefined && {refundAmountMinor})}})],outboxMessages:[]}
    })
  }

  changeTicketGift(context:ActivityOperationsStaffContext,id:string,reason:string,action:'request'|'approve'|'reject',caseId:string|null,key:string,merchantAssumes=false,buyerUse=false) {
    return staffAuthorizedCommands(this.commands,context.employeeId,'loyalty.adjust.manual').execute({
      scope:context.scope,operationScope:'table_ticket.correction',idempotencyKey:key,requestFingerprint:fingerprint({id,reason,action,caseId,merchantAssumes,buyerUse,employee:context.employeeId}),
      retainReceipt:true,resultCodec:objectCodec<{id:string;status:string}>(),
    },async tx=>{
      const result=await correctTicketGift(tx,id,context.employeeId,reason,action,caseId,merchantAssumes,buyerUse)
      return {result,auditEvents:[audit(context,{action:'table_ticket.correction.'+action,objectType:'table_ticket',objectId:id,afterData:{reason,caseId:result.id}})],outboxMessages:[]}
    })
  }

  closeTicketCase(context:ActivityOperationsStaffContext,id:string,action:'rejected'|'zero'|'cancelled',reason:string,key:string){
    return staffAuthorizedCommands(this.commands,context.employeeId,'refund.approve').execute({
      scope:context.scope,operationScope:'table_ticket.disposition',idempotencyKey:key,requestFingerprint:fingerprint({id,action,reason,actor:context.employeeId}),
      retainReceipt:true,resultCodec:objectCodec<{id:string;status:string}>(),
    },async tx=>{
      await new StaffAccessRepository(tx).assertPermission(context.employeeId,'refund.request')
      const price=(await tx.query<{price_minor:number}>(`SELECT o.price_minor FROM mbox.table_tickets k JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
        JOIN mbox.table_ticket_offers o ON(o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id) WHERE k.tenant_id=$1 AND k.store_id=$2 AND k.id=$3`,
        [context.scope.tenantId,context.scope.storeId,id])).rows[0]
      if(!price || ((await readRefundApprovalLimits(tx,context.employeeId)).CNY??0)<price.price_minor)throw new ActivityOperationsError('请按原票价值提交有额度的审批人','TICKET_CASE_LIMIT',403)
      const result=await decideTicketCase(tx,id,{employee:context.employeeId},action,reason)
      return {result,auditEvents:[audit(context,{action:'table_ticket.disposition',objectType:'table_ticket',objectId:id,afterData:{action,reason,status:result.status}})],outboxMessages:[]}
    })
  }

  openStaffTicketRefund(context:ActivityOperationsStaffContext,id:string,reason:string,key:string,previewVersion?:string,refundAmountMinor?:number,merchant=false) {
    return staffAuthorizedCommands(this.commands,context.employeeId,'refund.request').execute({
      scope:context.scope,operationScope:'table_ticket.refund.open',idempotencyKey:key,requestFingerprint:fingerprint({id,reason,employee:context.employeeId,previewVersion,refundAmountMinor,...(merchant && {merchant})}),
      retainReceipt:true,resultCodec:objectCodec<{caseId:string;status:string}>(),
    },async tx=>{
      const identity=(await tx.query<{registration_id:string;customer_id:string}>(`SELECT k.registration_id,r.customer_id FROM mbox.table_tickets k
        JOIN mbox.community_activity_registrations r ON(r.tenant_id,r.store_id,r.id)=(k.tenant_id,k.store_id,k.registration_id)
        WHERE k.tenant_id=$1 AND k.store_id=$2 AND k.id=$3`,[context.scope.tenantId,context.scope.storeId,id])).rows[0]
      if(!identity)throw new ActivityOperationsError('原票不存在','TICKET_NOT_FOUND',404)
      if(merchant)await new StaffAccessRepository(tx).assertPermission(context.employeeId,'community.activity.manage')
      const result=await requestTicketRefund(tx,identity.registration_id,id,identity.customer_id,reason,previewVersion,merchant)
      if(refundAmountMinor!==undefined && result.status==='review')await planTicketCashRefund(tx,result.caseId,context.employeeId,refundAmountMinor)
      return {result,auditEvents:[audit(context,{action:'table_ticket.refund.opened',objectType:'table_ticket',objectId:id,afterData:{reason,...(merchant && {cause:'merchant'}),caseId:result.caseId,...(refundAmountMinor!==undefined && {refundAmountMinor})}})],outboxMessages:[]}
    })
  }

  submitTicketRefund(context:ActivityOperationsStaffContext,id:string,amount:number,merchantReason:string|null,key:string) {
    return staffAuthorizedCommands(this.commands,context.employeeId,'refund.request').execute({
      scope:context.scope,operationScope:'table_ticket.refund.submit',idempotencyKey:key,requestFingerprint:fingerprint({id,amount,merchantReason}),
      retainReceipt:true,resultCodec:objectCodec<{caseId:string;refundId:string}>(),
    },async tx=>{
      if(merchantReason)await new StaffAccessRepository(tx).assertPermission(context.employeeId,'community.activity.manage')
      const result=await submitTicketCashRefund(tx,id,context.employeeId,amount,merchantReason)
      return {result,auditEvents:[audit(context,{action:'table_ticket.refund.submitted',objectType:'refund',objectId:result.refundId,afterData:{caseId:id,amount,merchantReason}})],outboxMessages:[]}
    })
  }

  approveTicketTerms(context:ActivityOperationsStaffContext,id:string,input:EventTicketTerms,version:number,key:string){
    return staffAuthorizedCommands(this.commands,context.employeeId,'community.activity.publish').execute({
      scope:context.scope,operationScope:'table_ticket.terms',idempotencyKey:key,requestFingerprint:fingerprint({id,input,version,employee:context.employeeId}),retainReceipt:true,resultCodec:objectCodec<{id:string;version:number}>()
    },async tx=>{
      const result=await approveEventTicketTerms(tx,id,context.employeeId,input,version)
      return {result,auditEvents:[audit(context,{action:'table_ticket.terms.approved',objectType:'table_ticket_event_terms',objectId:result.id,afterData:{version:result.version}})],outboxMessages:[]}
    })
  }

  draftRoster(context: ActivityOperationsStaffContext, areaId: string) {
    return this.transactions.run(context.scope, tx=>readDraftRoster(tx,areaId), {readOnly:true})
  }

  updateDraftRoster(context: ActivityOperationsStaffContext, areaId: string, revision: string, tableIds: string[], key: string) {
    return staffAuthorizedCommands(this.commands,context.employeeId,'community.activity.manage').execute({
      scope:context.scope, operationScope:'community.table_ticket.draft_roster', idempotencyKey:key,
      requestFingerprint:fingerprint({areaId,revision,tableIds,actor:context.employeeId}),
      resultCodec:objectCodec<{areaId:string;tableIds:string[]}>(), retainReceipt:true,
    }, async tx=>{
      const result=await saveDraftRoster(tx,areaId,revision,tableIds)
      return {result,auditEvents:[audit(context,{action:'community.table_ticket.draft_roster_saved',
        objectType:'area',objectId:areaId,afterData:{revision,tableIds}})],outboxMessages:[]}
    })
  }

  ticketOffers(context: ActivityOperationsStaffContext, publicId: string) {
    return this.transactions.run(context.scope, tx => ticketOfferCatalog(tx, publicId), {readOnly:true})
  }

  saveTicketOffer(context: ActivityOperationsStaffContext, publicId: string, input: TableTicketOfferInput, key: string) {
    const permission = input.status === 'draft' ? 'community.activity.manage' : 'community.activity.publish'
    return staffAuthorizedCommands(this.commands,context.employeeId,permission).execute({
      scope:context.scope, operationScope:'community.table_ticket.offer', idempotencyKey:key,
      requestFingerprint:fingerprint({publicId,input,actor:context.employeeId}),
      resultCodec:objectCodec<{id:string;version:number;status:string}>(), retainReceipt:true,
    }, async tx => {
      const result = await saveTicketOffer(tx,publicId,context.employeeId,input)
      return {result,auditEvents:[audit(context,{action:'community.table_ticket.offer_saved',
        objectType:'table_ticket_offer',objectId:result.id,afterData:{...input,version:result.version}})],outboxMessages:[]}
    })
  }

  list(context: ActivityOperationsStaffContext, ticketsOnly=false) {
    return this.transactions.run(
      context.scope,
      (transaction) => new ActivityOperationsRepository(transaction).list(ticketsOnly),
      { readOnly: true },
    )
  }

  productCatalog(context:ActivityOperationsStaffContext){return this.transactions.run(context.scope,tx=>new ActivityOperationsRepository(tx).productCatalog(),{readOnly:true})}

  componentCatalog(context: ActivityOperationsStaffContext) {
    return this.transactions.run(
      context.scope,
      (transaction) => new ActivityOperationsRepository(transaction).componentCatalog(),
      { readOnly: true },
    )
  }

  detail(context: ActivityOperationsStaffContext, publicId: string) {
    return this.transactions.run(
      context.scope,
      async transaction => {
        const detail=await new ActivityOperationsRepository(transaction).detail(publicId)
        const access=await new StaffAccessRepository(transaction).resolve(context.employeeId)
        const canApproveRefund=access.permissions.includes('refund.approve')
        const refundApprovalLimits=canApproveRefund?await readRefundApprovalLimits(transaction,context.employeeId):{}
        return {...detail,registrations:detail.registrations.map(registration=>({...registration,refund:registration.refund===null?null:{...registration.refund,
          reviewBlockReason:refundReviewBlockReason({canApproveRefund,refundApprovalLimits},{...registration.refund,currency:registration.currency},context.employeeId),
        }}))}
      },
      { readOnly: true },
    )
  }

  createDraft(
    context: ActivityOperationsStaffContext,
    input: Readonly<{ ticketRows?:Pick<TableTicketOfferInput,'areaId'|'name'|'priceMinor'|'giftPoints'>[]; draft: ActivityDraftInput; reason: string; idempotencyKey: string }>,
  ): Promise<CommandExecution<ActivityOperationsActivity>> {
    const publicId = `community-activity-${createHash('sha256')
      .update(`${context.scope.storeId}:${input.idempotencyKey}`)
      .digest('hex').slice(0, 24)}`
    return staffAuthorizedCommands(this.commands, context.employeeId, 'community.activity.manage').execute({
      scope: context.scope,
      operationScope: 'community.activity.draft.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ActivityOperationsActivity>(),
    }, async (transaction) => {
      const result = await new ActivityOperationsRepository(transaction)
        .createDraft(publicId, input.draft, context.employeeId)
      for(const row of input.ticketRows??[])await saveTicketOffer(transaction,publicId,context.employeeId,
        {...row,status:'draft',expectedVersion:0,visibleFrom:null,visibleUntil:null})
      return {
        result,
        auditEvents: [audit(context, {
          action: 'community.activity.draft_created',
          objectType: 'community_activity',
          objectId: publicId,
          reason: input.reason,
          afterData: {
            ...(input.ticketRows?{ticketRows:input.ticketRows}:{}),status: result.status,
            startsAt: result.startsAt,
            endsAt: result.endsAt,
            capacity: result.capacity,
            paymentMode: result.paymentMode,
            feeAmountMinor: result.feeAmountMinor,
          },
        })],
        outboxMessages: [],
      }
    })
  }

  updateDraft(
    context: ActivityOperationsStaffContext,
    input: Readonly<{ publicId: string; draft: ActivityDraftInput; reason: string; idempotencyKey: string }>,
  ): Promise<CommandExecution<ActivityOperationsActivity>> {
    return staffAuthorizedCommands(this.commands, context.employeeId, 'community.activity.manage').execute({
      scope: context.scope,
      operationScope: 'community.activity.draft.update',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ActivityOperationsActivity>(),
    }, async (transaction) => {
      const result = await new ActivityOperationsRepository(transaction).updateDraft(input.publicId, input.draft)
      return {
        result,
        auditEvents: [audit(context, {
          action: 'community.activity.draft_updated',
          objectType: 'community_activity',
          objectId: input.publicId,
          reason: input.reason,
          afterData: {
            status: result.status,
            startsAt: result.startsAt,
            endsAt: result.endsAt,
            capacity: result.capacity,
            paymentMode: result.paymentMode,
            feeAmountMinor: result.feeAmountMinor,
            refundPolicyVersion: result.refundPolicyVersion,
            safetyPolicyVersion: result.safetyPolicyVersion,
          },
        })],
        outboxMessages: [],
      }
    })
  }

  setPackageAvailability(
    context: ActivityOperationsStaffContext,
    input: Readonly<{
      activityPublicId: string
      packagePublicId: string
      operation: ActivityPackageAvailabilityOperation
      reason: string
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<ActivityOperationsActivity>> {
    return staffAuthorizedCommands(this.commands, context.employeeId, 'community.activity.manage').execute({
      scope: context.scope,
      operationScope: `community.activity.package.${input.operation}`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ActivityOperationsActivity>(),
    }, async (transaction) => {
      const result = await new ActivityOperationsRepository(transaction).setPackageAvailability(
        input.activityPublicId,input.packagePublicId,input.operation,
      )
      return {
        result,
        auditEvents: [audit(context, {
          action: `community.activity.package_${input.operation}`,
          objectType: 'community_activity_package',
          objectId: input.packagePublicId,
          reason: input.reason,
          afterData: { activityPublicId: input.activityPublicId, operation: input.operation },
        })],
        outboxMessages: [],
      }
    })
  }

  stopRegistration(context:ActivityOperationsStaffContext,input:Readonly<{publicId:string;reason:string;idempotencyKey:string}>):Promise<CommandExecution<ActivityOperationsActivity>> {
    return staffAuthorizedCommands(this.commands, context.employeeId, 'community.activity.manage').execute({scope:context.scope,operationScope:'community.activity.stop-registration',
      idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint(input),resultCodec:objectCodec<ActivityOperationsActivity>()},async transaction=>{
      await assertEmployeeEffectivePermission(transaction,context.employeeId,'community.activity.manage')
      const result=await new ActivityOperationsRepository(transaction).stopRegistration(input.publicId)
      return {result,auditEvents:[audit(context,{action:'community.activity.registration_stopped',objectType:'community_activity',objectId:input.publicId,reason:input.reason,afterData:{registrationClosedAt:result.registrationClosedAt??null}})],outboxMessages:[]}
    })
  }

  closeActivity(context: ActivityOperationsStaffContext, input: Readonly<{
    publicId: string; status: 'cancelled' | 'completed'; reason: string; idempotencyKey: string
  }>): Promise<CommandExecution<ActivityOperationsActivity>> {
    return staffAuthorizedCommands(this.commands, context.employeeId, 'community.activity.manage').execute({scope: context.scope, operationScope: 'community.activity.close',
      idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint(input), resultCodec: objectCodec<ActivityOperationsActivity>(),
    }, async transaction => {
      await assertEmployeeEffectivePermission(transaction,context.employeeId,'community.activity.manage')
      const result = await new ActivityOperationsRepository(transaction).closeActivity(input.publicId,input.status)
      return { result, auditEvents: [audit(context,{action:'community.activity.closed',objectType:'community_activity',
        objectId:input.publicId,reason:input.reason,afterData:{status:result.status}})],outboxMessages:[] }
    })
  }

  transitionRegistration(
    context: ActivityOperationsStaffContext,
    input: Readonly<{
      publicId: string
      operation: ActivityRegistrationOperation
      reason: string
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<ActivityOperationsRegistration>> {
    const operationCode = input.operation === 'check_in'
      ? 'check-in'
      : input.operation === 'fulfill_package' ? 'fulfill-package'
        : input.operation === 'no_show' ? 'no-show' : 'cancel'
    return staffAuthorizedCommands(this.commands, context.employeeId, 'community.activity.manage').execute({
      scope: context.scope,
      operationScope: `community.activity.registration.${operationCode}`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ActivityOperationsRegistration>(),
    }, async (transaction) => {
      const result = await new ActivityOperationsRepository(transaction)
        .transitionRegistration(input.publicId, input.operation, input.reason, context.employeeId)
      return {
        result,
        auditEvents: [audit(context, {
          action: `community.activity.registration.${operationCode}`,
          objectType: 'community_activity_registration',
          objectId: input.publicId,
          reason: input.reason,
          afterData: {
            status: result.status,
            paymentStatus: result.paymentStatus,
            partySize: result.partySize,
          },
        })],
        outboxMessages: [],
      }
    })
  }

  retryWaitlistPromotion(
    context: ActivityOperationsStaffContext,
    input: Readonly<{ publicId: string; reason: string; idempotencyKey: string }>,
  ): Promise<CommandExecution<ActivityWaitlistRetry>> {
    return staffAuthorizedCommands(this.commands, context.employeeId, 'community.activity.manage').execute({
      scope: context.scope,
      operationScope: 'community.activity.waitlist.retry',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ActivityWaitlistRetry>(),
    }, async (transaction) => {
      const result = await new ActivityOperationsRepository(transaction)
        .retryWaitlistPromotion(input.publicId)
      return {
        result,
        auditEvents: [audit(context, {
          action: 'community.activity.waitlist_retry_requested',
          objectType: 'community_activity',
          objectId: input.publicId,
          reason: input.reason,
          afterData: { state: result.state, nextAttemptAt: result.nextAttemptAt },
        })],
        outboxMessages: [],
      }
    })
  }
}

function audit(
  context: ActivityOperationsStaffContext,
  input: Omit<AuditEvent, 'actor' | 'businessDate'>,
): AuditEvent {
  return {
    ...input,
    actor: { type: 'employee', employeeId: context.employeeId },
    businessDate: context.businessDate,
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function objectCodec<Value>(): JsonCodec<Value> {
  return {
    encode: (value) => value as unknown as JsonValue,
    decode: (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('activity operation replay payload is invalid')
      }
      return value as Value
    },
  }
}
