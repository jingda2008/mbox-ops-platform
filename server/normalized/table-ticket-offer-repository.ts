import type { ScopedTransaction } from './transaction-runner.js'
import { ActivityOperationsError } from './activity-operations-repository.js'

export interface EventTicketTerms {
  organizer:string;seller:string;approvalReference:string;performers:string;durationMinutes:number;programNote:string;serviceContact:string;refundSchedule:string;requiresNamedAttendees:boolean
}
export async function approveEventTicketTerms(tx:ScopedTransaction,activity:string,actor:string,input:EventTicketTerms,expectedVersion:number){
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
  const result = await tx.query(`
    SELECT area.id AS "areaId", area.name AS "areaName",event_rules.terms, offer.category_code AS "categoryCode",
      (SELECT coalesce(jsonb_agg(jsonb_build_object('code',c.code,'name',c.display_name) ORDER BY c.sort_order,c.code),'[]') FROM mbox.menu_categories c WHERE c.tenant_id=area.tenant_id AND c.store_id=area.store_id) AS categories, offer.id, offer.version,
      offer.name, offer.price_minor AS "priceMinor", offer.gift_points AS "giftPoints",
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
    WHERE activity.tenant_id=$1 AND activity.store_id=$2 AND activity.public_id=$3
      AND (offer.id IS NOT NULL OR (area.status='active' AND EXISTS (
        SELECT 1 FROM mbox.tables t WHERE (t.tenant_id,t.store_id,t.area_id)=(area.tenant_id,area.store_id,area.id)
          AND t.status='available')))
    ORDER BY area.sort_order,area.code`, params)
  return result.rows
}

export async function saveTicketOffer(tx: ScopedTransaction, activityPublicId: string, actor: string, input: TableTicketOfferInput) {
  const scope = [tx.scope.tenantId, tx.scope.storeId]
  const activity = (await tx.query<{id:string;status:string;valid:boolean}>(`
    SELECT id,status,(ends_at > clock_timestamp() AND approved_by_employee_id IS NOT NULL
      AND refund_policy_version IS NOT NULL AND safety_policy_version IS NOT NULL) AS valid
    FROM mbox.community_activities WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 FOR UPDATE`,
    [...scope, activityPublicId])).rows[0]
  if (!activity) throw new ActivityOperationsError('找不到所选场次','ACTIVITY_NOT_FOUND',404)
  if (input.status === 'published' && (activity.status !== 'published' || !activity.valid || input.giftPoints === null)) {
    throw new ActivityOperationsError('上架需要已复核的有效场次、条款及明确的赠分数量','TICKET_PUBLISH_INCOMPLETE',409)
  }
  const terms=(await tx.query<{id:string;requires_named_attendees:boolean}>(`SELECT id,requires_named_attendees FROM mbox.table_ticket_event_terms WHERE tenant_id=$1 AND store_id=$2 AND activity_id=$3 ORDER BY version DESC LIMIT 1`,[...scope,activity.id])).rows[0]
  if(input.status==='published' && (!terms || terms.requires_named_attendees))throw new ActivityOperationsError('请先核实本场公示资料。逐人实名场次须使用实名票务流程','TICKET_EVENT_TERMS_REQUIRED',409)
  const area = (await tx.query(`SELECT id FROM mbox.areas a WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    AND ( $4='withdrawn' OR (status='active' AND EXISTS (SELECT 1 FROM mbox.tables t
      WHERE (t.tenant_id,t.store_id,t.area_id)=(a.tenant_id,a.store_id,a.id) AND t.status='available'))) FOR SHARE`,
    [...scope, input.areaId, input.status])).rows[0]
  if (!area) throw new ActivityOperationsError('所选桌区没有可用的实体桌','TICKET_AREA_UNAVAILABLE',409)
  const last = (await tx.query<{version:number;sale_from:string|null;sale_until:string|null}>(`SELECT version,sale_from::text,sale_until::text FROM mbox.table_ticket_offers
    WHERE tenant_id=$1 AND store_id=$2 AND activity_id=$3 AND area_id=$4 ORDER BY version DESC LIMIT 1`,
    [...scope, activity.id, input.areaId])).rows[0]
  if ((last?.version ?? 0) !== input.expectedVersion) throw new ActivityOperationsError('票档已更新，请刷新后核对','TICKET_VERSION_CHANGED',409)
  const saved = await tx.query<{id:string;version:number;status:string}>(`
    INSERT INTO mbox.table_ticket_offers (tenant_id,store_id,activity_id,area_id,version,name,price_minor,
      gift_points,status,visible_from,visible_until,created_by,category_code,event_terms_id,sale_from,sale_until)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,version,status`,
    [...scope, activity.id, input.areaId, input.expectedVersion + 1, input.name, input.priceMinor,
      input.giftPoints, input.status, input.visibleFrom, input.visibleUntil, actor,input.categoryCode??null,terms?.id??null,
      input.saleFrom===undefined?last?.sale_from??null:input.saleFrom,input.saleUntil===undefined?last?.sale_until??null:input.saleUntil])
  return saved.rows[0]!
}
