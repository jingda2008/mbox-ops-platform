import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {FastifyInstance,FastifyReply} from 'fastify'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import {BenefitRepository,BenefitUnavailableError} from './benefit-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {readMemberScanCode,resolveMemberScanCustomer} from './member-participation-query.js'
import {benefitWalletState,parseBenefitWalletCursor} from './benefit-wallet.js'
import type {ScopedTransaction} from './transaction-runner.js'

const uuid=z.string().uuid(),reason=z.string().trim().min(2).max(256)
const common={customerId:uuid,benefitId:uuid,tableSessionId:uuid}
const schemas={
 issue:z.object({customerId:uuid,benefitCode:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/),title:z.string().trim().min(2).max(100),benefitType:z.enum(['gift_product','discount','credit','access','other']),valueAmountMinor:z.number().int().min(0).max(100000000),quantity:z.number().int().min(1).max(10000),authorizationLimitId:uuid,allowedProductIds:z.array(uuid).max(100),validFrom:z.iso.datetime({offset:true}),validUntil:z.iso.datetime({offset:true}).nullable(),reason}).strict(),
 reserve:z.object({...common,quantity:z.number().int().min(1).max(100),expectedVersion:z.number().int().min(1)}).strict(),
 redeem:z.object({...common,reservationId:uuid,quantity:z.number().int().min(1).max(100),selectedProductId:uuid.optional(),substitutionReason:reason.optional()}).strict(),
 cancel:z.object({...common,reservationId:uuid,quantity:z.number().int().min(1).max(100),reason}).strict(),
}
type Action=keyof typeof schemas
const permission=(action:Action):'benefit.issue'|'benefit.cancel'|'loyalty.redemption.fulfill'=>action==='issue'?'benefit.issue':action==='cancel'?'benefit.cancel':'loyalty.redemption.fulfill'
type Handle=(reply:FastifyReply,operation:()=>Promise<FastifyReply>)=>Promise<FastifyReply>

export function registerNativeBenefitWallet(app:FastifyInstance,options:CustomerBenefitApiOptions,businessErrors:Handle){
 const handle:Handle=(reply,run)=>businessErrors(reply,async()=>{try{return await run()}catch(error){if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR});throw error}})
 app.post('/staff/native-benefit-wallet/lookup',{bodyLimit:4096},async(request,reply)=>handle(reply,async()=>{
  reply.header('Cache-Control','private, no-store')
  const q=z.object({code:z.string().min(1).max(150),cursor:z.string().max(120).optional()}).strict().parse(request.body)
  const ctx=await options.resolveStaffContext(request),code=readMemberScanCode(q.code)
  const data=await options.transactions.run(ctx.scope,async tx=>{
   const access=await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'loyalty.account.view')
   const customer=await resolveMemberScanCustomer(tx,code),now=options.now?.()??new Date()
   const page=await new BenefitRepository(tx).listWalletForCustomer(customer.id,parseBenefitWalletCursor(q.cursor),25,now)
   const ids=page.items.map(b=>b.id),args=[ctx.scope.tenantId,ctx.scope.storeId,ids]
   const snackIds=new Set((await tx.query<{benefit_id:string}>(`SELECT benefit_id FROM mbox.annual_daily_snack_claims WHERE tenant_id=$1 AND store_id=$2 AND benefit_id=ANY($3::uuid[])`,args)).rows.map(r=>r.benefit_id))
   const products=(await tx.query(`SELECT a.benefit_id,p.id,p.name,p.status FROM mbox.benefit_allowed_products a JOIN mbox.products p ON p.tenant_id=a.tenant_id AND p.store_id=a.store_id AND p.id=a.product_id WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.benefit_id=ANY($3::uuid[]) ORDER BY p.name,p.id`,args)).rows
   // Only the current authorized table scope is exposed; old reservations remain in original audits.
   const reservations=(await tx.query(`SELECT r.id,r.benefit_id AS "benefitId",r.table_session_id AS "tableSessionId",r.quantity,r.status,r.expires_at::text AS "expiresAt",t.code AS "tableCode",
    r.expires_at>clock_timestamp() AS "canRedeem"
    FROM mbox.benefit_reservations r JOIN mbox.table_sessions s ON s.tenant_id=r.tenant_id AND s.store_id=r.store_id AND s.id=r.table_session_id
    JOIN mbox.tables t ON t.tenant_id=s.tenant_id AND t.store_id=s.store_id AND t.id=s.table_id
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.benefit_id=ANY($3::uuid[]) AND r.status='reserved' AND s.status IN ('open','closing')
     AND (mbox.employee_has_effective_permission($1,$2,$4,'table.view_all') OR EXISTS(SELECT 1 FROM mbox.table_assignments a WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.table_id=s.table_id AND a.employee_id=$4 AND a.assignment_type IN ('primary','backup') AND a.starts_at<=clock_timestamp() AND(a.ends_at IS NULL OR a.ends_at>clock_timestamp())))
    ORDER BY r.reserved_at,r.id`,[...args,ctx.employeeId])).rows
   const tables=(await tx.query(`SELECT DISTINCT s.id,t.code FROM mbox.table_sessions s JOIN mbox.tables t ON t.tenant_id=s.tenant_id AND t.store_id=s.store_id AND t.id=s.table_id JOIN mbox.table_session_customer_participations c ON c.tenant_id=s.tenant_id AND c.store_id=s.store_id AND c.table_session_id=s.id
    WHERE s.tenant_id=$1 AND s.store_id=$2 AND c.customer_id=$3 AND c.left_at IS NULL AND s.status='open'
    AND (mbox.employee_has_effective_permission($1,$2,$4,'table.view_all') OR EXISTS(SELECT 1 FROM mbox.table_assignments a WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.table_id=s.table_id AND a.employee_id=$4 AND a.assignment_type IN ('primary','backup') AND a.starts_at<=clock_timestamp() AND(a.ends_at IS NULL OR a.ends_at>clock_timestamp()))) ORDER BY t.code,s.id`,[ctx.scope.tenantId,ctx.scope.storeId,customer.id,ctx.employeeId])).rows
   const limits=access.permissions.includes('benefit.issue')?(await tx.query(`SELECT DISTINCT a.id,a.amount_minor::text AS "amountMinor",a.currency,r.name FROM mbox.role_approval_limits a JOIN mbox.employee_roles e ON e.tenant_id=a.tenant_id AND e.store_id=a.store_id AND e.role_id=a.role_id JOIN mbox.roles r ON r.tenant_id=a.tenant_id AND r.store_id=a.store_id AND r.id=a.role_id WHERE a.tenant_id=$1 AND a.store_id=$2 AND e.employee_id=$3 AND e.starts_at<=clock_timestamp() AND(e.ends_at IS NULL OR e.ends_at>clock_timestamp()) AND a.enabled AND a.approval_code='benefit.issue' ORDER BY a.id`,[ctx.scope.tenantId,ctx.scope.storeId,ctx.employeeId])).rows:[]
   return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,customerId:customer.id,memberNo:code,displayName:customer.profile.displayName,permissions:access.permissions,tables,limits,nextCursor:page.nextCursor,
    items:page.items.map(b=>({snackClaim:snackIds.has(b.id),id:b.id,title:typeof b.benefitSnapshot.name==='string'?b.benefitSnapshot.name:b.benefitCode,type:b.benefitType,status:b.status,state:benefitWalletState(b,now),quantityTotal:b.quantityTotal,quantityReserved:b.quantityReserved,quantityRedeemed:b.quantityRedeemed,quantityAvailable:b.quantityAvailable,validFrom:b.validFrom,validUntil:b.validUntil,version:b.aggregateVersion,valueAmountMinor:b.valueAmountMinor,calendar:b.calendar??null,pricePromise:b.pricePromise??null,
     products:products.filter(p=>p.benefit_id===b.id),reservations:reservations.filter(r=>r.benefitId===b.id)}))}
  },{readOnly:true,isolation:'repeatable-read'})
  return reply.send({data})
 }))
 app.get('/staff/native-benefit-wallet/products',async(request,reply)=>handle(reply,async()=>{
  reply.header('Cache-Control','private, no-store');const q=z.object({search:z.string().trim().max(100).default(''),offset:z.coerce.number().int().min(0).max(100000).default(0)}).strict().parse(request.query),ctx=await options.resolveStaffContext(request)
  const data=await options.transactions.run(ctx.scope,async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'benefit.issue')
   const rows=(await tx.query(`SELECT id,name FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND status='active' AND ($3='' OR strpos(lower(name),lower($3))>0) ORDER BY name,id LIMIT 51 OFFSET $4`,[ctx.scope.tenantId,ctx.scope.storeId,q.search,q.offset])).rows
   return{employeeId:ctx.employeeId,items:rows.slice(0,50),nextOffset:rows.length>50?q.offset+50:null}
  },{readOnly:true});return reply.send({data})
 }))
 app.post<{Params:{action:string}}>('/staff/native-benefit-wallet/commands/:action',{bodyLimit:12000},async(request,reply)=>handle(reply,async()=>{
  const action=z.enum(['issue','reserve','redeem','cancel']).parse(request.params.action),input=schemas[action].parse(request.body)
  const key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']),ctx=await options.resolveStaffContext(request)
  await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission(action))},{readOnly:true})
  const validate=async(tx:ScopedTransaction)=>{
   if(action==='issue'){
    const issue=schemas.issue.parse(input)
    if(issue.validUntil!==null&&Date.parse(issue.validUntil)<=Date.parse(issue.validFrom))throw new BenefitUnavailableError('结束时间必须晚于生效时间')
    if(issue.benefitType==='gift_product'&&issue.allowedProductIds.length===0)throw new BenefitUnavailableError('赠品券必须选择实际可兑付商品')
   }else{
    const row=schemas[action as 'reserve'|'redeem'|'cancel'].parse(input)
    if(action!=='cancel'){
     const blocked=await tx.query(`SELECT 1 FROM mbox.benefit_coupon_price_promises WHERE tenant_id=$1 AND store_id=$2 AND benefit_id=$3 UNION ALL SELECT 1 FROM mbox.annual_daily_snack_claims WHERE tenant_id=$1 AND store_id=$2 AND benefit_id=$3`,[ctx.scope.tenantId,ctx.scope.storeId,row.benefitId])
     if(blocked.rowCount)throw new BenefitUnavailableError('低价券请走原订单报价；每日点心请走专用核销码入口')
    }
    if(action==='redeem'){
     const v=schemas.redeem.parse(input),benefit=await new BenefitRepository(tx).findById(v.benefitId)
     if(!benefit)throw new BenefitUnavailableError('原权益不存在')
     if(benefit.benefitType==='gift_product'){
      const allowed=await tx.query(`SELECT 1 FROM mbox.benefit_allowed_products a JOIN mbox.products p ON p.tenant_id=a.tenant_id AND p.store_id=a.store_id AND p.id=a.product_id WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.benefit_id=$3 AND p.id=$4 AND p.status='active'`,[ctx.scope.tenantId,ctx.scope.storeId,v.benefitId,v.selectedProductId??null])
      if(allowed.rowCount!==1)throw new BenefitUnavailableError('请选择本券允许的实际兑付商品')
     }else if(v.selectedProductId)throw new BenefitUnavailableError('此权益不是赠品券，不能生成赠品')
    }
    if('reservationId' in row){
     const found=await tx.query(`SELECT id FROM mbox.benefit_reservations WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND benefit_id=$4 AND table_session_id=$5 AND quantity=$6 AND status='reserved'`,[ctx.scope.tenantId,ctx.scope.storeId,row.reservationId,row.benefitId,row.tableSessionId,row.quantity])
     if(found.rowCount!==1)throw new BenefitUnavailableError('原暂留和份数已变化，请刷新核对')
    }
   }
  }
  const base={scope:ctx.scope,actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,nativeReceipt:{permission:permission(action),validate}}
  const hash=createHash('sha256').update(JSON.stringify({action,input,employeeId:ctx.employeeId})).digest('hex')
  const result=await(async()=>{
   if(action==='issue'){const v=schemas.issue.parse(input);return options.benefits.issue({...base,...v,currency:'CNY',issuedByEmployeeId:ctx.employeeId,benefitSnapshot:{name:v.title,publicDisplay:{title:v.title}},authorizationSource:{kind:'role_approval_limit',approvalLimitId:v.authorizationLimitId},issuanceIdempotencyKey:key,issuanceFingerprint:hash})}
   if(action==='reserve'){const v=schemas.reserve.parse(input);return options.benefits.reserve({...base,...v,expiresAt:new Date((options.now?.()??new Date()).getTime()+10*60000).toISOString(),reservationIdempotencyKey:key,reservationFingerprint:hash})}
   if(action==='redeem'){const v=schemas.redeem.parse(input);return options.benefits.redeem({...base,...v,benefitReservationId:v.reservationId,redeemedByEmployeeId:ctx.employeeId,authorizationSource:{kind:'employee',employeeId:ctx.employeeId},redemptionIdempotencyKey:key,redemptionFingerprint:hash})}
   const v=schemas.cancel.parse(input);return options.benefits.cancelReservation({...base,...v,benefitReservationId:v.reservationId,employeePermission:'benefit.cancel',cancellationIdempotencyKey:key,cancellationFingerprint:hash})
  })()
  return reply.send({data:{employeeId:ctx.employeeId,requestKey:key,action,customerId:input.customerId,result:result.value},meta:{protocol:1,replayed:result.replayed}})
 }))
}
