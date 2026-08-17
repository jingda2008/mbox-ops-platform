import { createHash } from 'node:crypto'
import { buildExperienceCues, CustomerExperienceRequestError } from './customer-experience-repository.js'
import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export interface OrderedRecommendationReference {
  recommendationSessionId:string
  recommendationOptionId:string
  orderItemId:string
}

export interface ExperiencePlanActivationResult {
  planPublicId:string|null
  state:'active'|'planned'|'paused'|'completed'|'cancelled'|'absent'|'failed'
  changed:boolean
  cueCount:number
}

interface PlanSourceRow extends Record<string,unknown>{
  recommendation_session_id:string
  recommendation_option_id:string
  order_item_id:string
  order_id:string
  table_session_id:string
  customer_id:string
  business_date:string
  settlement_mode:'immediate_payment'|'table_tab'
  order_status:string
  order_payment_status:string
  order_item_status:string
  party_size:number
  occasion:string
  alcohol_preference:string
  service_intensity:'quiet'|'balanced'|'hosted'
  experience_intent_summary:string|null
  selected_product_id:string
  selected_product_name:string
  selected_amount_minor:string|number
  selected_currency:string
  display_snapshot:JsonObject
}

interface ExistingPlanRow extends Record<string,unknown>{
  id:string
  public_id:string
  plan_state:'planned'|'active'|'paused'|'completed'|'cancelled'
  payment_id:string|null
}

export class ExperiencePlanActivationRepository{
  constructor(private readonly transaction:ScopedTransaction){}

  async recordOrderedNonCritical(input:Readonly<{
    reference:OrderedRecommendationReference
    orderId:string
    actorRef:string
  }>):Promise<ExperiencePlanActivationResult>{
    await this.transaction.query('SAVEPOINT experience_plan_order_activation')
    try{
      const result=await this.createForOrder(input.reference,input.orderId,input.actorRef,null)
      await this.transaction.query('RELEASE SAVEPOINT experience_plan_order_activation')
      return result
    }catch(error){
      await this.transaction.query('ROLLBACK TO SAVEPOINT experience_plan_order_activation')
      await this.transaction.query('RELEASE SAVEPOINT experience_plan_order_activation')
      await this.recordFailure(input.reference,input.orderId,null,'ordered_plan_creation_failed')
      return {planPublicId:null,state:'failed',changed:false,cueCount:0}
    }
  }

  async activatePaidNonCritical(orderId:string,paymentId:string|null):Promise<ExperiencePlanActivationResult>{
    const reference=await this.referenceForOrder(orderId)
    if(reference===null)return {planPublicId:null,state:'absent',changed:false,cueCount:0}
    await this.transaction.query('SAVEPOINT experience_plan_payment_activation')
    try{
      const result=await this.activatePaid(reference,orderId,paymentId)
      await this.transaction.query('RELEASE SAVEPOINT experience_plan_payment_activation')
      return result
    }catch(error){
      await this.transaction.query('ROLLBACK TO SAVEPOINT experience_plan_payment_activation')
      await this.transaction.query('RELEASE SAVEPOINT experience_plan_payment_activation')
      await this.recordFailure(reference,orderId,paymentId,'verified_payment_plan_activation_failed')
      return {planPublicId:null,state:'failed',changed:false,cueCount:0}
    }
  }

  async cancelAfterFullRefund(orderId:string,paymentId:string):Promise<ExperiencePlanActivationResult>{
    const reference=await this.referenceForOrder(orderId)
    if(reference===null)return {planPublicId:null,state:'absent',changed:false,cueCount:0}
    await this.transaction.query('SAVEPOINT experience_plan_refund_cancellation')
    try{
      const result=await this.cancelAfterFullRefundStrict(orderId,paymentId)
      await this.transaction.query('RELEASE SAVEPOINT experience_plan_refund_cancellation')
      return result
    }catch(error){
      await this.transaction.query('ROLLBACK TO SAVEPOINT experience_plan_refund_cancellation')
      await this.transaction.query('RELEASE SAVEPOINT experience_plan_refund_cancellation')
      await this.recordFailure(reference,orderId,paymentId,'full_refund_plan_cancellation_failed')
      return {planPublicId:null,state:'failed',changed:false,cueCount:0}
    }
  }

  private async cancelAfterFullRefundStrict(orderId:string,paymentId:string):Promise<ExperiencePlanActivationResult>{
    const plan=await this.transaction.query<ExistingPlanRow>(`
      SELECT plan.id,plan.public_id,plan.plan_state,plan.payment_id
      FROM mbox.customer_experience_plans plan
      JOIN mbox.orders ordered
        ON ordered.tenant_id=plan.tenant_id AND ordered.store_id=plan.store_id
       AND ordered.id=plan.order_id
      WHERE plan.tenant_id=$1::uuid AND plan.store_id=$2::uuid
        AND plan.order_id=$3::uuid AND ordered.payment_status='refunded'
      FOR UPDATE OF plan
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])
    const row=plan.rows[0]
    if(!row)return {planPublicId:null,state:'absent',changed:false,cueCount:0}
    if(row.plan_state==='cancelled')return {planPublicId:row.public_id,state:'cancelled',changed:false,cueCount:0}
    const transitioned=await this.transaction.query(`
      UPDATE mbox.customer_experience_plans
      SET plan_state='cancelled',cancelled_reason_code='fully_refunded',updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND plan_state IN ('planned','active','paused')
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,row.id])
    if(transitioned.rowCount!==1)return {planPublicId:row.public_id,state:row.plan_state,changed:false,cueCount:0}
    const skipped=await this.transaction.query(`
      UPDATE mbox.experience_plan_cues SET status='skipped',updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND experience_plan_id=$3::uuid
        AND status IN ('pending','ready')
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,row.id])
    await this.transaction.query(`
      INSERT INTO mbox.experience_plan_activation_events(
        tenant_id,store_id,experience_plan_id,recommendation_session_id,
        recommendation_option_id,order_id,order_item_id,payment_id,event_type,
        reason_code,idempotency_key
      ) SELECT plan.tenant_id,plan.store_id,plan.id,plan.recommendation_session_id,
        plan.recommendation_option_id,plan.order_id,plan.order_item_id,$4::uuid,
        'cancelled_after_refund','fully_refunded',$5
      FROM mbox.customer_experience_plans plan
      WHERE plan.tenant_id=$1::uuid AND plan.store_id=$2::uuid AND plan.id=$3::uuid
      ON CONFLICT (tenant_id,store_id,idempotency_key) DO NOTHING
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,row.id,paymentId,
      `experience-plan-refund:${orderId}:${paymentId}`])
    return {planPublicId:row.public_id,state:'cancelled',changed:true,cueCount:skipped.rowCount??0}
  }

  async cancelAfterDefinitivePaymentFailure(orderId:string):Promise<ExperiencePlanActivationResult>{
    const reference=await this.referenceForOrder(orderId)
    if(reference===null)return {planPublicId:null,state:'absent',changed:false,cueCount:0}
    await this.transaction.query('SAVEPOINT experience_plan_failure_cancellation')
    try{
      const result=await this.cancelAfterDefinitivePaymentFailureStrict(reference,orderId)
      await this.transaction.query('RELEASE SAVEPOINT experience_plan_failure_cancellation')
      return result
    }catch(error){
      await this.transaction.query('ROLLBACK TO SAVEPOINT experience_plan_failure_cancellation')
      await this.transaction.query('RELEASE SAVEPOINT experience_plan_failure_cancellation')
      await this.recordFailure(reference,orderId,null,'payment_failure_plan_cancellation_failed')
      return {planPublicId:null,state:'failed',changed:false,cueCount:0}
    }
  }

  private async cancelAfterDefinitivePaymentFailureStrict(
    reference:OrderedRecommendationReference,orderId:string,
  ):Promise<ExperiencePlanActivationResult>{
    const plan=await this.findByOrder(orderId,true)
    if(plan===null)return {planPublicId:null,state:'absent',changed:false,cueCount:0}
    if(plan.plan_state==='cancelled')return {planPublicId:plan.public_id,state:'cancelled',changed:false,cueCount:0}
    if(plan.plan_state!=='planned')return {planPublicId:plan.public_id,state:plan.plan_state,changed:false,cueCount:0}
    const updated=await this.transaction.query(`
      UPDATE mbox.customer_experience_plans
      SET plan_state='cancelled',cancelled_reason_code='payment_failed',updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND plan_state='planned'
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,plan.id])
    if(updated.rowCount!==1)return {planPublicId:plan.public_id,state:'planned',changed:false,cueCount:0}
    await this.transaction.query(`
      INSERT INTO mbox.experience_plan_activation_events(
        tenant_id,store_id,experience_plan_id,recommendation_session_id,
        recommendation_option_id,order_id,order_item_id,payment_id,event_type,
        reason_code,idempotency_key
      )VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,NULL,
        'cancelled_after_payment_failure','payment_failed',$8)
      ON CONFLICT (tenant_id,store_id,idempotency_key) DO NOTHING
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,plan.id,
      reference.recommendationSessionId,reference.recommendationOptionId,orderId,
      reference.orderItemId,`experience-plan-payment-failed:${orderId}`])
    return {planPublicId:plan.public_id,state:'cancelled',changed:true,cueCount:0}
  }

  private async createForOrder(
    reference:OrderedRecommendationReference,
    orderId:string,
    actorRef:string,
    verifiedPaymentId:string|null,
  ):Promise<ExperiencePlanActivationResult>{
    const source=await this.lockSource(reference,orderId)
    if(source.order_status!=='submitted'||source.order_item_status!=='submitted'){
      throw new CustomerExperienceRequestError('订单已失效，不能建立体验计划','EXPERIENCE_PLAN_ORDER_INVALID',409)
    }
    const existing=await this.findByOrder(orderId)
    if(existing)return {planPublicId:existing.public_id,state:existing.plan_state,changed:false,cueCount:0}
    const requiresPayment=source.settlement_mode==='immediate_payment'
    if(requiresPayment&&verifiedPaymentId!==null){
      await this.assertSucceededPayment(orderId,verifiedPaymentId)
    }
    const active=!requiresPayment||verifiedPaymentId!==null
    const planPublicId=deterministicPublicId('experience-plan',this.transaction.scope.storeId,orderId)
    const show=await this.currentShowSnapshot(source.business_date)
    const inserted=await this.transaction.query<{id:string}>(`
      INSERT INTO mbox.customer_experience_plans(
        tenant_id,store_id,public_id,table_session_id,customer_id,
        recommendation_session_id,business_date,plan_state,party_size,
        occasion,alcohol_preference,service_intensity,promise_summary,
        selected_product_id,recommendation_option_id,
        selected_product_name_at_selection,selected_amount_minor,selected_currency,
        selected_product_snapshot,show_snapshot,created_by_actor_type,created_by_actor_ref,
        activated_at,order_id,order_item_id,payment_id,activation_gate,
        activation_idempotency_key
      )VALUES(
        $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7::date,$8,$9,$10,$11,$12,$13,
        $14::uuid,$15::uuid,$16,$17::bigint,$18,$19::jsonb,$20::jsonb,'guest',$21,
        CASE WHEN $8='active' THEN clock_timestamp() ELSE NULL END,
        $22::uuid,$23::uuid,$24::uuid,$25,$26
      )RETURNING id
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,planPublicId,
      source.table_session_id,source.customer_id,source.recommendation_session_id,
      source.business_date,active?'active':'planned',source.party_size,source.occasion,
      source.alcohol_preference,source.service_intensity,
      source.experience_intent_summary??`已按本次推荐确认 ${source.selected_product_name}`,
      source.selected_product_id,source.recommendation_option_id,source.selected_product_name,
      source.selected_amount_minor,source.selected_currency,JSON.stringify(source.display_snapshot),
      JSON.stringify(show),actorRef,source.order_id,source.order_item_id,verifiedPaymentId,
      requiresPayment?'verified_payment':'deferred_order',`experience-plan-order:${orderId}`])
    const planId=inserted.rows[0]?.id
    if(!planId)throw new Error('Experience plan insert did not return an id')
    const cueCount=active?await this.insertCues(planId,source,show):0
    await this.transaction.query(`
      INSERT INTO mbox.experience_plan_activation_events(
        tenant_id,store_id,experience_plan_id,recommendation_session_id,
        recommendation_option_id,order_id,order_item_id,payment_id,event_type,
        reason_code,idempotency_key
      )VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
        $9,$10,$11)
      ON CONFLICT (tenant_id,store_id,idempotency_key) DO NOTHING
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,planId,
      source.recommendation_session_id,source.recommendation_option_id,source.order_id,
      source.order_item_id,verifiedPaymentId,active?'created_active':'created_pending_payment',
      active?'valid_order':'awaiting_verified_payment',`experience-plan-created:${orderId}`])
    return {planPublicId,state:active?'active':'planned',changed:true,cueCount}
  }

  private async activatePaid(
    reference:OrderedRecommendationReference,orderId:string,paymentId:string|null,
  ):Promise<ExperiencePlanActivationResult>{
    const resolvedPaymentId=paymentId??await this.succeededPaymentId(orderId)
    if(resolvedPaymentId===null)throw new Error('No authoritative succeeded payment was found for plan activation')
    await this.assertSucceededPayment(orderId,resolvedPaymentId)
    let plan=await this.findByOrder(orderId,true)
    if(!plan)return this.createForOrder(reference,orderId,'payment-activation',resolvedPaymentId)
    if(plan.plan_state==='active'){
      if(plan.payment_id!==resolvedPaymentId)throw new Error('Experience plan payment binding conflicts with captured payment')
      return {planPublicId:plan.public_id,state:'active',changed:false,cueCount:0}
    }
    if(plan.plan_state!=='planned'||plan.payment_id!==null)throw new Error(`Experience plan cannot activate from ${plan.plan_state}`)
    const source=await this.lockSource(reference,orderId)
    const updated=await this.transaction.query(`
      UPDATE mbox.customer_experience_plans
      SET plan_state='active',payment_id=$4::uuid,activated_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND plan_state='planned' AND payment_id IS NULL AND activation_gate='verified_payment'
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,plan.id,resolvedPaymentId])
    if(updated.rowCount!==1)throw new Error('Experience plan lost its payment activation transition')
    const show=await this.currentShowSnapshot(source.business_date)
    const cueCount=await this.insertCues(plan.id,source,show)
    await this.transaction.query(`
      INSERT INTO mbox.experience_plan_activation_events(
        tenant_id,store_id,experience_plan_id,recommendation_session_id,
        recommendation_option_id,order_id,order_item_id,payment_id,event_type,
        reason_code,idempotency_key
      )VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
        'activated_after_payment','verified_payment_succeeded',$9)
      ON CONFLICT (tenant_id,store_id,idempotency_key) DO NOTHING
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,plan.id,
      source.recommendation_session_id,source.recommendation_option_id,orderId,
      source.order_item_id,resolvedPaymentId,`experience-plan-paid:${orderId}:${resolvedPaymentId}`])
    plan=await this.findByOrder(orderId,true)
    return {planPublicId:plan?.public_id??null,state:'active',changed:true,cueCount}
  }

  private async lockSource(reference:OrderedRecommendationReference,orderId:string):Promise<PlanSourceRow>{
    const result=await this.transaction.query<PlanSourceRow>(`
      SELECT session.id AS recommendation_session_id,option.id AS recommendation_option_id,
        item.id AS order_item_id,ordered.id AS order_id,ordered.table_session_id,
        session.customer_id,session.business_date::text,ordered.settlement_mode,
        ordered.status AS order_status,ordered.payment_status AS order_payment_status,
        item.status AS order_item_status,session.party_size,session.occasion,
        session.alcohol_preference,session.service_intensity,session.experience_intent_summary,
        option.product_id AS selected_product_id,product.name AS selected_product_name,
        option.amount_minor AS selected_amount_minor,option.currency AS selected_currency,
        option.display_snapshot
      FROM mbox.recommendation_sessions session
      JOIN mbox.recommendation_options option
        ON option.tenant_id=session.tenant_id AND option.store_id=session.store_id
       AND option.recommendation_session_id=session.id AND option.id=$4::uuid
      JOIN mbox.orders ordered
        ON ordered.tenant_id=session.tenant_id AND ordered.store_id=session.store_id
       AND ordered.id=$5::uuid AND ordered.table_session_id=session.table_session_id
       AND ordered.created_by_customer_id=session.customer_id
      JOIN mbox.order_items item
        ON item.tenant_id=ordered.tenant_id AND item.store_id=ordered.store_id
       AND item.order_id=ordered.id AND item.id=$6::uuid AND item.product_id=option.product_id
      JOIN mbox.products product
        ON product.tenant_id=option.tenant_id AND product.store_id=option.store_id
       AND product.id=option.product_id
      WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid AND session.id=$3::uuid
      FOR UPDATE OF session,ordered,item
      FOR KEY SHARE OF option,product
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,
      reference.recommendationSessionId,reference.recommendationOptionId,orderId,reference.orderItemId])
    const row=result.rows[0]
    if(!row)throw new Error('Ordered recommendation reference is invalid')
    return row
  }

  private async referenceForOrder(orderId:string):Promise<OrderedRecommendationReference|null>{
    const result=await this.transaction.query<{
      recommendation_session_id:string
      recommendation_option_id:string
      order_item_id:string
    }>(`
      SELECT recommendation_session_id,recommendation_option_id,order_item_id
      FROM mbox.recommendation_behavior_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
        AND event_type='ordered' AND recommendation_option_id IS NOT NULL
        AND order_item_id IS NOT NULL
      ORDER BY occurred_at,id LIMIT 1
      FOR KEY SHARE
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])
    const row=result.rows[0]
    return row?{
      recommendationSessionId:row.recommendation_session_id,
      recommendationOptionId:row.recommendation_option_id,
      orderItemId:row.order_item_id,
    }:null
  }

  private async findByOrder(orderId:string,lock=false):Promise<ExistingPlanRow|null>{
    const result=await this.transaction.query<ExistingPlanRow>(`
      SELECT id,public_id,plan_state,payment_id FROM mbox.customer_experience_plans
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
      ${lock?'FOR UPDATE':''}
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])
    return result.rows[0]??null
  }

  private async assertSucceededPayment(orderId:string,paymentId:string):Promise<void>{
    const result=await this.transaction.query(`
      SELECT 1 FROM mbox.payments payment JOIN mbox.orders ordered
        ON ordered.tenant_id=payment.tenant_id AND ordered.store_id=payment.store_id
       AND ordered.id=payment.order_id
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
        AND payment.id=$3::uuid AND payment.order_id=$4::uuid
        AND payment.payable_kind='order'
        AND payment.status IN ('succeeded','partially_refunded','refunded')
        AND ordered.payment_status IN ('paid','partially_refunded','refunded')
      FOR KEY SHARE OF payment,ordered
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,paymentId,orderId])
    if(result.rowCount!==1)throw new Error('Authoritative succeeded payment is required for experience activation')
  }

  private async succeededPaymentId(orderId:string):Promise<string|null>{
    const result=await this.transaction.query<{id:string}>(`
      SELECT id FROM mbox.payments
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
        AND payable_kind='order' AND status IN ('succeeded','partially_refunded','refunded')
      ORDER BY succeeded_at DESC NULLS LAST,created_at DESC,id DESC LIMIT 1
      FOR KEY SHARE
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])
    return result.rows[0]?.id??null
  }

  private async recordFailure(
    reference:OrderedRecommendationReference,orderId:string,paymentId:string|null,reasonCode:string,
  ):Promise<void>{
    await this.transaction.query(`
      INSERT INTO mbox.experience_plan_activation_events(
        tenant_id,store_id,experience_plan_id,recommendation_session_id,
        recommendation_option_id,order_id,order_item_id,payment_id,event_type,
        reason_code,idempotency_key
      )VALUES($1::uuid,$2::uuid,NULL,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,
        'activation_failed',$8,$9)
      ON CONFLICT (tenant_id,store_id,idempotency_key) DO NOTHING
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,
      reference.recommendationSessionId,reference.recommendationOptionId,orderId,
      reference.orderItemId,paymentId,reasonCode,
      `experience-plan-failed:${orderId}:${paymentId??'order'}`])
  }

  private async currentShowSnapshot(businessDate:string):Promise<JsonObject>{
    const result=await this.transaction.query<{
      schedule_id:string;performer_name:string;starts_at:string;ends_at:string;status:string
    }>(`
      SELECT schedule.id AS schedule_id,performer.stage_name AS performer_name,
        schedule.starts_at::text,schedule.ends_at::text,schedule.status
      FROM mbox.schedules schedule
      JOIN mbox.performers performer ON performer.tenant_id=schedule.tenant_id
        AND performer.store_id=schedule.store_id AND performer.id=schedule.performer_id
      JOIN mbox.stores store ON store.tenant_id=schedule.tenant_id AND store.id=schedule.store_id
      WHERE schedule.tenant_id=$1::uuid AND schedule.store_id=$2::uuid
        AND (schedule.starts_at AT TIME ZONE store.timezone)::date=$3::date
        AND schedule.status<>'cancelled'
      ORDER BY schedule.starts_at,schedule.sort_order,schedule.id
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,businessDate])
    return {schedules:result.rows.map((schedule)=>({
      scheduleId:schedule.schedule_id,performerName:schedule.performer_name,
      startsAt:schedule.starts_at,endsAt:schedule.ends_at,status:schedule.status,
    }))}
  }

  private async insertCues(planId:string,source:PlanSourceRow,show:JsonObject):Promise<number>{
    const cues=buildExperienceCues({
      serviceIntensity:source.service_intensity,occasion:source.occasion,createdAt:new Date(),show,
    })
    for(const cue of cues){
      await this.transaction.query(`
        INSERT INTO mbox.experience_plan_cues(
          tenant_id,store_id,experience_plan_id,cue_code,sequence_no,trigger_kind,
          trigger_offset_minutes,performance_phase,action_kind,station,action_payload,due_at
        )VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz)
        ON CONFLICT (tenant_id,store_id,experience_plan_id,cue_code) DO NOTHING
      `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,planId,cue.code,cue.sequence,
        cue.triggerKind,cue.triggerOffsetMinutes,cue.performancePhase,cue.actionKind,cue.station,
        JSON.stringify(cue.payload),cue.dueAt])
    }
    return cues.length
  }
}

function deterministicPublicId(kind:string,storeId:string,reference:string):string{
  return `${kind}-${createHash('sha256').update(`${kind}:${storeId}:${reference}`).digest('hex').slice(0,24)}`
}
