import {ticketDiningHandoffs,ticketRefundPreview} from './table-ticket-refund-preview.js'
import {proposeMove} from './table-ticket-reschedule.js'
import {ticketStatement,ticketFinanceDay} from './table-ticket-reception.js'
import {NativeCommandNotCommittedError} from './command-executor.js'
import {ActivityServiceError} from './activity-service-repository.js'
import type {ActivityDoorCommand} from '../../src/shared/activity-service.js'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { ActivityPaymentService } from './activity-payment-service.js'
import {
  ActivityOperationsError,
  type ActivityDraftInput,
  type ActivityPackageDraftInput,
  type ActivityRegistrationOperation,
} from './activity-operations-repository.js'
import {
  ActivityOperationsService,
  type ActivityOperationsStaffContext,
} from './activity-operations-service.js'
import type { CustomerExperienceService } from './customer-experience-service.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  OutboxMessageConflictError,
} from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { isPublicMediaAssetUrl } from './media-asset-url.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

export interface ActivityOperationsApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  service: ActivityOperationsService
  activityPublisher: Pick<CustomerExperienceService, 'publishActivity'>
  activityPayments: Pick<ActivityPaymentService, 'requestRefund'>
  resolveStaffContext(request: FastifyRequest):
    | ActivityOperationsStaffContext
    | Promise<ActivityOperationsStaffContext>
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository, 'assertPermission'>
}

export const activityOperationsApiPlugin: FastifyPluginAsync<ActivityOperationsApiOptions> = async (app, options) => {
  app.post<{Params:{id:string}}>('/staff/activity-operations/table-tickets/:id/reschedule',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['community.activity.manage'])
    const body=object(request.body,'改期安排')
    return reply.send({data:await options.transactions.run(ctx.scope,tx=>proposeMove(tx,uuid(request.params.id,'票号'),uuid(body.offerId,'新场次票档'),
      uuid(body.tableId,'桌号'),ctx.employeeId,text(body.reason,'变更原因',2,500),idempotencyKey(request)))})
  }))
  app.get<{Querystring:{day?:string}}>('/staff/activity-operations/ticket-finance-day',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['refund.request','refund.approve'])
    const day=request.query.day??null
    if(day!==null && (typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day))throw invalid('请选择有效营业日')
    return reply.header('cache-control','no-store').send({data:await options.transactions.run(ctx.scope,tx=>ticketFinanceDay(tx,day),{readOnly:true})})
  }))
  app.get<{Params:{id:string}}>('/staff/activity-operations/table-tickets/:id/statement',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['refund.request','refund.approve'])
    const id=uuid(request.params.id,'票号')
    return reply.header('cache-control','no-store').send({data:await options.transactions.run(ctx.scope,tx=>ticketStatement(tx,id),{readOnly:true})})
  }))
  app.get('/staff/activity-operations/ticket-dining-handoffs',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['refund.request','refund.approve','community.activity.cashier'])
    return reply.header('cache-control','no-store').send({data:await options.transactions.run(ctx.scope,ticketDiningHandoffs,{readOnly:true})})
  }))
  app.get<{Querystring:{reference:string}}>('/staff/activity-operations/ticket-refund-preview',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['refund.request','refund.approve'])
    const ref=text(request.query.reference,'原购票单号或票号',6,128)
    return reply.header('cache-control','no-store').send({data:await options.transactions.run(ctx.scope,tx=>ticketRefundPreview(tx,ref),{readOnly:true})})
  }))
  app.get('/staff/activity-operations/ticket-reception-inbox',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['community.activity.verify','community.activity.manage'])
    const tasks=await options.transactions.run(ctx.scope,async tx=>(await tx.query(`SELECT a.public_id AS "activityId",a.title,count(DISTINCT t.registration_id)::int AS waiting
      FROM mbox.ticket_reception_tasks t JOIN mbox.community_activity_registrations r ON(r.tenant_id,r.store_id,r.id)=(t.tenant_id,t.store_id,t.registration_id)
      JOIN mbox.table_tickets k ON(k.tenant_id,k.store_id,k.registration_id)=(t.tenant_id,t.store_id,t.registration_id) AND k.refunded_at IS NULL
      JOIN mbox.table_ticket_purchases p ON (p.tenant_id,p.store_id,p.registration_id)=(k.tenant_id,k.store_id,k.registration_id)
      LEFT JOIN mbox.ticket_reschedule_offers moved ON moved.id=k.reschedule_id
      JOIN mbox.community_activities a ON(a.tenant_id,a.store_id,a.id)=(r.tenant_id,r.store_id,coalesce(moved.activity_id,r.activity_id))
      WHERE t.tenant_id=$1 AND t.store_id=$2 AND coalesce(moved.ends_at,p.ends_at)>statement_timestamp()
        AND (t.status IN('waiting','unreachable','claimed') OR (coalesce(moved.starts_at,p.starts_at)<=statement_timestamp()
          AND NOT mbox.ticket_lock_active(k.tenant_id,k.store_id,k.reservation_lock_id)
          AND NOT EXISTS(SELECT 1 FROM mbox.ticket_seating(k.tenant_id,k.store_id,k.reservation_lock_id))
          AND NOT EXISTS(SELECT 1 FROM mbox.table_ticket_refund_requests f WHERE f.ticket_id=k.id AND f.status NOT IN('rejected','cancelled'))))
      GROUP BY a.id ORDER BY a.starts_at`,[ctx.scope.tenantId,ctx.scope.storeId])).rows,{readOnly:true})
    return reply.header('cache-control','no-store').send({data:tasks})
  }))
  app.get<{Params:{id:string}}>('/staff/activity-operations/:id/ticket-reception',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['community.activity.verify','community.activity.manage'])
    return reply.header('cache-control','no-store').send({data:await options.service.ticketReception(ctx,publicId(request.params.id))})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/table-tickets/:id/assign',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['community.activity.verify','community.activity.manage'])
    const body=object(request.body,'排桌')
    const result=await options.service.assignTicket(ctx,uuid(request.params.id,'票号'),uuid(body.tableId,'桌号'),
      body.reservationPublicId?publicId(body.reservationPublicId):null,idempotencyKey(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/table-ticket-refunds/:id/submit',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['refund.request'])
    const body=object(request.body,'退票')
    const result=await options.service.submitTicketRefund(ctx,uuid(request.params.id,'退票案'),integer(body.amountMinor,'应退票款',1,2147483647),
      body.merchantReason?text(body.merchantReason,'门店履约原因',2,500):null,idempotencyKey(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/table-tickets/:id/correction',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['loyalty.adjust.manual'])
    const body=object(request.body,'原票冲正')
    const action=body.action
    if(action!=='request'&&action!=='reject'&&action!=='approve')throw new ActivityOperationsError('请选择冲正操作','TICKET_CORRECTION_ACTION',400)
    const result=await options.service.changeTicketGift(ctx,uuid(request.params.id,'票号'),text(body.reason,'原因',3,240),action,
      action==='request'?null:uuid(body.caseId,'冲正案'),idempotencyKey(request),body.merchantAssumes===true,body.buyerUse===true)
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/table-ticket-refunds/:id/dining',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['refund.approve'])
    const body=object(request.body,'补菜款')
    const split=body.customerMinor===undefined && body.merchantMinor===undefined ? undefined : {
      customerMinor:integer(body.customerMinor,'顾客应补菜款',0,Number.MAX_SAFE_INTEGER),
      merchantMinor:integer(body.merchantMinor,'门店承担金额',0,Number.MAX_SAFE_INTEGER),
    }
    const result=await options.service.proposeTicketDining(ctx,uuid(request.params.id,'原退票案'),text(body.reason,'菜款核定依据',2,500),idempotencyKey(request),split)
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/table-ticket-offers/:id/assist',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['community.activity.verify','community.activity.manage'])
    const body=object(request.body,'代客选票'),phone=text(body.phone,'本人手机号',11,11)
    if(!/^1[3-9][0-9]{9}$/.test(phone))throw invalid('请核对本人手机号')
    const result=await options.service.offerTicketToMember(ctx,uuid(request.params.id,'票档'),integer(body.quantity,'桌数',1,2147483647),phone,idempotencyKey(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/table-tickets/:id/admit',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['community.activity.verify','community.activity.manage'])
    const body=object(request.body,'验票')
    const result=await options.service.ticketFrontDesk(ctx,uuid(request.params.id,'票号'),{code:text(body.code,'入场码',12,12).toUpperCase(),quantity:integer(body.quantity,'本批到场',1,2147483647)},idempotencyKey(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/ticket-reception/:id/contact',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorizedAny(options,request,['community.activity.verify','community.activity.manage'])
    const status=enumeration(object(request.body,'接待').status,'联系结果',['waiting','claimed','called','unreachable','onsite'] as const)
    const result=await options.service.ticketFrontDesk(ctx,publicId(request.params.id),{status},idempotencyKey(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/:id/table-ticket-terms',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['community.activity.publish']),body=object(request.body,'场次公示')
    if(typeof body.requiresNamedAttendees!=='boolean')throw invalid('请选择本场实名要求')
    const rules={organizer:text(body.organizer,'举办主体',2,180),seller:text(body.seller,'售票主体',2,180),approvalReference:text(body.approvalReference,'批文或核实依据',3,500),
      performers:text(body.performers,'主要演员',1,250),durationMinutes:integer(body.durationMinutes,'最低演出分钟数',1,10080),programNote:text(body.programNote,'曲目说明',2,500),
      serviceContact:text(body.serviceContact,'客服',3,180),refundSchedule:text(body.refundSchedule,'退票时段及金额规则',8,2000),requiresNamedAttendees:body.requiresNamedAttendees}
    const result=await options.service.approveTicketTerms(ctx,publicId(request.params.id),rules,integer(body.version,'原版本',0,2147483646),idempotencyKey(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/table-tickets/:id/disposition',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['refund.request','refund.approve']),body=object(request.body,'退票原案')
    const result=await options.service.closeTicketCase(ctx,uuid(request.params.id,'票号'),enumeration(body.action,'处理结果',['rejected','zero','cancelled'] as const),
      text(body.reason,'依据',3,240),idempotencyKey(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/table-tickets/:id/refund-request',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['refund.request'])
    const body=object(request.body,'退票')
    const result=await options.service.openStaffTicketRefund(ctx,uuid(request.params.id,'票号'),text(body.reason,'退票原因',2,500),idempotencyKey(request),body.previewVersion===undefined?undefined:text(body.previewVersion,'核算版本',64,64))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.get('/staff/activity-operations/ticket-rule-references',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['community.activity.publish'])
    const rows=await options.transactions.run(ctx.scope,async tx=>(await tx.query(
      `SELECT e.activity_id,e.id,e.version,a.title,e.organizer,e.seller,e.service_contact,e.refund_schedule,a.starts_at
        FROM mbox.table_ticket_event_terms e JOIN mbox.community_activities a ON(a.tenant_id,a.store_id,a.id)=(e.tenant_id,e.store_id,e.activity_id)
        WHERE e.tenant_id=$1 AND e.store_id=$2 AND a.published_at IS NOT NULL
        AND e.version=(SELECT max(v.version) FROM mbox.table_ticket_event_terms v WHERE(v.tenant_id,v.store_id,v.activity_id)=(e.tenant_id,e.store_id,e.activity_id))
        AND trim(e.refund_schedule)<>trim(e.service_contact) AND e.refund_schedule !~ '^[+()0-9[:space:].－—-]+$'
        ORDER BY a.starts_at DESC,e.id LIMIT 12`,[ctx.scope.tenantId,ctx.scope.storeId])).rows,{readOnly:true})
    return reply.header('cache-control','no-store').send({data:rows})
  }))
  app.get('/staff/activity-operations/ticket-areas',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['community.activity.manage'])
    const areas=await options.transactions.run(ctx.scope,async tx=>(await tx.query(
      `SELECT a.id,a.name FROM mbox.areas a WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.status='active'
       AND EXISTS(SELECT 1 FROM mbox.tables t WHERE(t.tenant_id,t.store_id,t.area_id)=(a.tenant_id,a.store_id,a.id) AND t.status='available')
       ORDER BY a.sort_order,a.code`,[ctx.scope.tenantId,ctx.scope.storeId])).rows,{readOnly:true})
    return reply.send({data:areas})
  }))
  app.get('/staff/activity-operations/ticket-review-inbox',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['community.activity.publish'])
    const rows=await options.transactions.run(ctx.scope,async tx=>(await tx.query(
      `SELECT a.public_id AS "activityId",a.title,a.starts_at AS "startsAt" FROM mbox.community_activities a
       WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.status IN('draft','published') AND a.ends_at>clock_timestamp()
       AND (a.status='published' OR a.created_by_employee_id<>$3)
       AND EXISTS (SELECT 1 FROM mbox.table_ticket_offers o WHERE (o.tenant_id,o.store_id,o.activity_id)=(a.tenant_id,a.store_id,a.id)
         AND o.status='draft' AND o.created_by<>$3 AND NOT EXISTS(SELECT 1 FROM mbox.table_ticket_offers n WHERE
           (n.tenant_id,n.store_id,n.activity_id,n.area_id)=(o.tenant_id,o.store_id,o.activity_id,o.area_id) AND n.version>o.version))
       ORDER BY a.starts_at,a.id`,[ctx.scope.tenantId,ctx.scope.storeId,ctx.employeeId])).rows,{readOnly:true})
    return reply.header('cache-control','no-store').send({data:rows})
  }))
  app.post<{Params:{id:string}}>('/staff/activity-operations/:id/publish-ticket-drafts',async(request,reply)=>handle(reply,async()=>{
    const ctx=await authorized(options,request,['community.activity.publish']),body=object(request.body,'复核票档')
    if(!Array.isArray(body.drafts) || !body.drafts.length || body.drafts.length>100)throw invalid('请选择本次复核的票档')
    const drafts=body.drafts.map(value=>{const entry=object(value,'草稿');return {areaId:uuid(entry.areaId,'桌区'),version:integer(entry.version,'草稿版本',1,2147483647)}})
    if(new Set(drafts.map(entry=>entry.areaId)).size!==drafts.length)throw invalid('桌区重复')
    const expectedUpdatedAt=text(body.activityUpdatedAt,'场次版本',10,64)
    if(!Number.isFinite(Date.parse(expectedUpdatedAt)))throw invalid('场次版本无效')
    const result=await options.activityPublisher.publishActivity(ctx,{publicId:publicId(request.params.id),idempotencyKey:idempotencyKey(request),
      draftBatch:{drafts,termsVersion:integer(body.termsVersion,'公示版本',1,2147483647)},expectedUpdatedAt})
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  const offerPath = '/staff/activity-operations/:publicId/table-tickets'
  app.get<{Params:{publicId:string}}>(offerPath,async(request,reply)=>handle(reply,async()=>{
    const context = await authorizedAny(options,request,['community.activity.manage','community.activity.publish','community.activity.verify'])
    return reply.send({data:await options.service.ticketOffers(context,publicId(request.params.publicId))})
  }))
  app.post<{Params:{publicId:string}}>(offerPath,async(request,reply)=>handle(reply,async()=>{
    const body = object(request.body,'桌票')
    const status = enumeration(body.status,'票档状态',['draft','published','withdrawn'] as const)
    const context = await authorized(options,request,[status==='draft'?'community.activity.manage':'community.activity.publish'])
    const visibleFrom = body.visibleFrom ? timestamp(body.visibleFrom,'可见开始') : null
    const visibleUntil = body.visibleUntil ? timestamp(body.visibleUntil,'可见结束') : null
    if (visibleFrom && visibleUntil && visibleUntil<=visibleFrom) throw invalid('可见结束须晚于开始')
    const saleFrom=body.saleFrom===undefined?undefined:body.saleFrom?timestamp(body.saleFrom,'开售时间'):null
    const saleUntil=body.saleUntil===undefined?undefined:body.saleUntil?timestamp(body.saleUntil,'停售时间'):null
    if(saleFrom && saleUntil && saleUntil<=saleFrom)throw invalid('停售时间须晚于开售时间')
    if(body.recommendInCommunity!==undefined && typeof body.recommendInCommunity!=='boolean')throw invalid('请选择是否在超嗨推荐')
    const offer = {
      ...(body.expectedTermsVersion===undefined?{}:{expectedTermsVersion:integer(body.expectedTermsVersion,'公示版本',1,2147483647)}),
      ...(body.recommendInCommunity===undefined?{}:{recommendInCommunity:body.recommendInCommunity}),
      ...(saleFrom!==undefined?{saleFrom}:{}),...(saleUntil!==undefined?{saleUntil}:{}),
      categoryCode:body.categoryCode?text(body.categoryCode,'分类',1,64):null,areaId:uuid(body.areaId,'桌区'),name:text(body.name,'票名',1,120),status,visibleFrom,visibleUntil,
      expectedVersion:integer(body.expectedVersion,'票档版本',0,2147483646),
      priceMinor:integer(body.priceMinor,'每桌价格（分）',1,2147483647),
      giftPoints:body.giftPoints===null && status!=='published'?null:integer(body.giftPoints,'每张赠分',0,2147483647),
    }
    const activityId=publicId(request.params.publicId)
    const key=idempotencyKey(request)
    if (body.reviewActivity===true) {
      if (status!=='published' || !offer.expectedTermsVersion) throw invalid('场次复核需要已确认的公示和待发布票档')
      const expectedUpdatedAt=text(body.activityUpdatedAt,'场次版本',10,64)
      if (!Number.isFinite(Date.parse(expectedUpdatedAt))) throw invalid('场次版本无效，请刷新')
      const combined=await options.activityPublisher.publishActivity(context,{publicId:activityId,idempotencyKey:key,ticketOffer:offer,expectedUpdatedAt})
      return reply.send({data:combined.value,meta:{replayed:combined.replayed}})
    }
    const result=await options.service.saveTicketOffer(context,activityId,offer,key)
    return reply.code(result.replayed?200:201).send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post('/staff/activity-operations/scan',async(request,reply)=>handle(reply,async()=>{const context=await authorizedAny(options,request,['community.activity.view','community.activity.manage','community.activity.verify']);return reply.send({data:await options.service.scanService(context,text(object(request.body,'扫码').code,'套餐核销码',10,300))})}))
  app.get<{Params:{registrationPublicId:string}}>('/staff/activity-operations/registrations/:registrationPublicId/service',async(request,reply)=>handle(reply,async()=>{const context=await authorizedAny(options,request,['community.activity.view','community.activity.manage','community.activity.verify']);return reply.send({data:await options.service.serviceView(context,publicId(request.params.registrationPublicId))})}))
  app.post<{Params:{registrationPublicId:string}}>('/staff/activity-operations/registrations/:registrationPublicId/service',async(request,reply)=>handle(reply,async()=>{const body=object(request.body,'现场办理');const context=await authorizedAny(options,request,['recover','restore_plaque'].includes(String(body.action))?['community.activity.manage']:['community.activity.manage','community.activity.verify']);const action=enumeration(body.action,'现场操作',['admit','redeem','admit_and_redeem','plaque_issued','return_plaque','restore_plaque','recover','update_location'] as const);const command:ActivityDoorCommand={action,...(body.arrivedCount===undefined?{}:{arrivedCount:integer(body.arrivedCount,'本次到场',1,50)}),...(body.location===undefined?{}:{location:text(body.location,'收餐位置',1,100)}),...(body.credential===undefined?{}:{credential:text(body.credential,'核销凭证',10,300)})};const result=await options.service.serviceCommand(context,publicId(request.params.registrationPublicId),command,idempotencyKey(request));return reply.send({data:result.value,meta:{replayed:result.replayed}})}))
  app.post<{Params:{publicId:string}}>('/staff/activity-operations/:publicId/stop-registration',async(request,reply)=>handle(reply,async()=>{
    const context=await authorized(options,request,['community.activity.manage'])
    const body=object(request.body,'停止报名')
    const result=await options.service.stopRegistration(context,{publicId:publicId(request.params.publicId),reason:text(body.reason,'操作原因',2,500),idempotencyKey:idempotencyKey(request)})
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{publicId:string}}>('/staff/activity-operations/:publicId/close', async (request,reply) => handle(reply,async()=>{
    const context=await authorized(options,request,['community.activity.manage'])
    const body=object(request.body,'活动结束操作')
    if(body.status!=='cancelled' && body.status!=='completed') throw new ActivityOperationsError('活动结束状态无效','ACTIVITY_CLOSE_INVALID',400)
    const result=await options.service.closeActivity(context,{publicId:publicId(request.params.publicId),status:body.status,
      reason:text(body.reason,'操作原因',2,500),idempotencyKey:idempotencyKey(request)})
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post('/staff/activity-operations', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, ['community.activity.manage'])
    const body = object(request.body, '活动草稿')
    const draft=parseActivityDraft(body)
    let ticketRows
    if(body.ticketRows!==undefined){
      if(!draft.ticketOnly || !Array.isArray(body.ticketRows) || !body.ticketRows.length || body.ticketRows.length>100)throw invalid('门票场次至少选择一个桌区')
      ticketRows=body.ticketRows.map(raw=>{const row=object(raw,'票档');return {areaId:uuid(row.areaId,'桌区'),name:text(row.name,'票名',1,120),
        priceMinor:integer(row.priceMinor,'票价',1,2147483647),giftPoints:integer(row.giftPoints,'赠分',0,2147483647)}})
      if(new Set(ticketRows.map(row=>row.areaId)).size!==ticketRows.length)throw invalid('同一场次的桌区不可重复')
    }
    const result = await options.service.createDraft(context, {
      draft,...(ticketRows?{ticketRows}:{}),
      reason: text(body.reason, '建立原因', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get<{Querystring:{catalog?:string}}>('/staff/activity-operations', async (request, reply) => handle(reply, async () => {
    const context = await authorizedAny(options, request, ['community.activity.view', 'community.activity.manage', 'community.activity.publish'])
    return reply.send({ data: await options.service.list(context,request.query.catalog==='tickets') })
  }))

  app.get('/staff/activity-operations/product-catalog',async(request,reply)=>handle(reply,async()=>{const context=await authorized(options,request,['community.activity.manage']);return reply.send({data:await options.service.productCatalog(context)})}))
  app.get('/staff/activity-operations/component-catalog', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, ['community.activity.manage'])
    return reply.send({ data: await options.service.componentCatalog(context) })
  }))

  app.get<{ Params: { publicId: string } }>(
    '/staff/activity-operations/:publicId',
    async (request, reply) => handle(reply, async () => {
      const context = await authorizedAny(options, request, ['community.activity.view', 'community.activity.manage', 'community.activity.publish'])
      return reply.send({ data: await options.service.detail(context, publicId(request.params.publicId)) })
    }),
  )

  app.put<{ Params: { publicId: string } }>(
    '/staff/activity-operations/:publicId/draft',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.manage'])
      const body = object(request.body, '活动草稿')
      const result = await options.service.updateDraft(context, {
        publicId: publicId(request.params.publicId),
        draft: parseActivityDraft(body),
        reason: text(body.reason, '修改原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { publicId: string } }>(
    '/staff/activity-operations/:publicId/publish',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.publish'])
      const result = await options.activityPublisher.publishActivity(context, {
        publicId: publicId(request.params.publicId),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { publicId: string; packagePublicId: string; action: string } }>(
    '/staff/activity-operations/:publicId/packages/:packagePublicId/:action',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.manage'])
      const body = object(request.body, '套餐上下架操作')
      const action = packageAvailabilityOperation(request.params.action)
      const result = await options.service.setPackageAvailability(context, {
        activityPublicId: publicId(request.params.publicId),
        packagePublicId: publicId(request.params.packagePublicId),
        operation: action,
        reason: text(body.reason, '操作原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { publicId: string } }>(
    '/staff/activity-operations/:publicId/waitlist-retry',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.manage'])
      const body = object(request.body, '候补任务重试')
      const result = await options.service.retryWaitlistPromotion(context, {
        publicId: publicId(request.params.publicId),
        reason: text(body.reason, '重试原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { registrationPublicId: string; action: string } }>(
    '/staff/activity-operations/registrations/:registrationPublicId/:action',
    async (request, reply) => handle(reply, async () => {
      const operation = registrationOperation(request.params.action)
      const context = await authorized(options, request, ['community.activity.manage'])
      const body = object(request.body, '报名操作')
      const result = await options.service.transitionRegistration(context, {
        publicId: publicId(request.params.registrationPublicId),
        operation,
        reason: text(body.reason, '操作原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { registrationPublicId: string } }>(
    '/staff/activity-operations/registrations/:registrationPublicId/refund-request',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.manage', 'refund.request'])
      const body = object(request.body, '退款申请')
      const result = await options.activityPayments.requestRefund(context, {
        registrationPublicId: publicId(request.params.registrationPublicId),
        reason: text(body.reason, '退款原因', 2, 1_000),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )
}

async function authorized(
  options: ActivityOperationsApiOptions,
  request: FastifyRequest,
  permissions: readonly string[],
): Promise<ActivityOperationsStaffContext> {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, async (transaction) => {
    const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
    for (const permission of permissions) await access.assertPermission(context.employeeId, permission)
  }, { readOnly: true })
  return context
}

async function authorizedAny(
  options: ActivityOperationsApiOptions,
  request: FastifyRequest,
  permissions: readonly string[],
): Promise<ActivityOperationsStaffContext> {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, async (transaction) => {
    const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
    let denied: unknown = new StaffAccessDeniedError('当前岗位没有活动读取权限')
    for (const permission of permissions) {
      try {
        await access.assertPermission(context.employeeId, permission)
        return
      } catch (error) {
        if (!(error instanceof StaffAccessDeniedError)) throw error
        denied = error
      }
    }
    throw denied
  }, { readOnly: true })
  return context
}

export function parseActivityDraft(value: Record<string, unknown>): ActivityDraftInput {
  const visibility = enumeration(value.visibility, '可见范围', ['public','member','segment'] as const)
  const audienceMemberLevels = stringList(
    value.audienceMemberLevels,
    '会员等级',
    ['member','silver','gold'] as const,
  )
  const audienceLifecycleStages = stringList(
    value.audienceLifecycleStages,
    '会员阶段',
    ['new','active','high_value','at_risk','dormant'] as const,
  )
  if (visibility === 'segment' && audienceMemberLevels.length + audienceLifecycleStages.length === 0) {
    throw invalid('指定客群活动至少选择一个会员等级或阶段')
  }
  if (visibility !== 'segment' && audienceMemberLevels.length + audienceLifecycleStages.length > 0) {
    throw invalid('公开或全会员活动不能携带指定客群条件')
  }
  const startsAt = timestamp(value.startsAt, '开始时间')
  const endsAt = timestamp(value.endsAt, '结束时间')
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw invalid('结束时间必须晚于开始时间')
  const paymentMode = enumeration(
    value.paymentMode,
    '预付方式',
    ['none','deposit_optional','deposit_required','full_required'] as const,
  )
  const feeAmountMinor = integer(value.feeAmountMinor, '活动费用', 0, 100_000_000)
  const depositAmountMinor = integer(value.depositAmountMinor, '活动订金', 0, 100_000_000)
  if (depositAmountMinor > feeAmountMinor) throw invalid('活动订金不能超过活动费用')
  if (paymentMode === 'none' && depositAmountMinor !== 0) throw invalid('无需预付时订金必须为0')
  if ((paymentMode === 'deposit_optional' || paymentMode === 'deposit_required')
    && (feeAmountMinor <= 0 || depositAmountMinor <= 0)) throw invalid('订金模式必须配置正数费用和订金')
  if (paymentMode === 'full_required' && (feeAmountMinor <= 0 || depositAmountMinor !== 0)) {
    throw invalid('全额预付必须配置正数费用且订金为0')
  }
  const coverUrl = optionalText(value.coverUrl, '封面地址', 1_000)
  if (coverUrl !== null && !isPublicMediaAssetUrl(coverUrl)) throw invalid('封面必须从站内图片库选择，单张不超过200KB')
  const capacity = integer(value.capacity, '人数上限', 1, 1_000)
  const packageSelectionRequired = optionalBoolean(value.packageSelectionRequired, false, '套餐是否必选')
  const packages = activityPackages(value.packages, capacity, endsAt)
  if (packageSelectionRequired && packages.length === 0) throw invalid('套餐必选活动至少需要一档套餐')
  return {
    ...(value.ticketOnly===undefined?{}:{ticketOnly:optionalBoolean(value.ticketOnly,false,'整桌演出场次')}),
    kind: enumeration(value.kind, '活动类型', ['member_night','hike','camping','city_walk','music_picnic','proposal','other'] as const),
    title: text(value.title, '活动名称', 2, 120),
    summary: text(value.summary, '列表摘要', 2, 600),
    coverUrl,
    startsAt,
    endsAt,
    assemblyLocation: text(value.assemblyLocation, '集合地点', 2, 240),
    capacity,
    feeAmountMinor,
    depositAmountMinor,
    feeBasis: enumeration(value.feeBasis, '计价方式', ['per_person','per_registration'] as const),
    paymentMode,
    paymentDeadlineMinutes: integer(value.paymentDeadlineMinutes, '付款时限', 5, 1_440),
    paymentRuleText: text(value.paymentRuleText, '付款说明', 2, 240),
    pointsReward: integer(value.pointsReward, '积分奖励（当前停用）', 0, 0),
    visibility,
    audienceMemberLevels,
    audienceLifecycleStages,
    safetyPolicyVersion: text(value.safetyPolicyVersion, '安全规则版本', 1, 64),
    safetyAcknowledgementText: text(value.safetyAcknowledgementText, '安全确认文案', 2, 1_000),
    safetyRequirements: textList(value.safetyRequirements, '安全要求', 1, 50, 500),
    refundPolicyVersion: text(value.refundPolicyVersion, '退款规则版本', 3, 64),
    refundPolicySummary: text(value.refundPolicySummary, '退款说明', 2, 500),
    activityDetails: text(value.activityDetails, '活动详情', 10, 4_000),
    includedItems: textList(value.includedItems, '费用包含', 0, 100, 500),
    participationRequirements: textList(value.participationRequirements, '参与条件', 0, 100, 500),
    contactInstructions: text(value.contactInstructions, '联系与集合说明', 2, 1_200),
    memberBenefitText: optionalText(value.memberBenefitText, '会员权益与赠送', 1_000),
    mealServiceStartsAt:optionalTimestamp(value.mealServiceStartsAt,'餐饮核销开始'),mealServiceEndsAt:optionalTimestamp(value.mealServiceEndsAt,'餐饮核销结束'),addonEndsAt:optionalTimestamp(value.addonEndsAt,'加购截止'),addonProductIds:value.addonProductIds===undefined?[]:Array.isArray(value.addonProductIds)?value.addonProductIds.map(id=>uuid(id,'加购菜品')):(()=>{throw invalid('请选择加购菜品')})(),
    packageSelectionRequired,
    packages,
  }
}

function activityPackages(
  value: unknown,
  activityCapacity: number,
  endsAt: string,
): ActivityPackageDraftInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw invalid('活动套餐最多20档')
  const packages = value.map((entry, index) => activityPackage(object(entry, `第${index + 1}档套餐`), activityCapacity, endsAt, index))
  if (new Set(packages.map((activityPackage) => activityPackage.name)).size !== packages.length) {
    throw invalid('活动套餐名称不能重复')
  }
  return packages
}

function activityPackage(
  value: Record<string, unknown>,
  activityCapacity: number,
  endsAt: string,
  index: number,
): ActivityPackageDraftInput {
  const feeAmountMinor = integer(value.feeAmountMinor, '套餐加购价', 0, 100_000_000)
  const depositAmountMinor = integer(value.depositAmountMinor, '套餐订金', 0, 100_000_000)
  const paymentMode = enumeration(value.paymentMode, '套餐预付方式', ['none','deposit_optional','deposit_required','full_required'] as const)
  if (depositAmountMinor > feeAmountMinor) throw invalid('套餐订金不能超过加购价')
  if (paymentMode === 'none' && depositAmountMinor !== 0) throw invalid('无需预付的套餐订金必须为0')
  if ((paymentMode === 'deposit_optional' || paymentMode === 'deposit_required')
    && (feeAmountMinor <= 0 || depositAmountMinor <= 0)) throw invalid('套餐订金模式必须配置正数加购价和订金')
  if (paymentMode === 'full_required' && (feeAmountMinor <= 0 || depositAmountMinor !== 0)) {
    throw invalid('套餐全额预付必须配置正数加购价且订金为0')
  }
  const imageUrl = optionalText(value.imageUrl, '套餐图片地址', 1_000)
  if (imageUrl !== null && !isPublicMediaAssetUrl(imageUrl)) throw invalid('套餐图片必须从站内图片库选择，单张不超过200KB')
  const availableFrom = optionalTimestamp(value.availableFrom, '套餐开售时间')
  const availableUntil = optionalTimestamp(value.availableUntil, '套餐停售时间')
  if (availableFrom !== null && Date.parse(availableFrom) >= Date.parse(endsAt)) {
    throw invalid('套餐开售时间必须早于活动结束时间')
  }
  if (availableUntil !== null && Date.parse(availableUntil) > Date.parse(endsAt)) {
    throw invalid('套餐停售时间不能晚于活动结束时间')
  }
  if (availableFrom !== null && availableUntil !== null && Date.parse(availableUntil) <= Date.parse(availableFrom)) {
    throw invalid('套餐停售时间必须晚于开售时间')
  }
  const componentsValue = value.components === undefined ? [] : value.components
  if (!Array.isArray(componentsValue) || componentsValue.length > 100) throw invalid('套餐物料最多100项')
  const components = componentsValue.map((entry, componentIndex) => {
    const component = object(entry, `套餐物料第${componentIndex + 1}项`)
    return {
      inventoryItemId: uuid(component.inventoryItemId, '套餐物料编号'),
      quantity: decimal(component.quantity, '套餐物料数量'),
      perParticipant: optionalBoolean(component.perParticipant, true, '是否按报名人数占用'),
    }
  })
  if (new Set(components.map((component) => component.inventoryItemId)).size !== components.length) {
    throw invalid('同一套餐不能重复选择同一物料')
  }
  const maxParticipants=value.maxParticipants==null?null:integer(value.maxParticipants,'套餐人数上限',1,50)
  const products=value.products===undefined?[]:value.products
  if(!Array.isArray(products)||products.length>100)throw invalid('套餐菜品最多100项')
  const serviceProducts=products.map(entry=>{const product=object(entry,'套餐菜品');return {productId:uuid(product.productId,'菜品编号'),quantity:integer(product.quantity,'固定菜量',1,100)}})
  if(new Set(serviceProducts.map(p=>p.productId)).size!==serviceProducts.length)throw invalid('套餐菜品不能重复')
  if(maxParticipants!==null&&(value.feeBasis!=='per_registration'||paymentMode!=='full_required'||components.length>0))throw invalid('新套餐须按份固定价、全额预付，不按人数增减菜量或物料')
  const choiceGroups=value.choiceGroups===undefined?[]:value.choiceGroups;
  if(!Array.isArray(choiceGroups)||choiceGroups.length>5)throw invalid('固定自选项最多5组');
  const serviceChoices=choiceGroups.map(raw=>{const group=object(raw,'自选组');if(!Array.isArray(group.productIds)||group.productIds.length<2||group.productIds.length>8)throw invalid('每组选择2至8个可选菜品');const productIds=group.productIds.map(id=>uuid(id,'可选菜品'));if(new Set(productIds).size!==productIds.length)throw invalid('自选组菜品不能重复');return {id:text(group.id,'自选组编号',3,64),name:text(group.name,'自选组名称',1,40),quantity:integer(group.quantity,'自选固定菜量',1,100),productIds}});
  if(new Set(serviceChoices.map(g=>g.id)).size!==serviceChoices.length)throw invalid('自选组编号不能重复');
  if(maxParticipants===null&&serviceChoices.length)throw invalid('旧套餐不能新增自选承诺，请创建新套餐');
  return {
    maxParticipants,choiceGroups:serviceChoices,hasMeal:value.hasMeal===true||serviceProducts.length>0||serviceChoices.length>0,includesAdmission:optionalBoolean(value.includesAdmission,true,'包含入场'),mealOnlyFeeAmountMinor:value.mealOnlyFeeAmountMinor==null?null:integer(value.mealOnlyFeeAmountMinor,'纯加餐价格',1,100_000_000),products:serviceProducts,
    name: text(value.name, '套餐名称', 2, 120), description: optionalText(value.description, '套餐说明', 1_000) ?? '', imageUrl,
    includedItems: textList(value.includedItems ?? [], '套餐包含内容', 0, 100, 500),
    capacity: integer(value.capacity, maxParticipants===null?'套餐名额':'可售份数', 1, maxParticipants===null?activityCapacity:100_000),
    memberPurchaseLimit: integer(value.memberPurchaseLimit ?? 1, '每会员限购', 1, 20),
    feeAmountMinor,depositAmountMinor,feeBasis: enumeration(value.feeBasis, '套餐计价方式', ['per_person','per_registration'] as const),
    paymentMode,paymentDeadlineMinutes: integer(value.paymentDeadlineMinutes, '套餐付款时限', 5, 1_440),
    paymentRuleText: text(value.paymentRuleText, '套餐付款说明', 2, 240),
    redemptionPolicyVersion: optionalText(value.redemptionPolicyVersion, '套餐取用规则版本', 64),
    refundPolicyVersion: optionalText(value.refundPolicyVersion, '套餐退款规则版本', 64),
    sortOrder: integer(value.sortOrder ?? index, '套餐排序', 0, 10_000),availableFrom,availableUntil,components,
  }
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) {
  try { return await execute() } catch (caught) {
 const error=caught instanceof NativeCommandNotCommittedError?caught.original:caught;
    if (isStaffAuthenticationRequiredError(error)) {
      return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    }
    if (error instanceof ActivityOperationsApiRequestError) {
      return reply.code(400).send({ error: { code: 'ACTIVITY_OPERATION_INPUT_INVALID', message: error.message } })
    }
    if (error instanceof ActivityOperationsError || error instanceof CustomerExperienceRequestError || error instanceof ActivityServiceError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof StaffAccessDeniedError) {
      return reply.code(403).send({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有执行该活动操作的权限' } })
    }
    if (error instanceof IdempotencyConflictError || error instanceof OutboxMessageConflictError) {
      return reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '重复请求内容不一致' } })
    }
    if (error instanceof IdempotencyInProgressError) {
      return reply.code(425).send({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: '相同活动操作正在处理中' } })
    }
    if (error instanceof IdempotencyRecordError) {
      return reply.code(503).send({ error: { code: 'IDEMPOTENCY_UNAVAILABLE', message: '活动操作暂时无法确认，请刷新后重试' } })
    }
    throw error
  }
}

export class ActivityOperationsApiRequestError extends Error {}

function invalid(message: string) { return new ActivityOperationsApiRequestError(message) }

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${label}格式不正确`)
  return value as Record<string, unknown>
}

function publicId(value: unknown): string {
  return pattern(text(value, '公开编号', 8, 128), /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/, '公开编号')
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (Array.isArray(value)) throw invalid('Idempotency-Key格式不正确')
  return pattern(text(value, 'Idempotency-Key', 8, 128), /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/, 'Idempotency-Key')
}

function registrationOperation(value: string): ActivityRegistrationOperation {
  if (value === 'check-in') return 'check_in'
  if (value === 'fulfill-package') return 'fulfill_package'
  if (value === 'no-show') return 'no_show'
  if (value === 'cancel') return 'cancel'
  throw invalid('不支持的报名操作')
}

function packageAvailabilityOperation(value: string): 'pause' | 'resume' {
  if (value === 'pause' || value === 'resume') return value
  throw invalid('不支持的套餐上下架操作')
}

function text(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw invalid(`${label}必须填写`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) throw invalid(`${label}长度不正确`)
  return normalized
}

function optionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return text(value, label, 1, maximum)
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalid(`${label}格式不正确`)
  return value
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return timestamp(value, label)
}

function uuid(value: unknown, label: string): string {
  const normalized = text(value, label, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw invalid(`${label}格式不正确`)
  }
  return normalized
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid(`${label}格式不正确`)
  const normalized = String(value).trim()
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized) || Number(normalized) <= 0 || Number(normalized) > 1_000_000) {
    throw invalid(`${label}格式不正确`)
  }
  return normalized
}

function timestamp(value: unknown, label: string): string {
  const normalized = text(value, label, 8, 64)
  if (!Number.isFinite(Date.parse(normalized))) throw invalid(`${label}格式不正确`)
  return new Date(normalized).toISOString()
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(`${label}超出范围`)
  }
  return value as number
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw invalid(`${label}不受支持`)
  return value as Values[number]
}

function stringList<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number][] {
  if (!Array.isArray(value) || value.length > values.length) throw invalid(`${label}格式不正确`)
  return [...new Set(value.map((item) => enumeration(item, label, values)))]
}

function textList(
  value: unknown,
  label: string,
  minimumItems: number,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    throw invalid(`${label}项目数量不正确`)
  }
  return value.map((item, index) => text(item, `${label}第${index + 1}项`, 1, maximumLength))
}

function pattern(value: string, expression: RegExp, label: string): string {
  if (!expression.test(value)) throw invalid(`${label}格式不正确`)
  return value
}
