import type { ScopedTransaction } from './transaction-runner.js'
import { ActivityOperationsError } from './activity-operations-repository.js'

export interface EventTicketTerms {
  organizer:string;seller:string;approvalReference:string;performers:string;durationMinutes:number;programNote:string;serviceContact:string;refundSchedule:string;requiresNamedAttendees:boolean
}
function validateRefundDisclosure(schedule:string,contact:string){
  const text=schedule.normalize('NFKC').trim()
  if(text===contact.normalize('NFKC').trim() || /^[+()\d\s.－—-]+$/.test(text))
    throw new ActivityOperationsError('退票规则不能只填客服电话。请填写适用时段、费用或金额及计算依据。','TICKET_REFUND_TERMS_INVALID',400)
}
export async function approveEventTicketTerms(tx:ScopedTransaction,activity:string,actor:string,input:EventTicketTerms,expectedVersion:number){
  validateRefundDisclosure(input.refundSchedule,input.serviceContact)
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const row=(await tx.query<{id:string}>(`SELECT id FROM mbox.community_activities WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 AND status IN('draft','published') FOR UPDATE`,[...scope,activity])).rows[0]
  if(!row)throw new ActivityOperationsError('场次已变化','TICKET_EVENT_UNAVAILABLE',409)
  const latest=(await tx.query<{v:number}>('SELECT coalesce(max(version),0)::int v FROM mbox.table_ticket_event_terms WHERE tenant_id=$1 AND store_id=$2 AND activity_id=$3',[...scope,row.id])).rows[0]!.v
  if(expectedVersion!==latest)throw new ActivityOperationsError('场次资料已更新，请刷新核对','TICKET_TERMS_CHANGED',409)
  return (await tx.query<{id:string;version:number}>(`INSERT INTO mbox.table_ticket_event_terms(tenant_id,store_id,activity_id,version,organizer,seller,approval_reference,
    performers,duration_minutes,program_note,service_contact,refund_schedule,requires_named_attendees,approved_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,version`,[...scope,row.id,latest+1,input.organizer,input.seller,input.approvalReference,
    input.performers,input.durationMinutes,input.programNote,input.serviceContact,input.refundSchedule,input.requiresNamedAttendees,actor])).rows[0]!
}

export interface TableTicketOfferInput {
  recommendInCommunity?: boolean
  expectedTermsVersion?: number
  categoryCode?:string|null
  areaId: string
  expectedVersion: number
  name: string
  priceMinor: number
  giftPoints: number | null
  status: 'draft' | 'published' | 'withdrawn'
  saleFrom?: string | null
  saleUntil?: string | null
  visibleFrom: string | null
  visibleUntil: string | null
}

export async function ticketOfferCatalog(tx: ScopedTransaction, activityPublicId: string) {
  const params = [tx.scope.tenantId, tx.scope.storeId, activityPublicId]
  const result = await tx.query<Record<string,unknown> & {
    areaId:string;status:string|null;version:number|null;name:string|null;priceMinor:number|null;giftPoints:number|null;
    categoryCode:string|null;visibleFrom:string|null;visibleUntil:string|null;saleFrom:string|null;saleUntil:string|null;
    recommendInCommunity:boolean|null;draftAuthor:string|null
  }>(`
    SELECT area.id AS "areaId", area.name AS "areaName",event_rules.terms, activity.status AS "activityStatus",
      activity.created_by_employee_id AS "creatorId",
      mbox.table_ticket_area_remaining(area.tenant_id,area.store_id,area.id,activity.starts_at,activity.ends_at) AS remaining,
      mbox.menu_category_visible_at(area.tenant_id,area.store_id,offer.category_code,statement_timestamp()) AS "categoryVisible",
      live.status='published' AS "isOnSale",offer.recommend_in_community AS "recommendInCommunity",
      ARRAY(SELECT t.code FROM mbox.tables t WHERE (t.tenant_id,t.store_id,t.area_id)=(area.tenant_id,area.store_id,area.id)
        AND t.status='available' ORDER BY t.code) AS "tableCodes", offer.category_code AS "categoryCode",
      (SELECT coalesce(jsonb_agg(jsonb_build_object('code',c.code,'name',c.display_name) ORDER BY c.sort_order,c.code),'[]') FROM mbox.menu_categories c WHERE c.tenant_id=area.tenant_id AND c.store_id=area.store_id) AS categories, offer.id, offer.version,
      offer.created_by AS "draftAuthor",offer.name, offer.price_minor AS "priceMinor", offer.gift_points AS "giftPoints",
      offer.status,offer.sale_from::text AS "saleFrom",offer.sale_until::text AS "saleUntil", offer.visible_from::text AS "visibleFrom", offer.visible_until::text AS "visibleUntil"
    FROM mbox.community_activities activity JOIN mbox.areas area
      ON (area.tenant_id,area.store_id)=(activity.tenant_id,activity.store_id)
    LEFT JOIN LATERAL (SELECT to_jsonb(e)-'tenant_id'-'store_id'-'approved_by' AS terms FROM mbox.table_ticket_event_terms e
      WHERE(e.tenant_id,e.store_id,e.activity_id)=(activity.tenant_id,activity.store_id,activity.id) ORDER BY e.version DESC LIMIT 1) event_rules ON true
    LEFT JOIN LATERAL (
      SELECT o.* FROM mbox.table_ticket_offers o
      WHERE (o.tenant_id,o.store_id,o.activity_id,o.area_id)=(activity.tenant_id,activity.store_id,activity.id,area.id)
      ORDER BY version DESC LIMIT 1
    ) offer ON true
    LEFT JOIN LATERAL (
      SELECT o.status FROM mbox.table_ticket_offers o
      WHERE (o.tenant_id,o.store_id,o.activity_id,o.area_id)=(area.tenant_id,area.store_id,activity.id,area.id)
        AND o.status<>'draft' ORDER BY version DESC LIMIT 1
    ) live ON true
    WHERE activity.tenant_id=$1 AND activity.store_id=$2 AND activity.public_id=$3
      AND (offer.id IS NOT NULL OR (area.status='active' AND EXISTS (
        SELECT 1 FROM mbox.tables t WHERE (t.tenant_id,t.store_id,t.area_id)=(area.tenant_id,area.store_id,area.id)
          AND t.status='available')))
    ORDER BY area.sort_order,area.code`, params)
  return result.rows
}

export async function saveTicketOffer(tx: ScopedTransaction, activityPublicId: string, actor: string, input: TableTicketOfferInput) {
  const scope = [tx.scope.tenantId, tx.scope.storeId]
  const activity = (await tx.query<{id:string;status:string;visibility:string;valid:boolean;refund_policy_summary:string|null}>(`
    SELECT id,status,visibility,refund_policy_summary,(ends_at > clock_timestamp() AND approved_by_employee_id IS NOT NULL
      AND refund_policy_version IS NOT NULL AND safety_policy_version IS NOT NULL) AS valid
    FROM mbox.community_activities WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 FOR UPDATE`,
    [...scope, activityPublicId])).rows[0]
  if (!activity) throw new ActivityOperationsError('找不到所选场次','ACTIVITY_NOT_FOUND',404)
  const terms=(await tx.query<{id:string;version:number;requires_named_attendees:boolean;service_contact:string;refund_schedule:string}>(`SELECT id,version,requires_named_attendees,service_contact,refund_schedule FROM mbox.table_ticket_event_terms WHERE tenant_id=$1 AND store_id=$2 AND activity_id=$3 ORDER BY version DESC LIMIT 1`,[...scope,activity.id])).rows[0]
  if (input.status === 'published') {
    if (activity.status !== 'published' || !activity.valid) throw new ActivityOperationsError('场次尚未复核或已结束，请核对场次状态','TICKET_PUBLISH_INCOMPLETE',409)
    if (activity.visibility !== 'public') throw new ActivityOperationsError('菜单售票需要场次对所有顾客可见，请先核对可见范围','TICKET_PUBLISH_INCOMPLETE',409)
    if (input.giftPoints === null) throw new ActivityOperationsError('请填写赠分数量，无赠分请填 0','TICKET_PUBLISH_INCOMPLETE',409)
    if (!terms) throw new ActivityOperationsError('请先填写并确认本场公示资料','TICKET_EVENT_TERMS_REQUIRED',409)
    validateRefundDisclosure(terms.refund_schedule,terms.service_contact)
    if(input.priceMinor>0 && activity.refund_policy_summary?.trim()==='免费活动可在开始前取消')
      throw new ActivityOperationsError('本场仍沿用免费活动的默认退款说明，请核实付费门票适用的规则。','TICKET_REFUND_TERMS_INVALID',409)
    if (terms.requires_named_attendees) throw new ActivityOperationsError('逐人实名场次须使用实名票务流程','TICKET_EVENT_TERMS_REQUIRED',409)
    if (input.expectedTermsVersion !== undefined && terms.version !== input.expectedTermsVersion) throw new ActivityOperationsError('公示版本已变化，请刷新票档后重新核对','TICKET_TERMS_CHANGED',409)
  }
  const area = (await tx.query(`SELECT id FROM mbox.areas a WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    AND ( $4='withdrawn' OR (status='active' AND EXISTS (SELECT 1 FROM mbox.tables t
      WHERE (t.tenant_id,t.store_id,t.area_id)=(a.tenant_id,a.store_id,a.id) AND t.status='available'))) FOR SHARE`,
    [...scope, input.areaId, input.status])).rows[0]
  if (!area) throw new ActivityOperationsError('所选桌区没有可用的实体桌','TICKET_AREA_UNAVAILABLE',409)
  const last = (await tx.query<{status:string;created_by:string;version:number;sale_from:string|null;sale_until:string|null;recommend_in_community:boolean}>(`SELECT status,created_by,version,recommend_in_community,sale_from::text,sale_until::text FROM mbox.table_ticket_offers
    WHERE tenant_id=$1 AND store_id=$2 AND activity_id=$3 AND area_id=$4 ORDER BY version DESC LIMIT 1`,
    [...scope, activity.id, input.areaId])).rows[0]
  if ((last?.version ?? 0) !== input.expectedVersion) throw new ActivityOperationsError('票档已更新，请刷新后核对','TICKET_VERSION_CHANGED',409)
  if(input.status==='published' && last?.status==='draft' && last.created_by===actor)throw new ActivityOperationsError('请由另一位发布人员复核该票档','TICKET_SELF_REVIEW',409)
  const saved = await tx.query<{id:string;version:number;status:string}>(`
    INSERT INTO mbox.table_ticket_offers (tenant_id,store_id,activity_id,area_id,version,name,price_minor,
      gift_points,status,visible_from,visible_until,created_by,category_code,event_terms_id,sale_from,sale_until,recommend_in_community)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id,version,status`,
    [...scope, activity.id, input.areaId, input.expectedVersion + 1, input.name, input.priceMinor,
      input.giftPoints, input.status, input.visibleFrom, input.visibleUntil, actor,input.categoryCode??null,terms?.id??null,
      input.saleFrom===undefined?last?.sale_from??null:input.saleFrom,input.saleUntil===undefined?last?.sale_until??null:input.saleUntil, input.recommendInCommunity ?? last?.recommend_in_community ?? false])
  return saved.rows[0]!
}

export interface TicketDraftSelection {areaId:string;version:number}

export async function publishTicketDrafts(tx:ScopedTransaction, activity:string, employee:string, selected:TicketDraftSelection[], termsVersion:number) {
  const catalog=await ticketOfferCatalog(tx,activity)
  const saved=[]
  for (const entry of selected) {
    const draft=catalog.find(row=>row.areaId===entry.areaId)
    if(!draft || draft.status!=='draft' || draft.version!==entry.version || !draft.name || draft.priceMinor===null)
      throw new ActivityOperationsError('票档草稿已变化，请刷新后复核','TICKET_VERSION_CHANGED',409)
    if(draft.draftAuthor===employee)
      throw new ActivityOperationsError('请由另一位发布人员复核该票档','TICKET_SELF_REVIEW',409)
    saved.push(await saveTicketOffer(tx,activity,employee,{
      areaId:entry.areaId,expectedVersion:entry.version,expectedTermsVersion:termsVersion,
      name:draft.name,priceMinor:draft.priceMinor,giftPoints:draft.giftPoints,categoryCode:draft.categoryCode,
      visibleFrom:draft.visibleFrom,visibleUntil:draft.visibleUntil,saleFrom:draft.saleFrom,saleUntil:draft.saleUntil,
      recommendInCommunity:draft.recommendInCommunity??false,status:'published',
    }))
  }
  return saved
}
