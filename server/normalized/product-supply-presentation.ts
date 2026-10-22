import { parseProductServiceWindow, serviceWindowState, type ProductServiceWindow } from '../../src/shared/product-service-window.js'

/** Read-only explanation. Availability and prices still come from the existing SQL/quote authorities. */
export function customerSupplyProjection(product: 'product'|'p', customer: '$9'|'$4') {
  const p=product
  return `jsonb_build_object('from',to_char(${p}.available_from,'HH24:MI'),'until',to_char(${p}.available_until,'HH24:MI'),
    'window',mbox.product_service_window_json(${p}.tenant_id,${p}.store_id,${p}.id,NULL),
    'timezone',(SELECT timezone FROM mbox.stores WHERE tenant_id=${p}.tenant_id AND id=${p}.store_id),
    'at',clock_timestamp(),'cards',CASE WHEN ${p}.guest_visible THEN '[]'::jsonb ELSE COALESCE((
      SELECT jsonb_agg(DISTINCT jsonb_build_object('window',mbox.product_service_window_json(mi.tenant_id,mi.store_id,mi.product_id,mi.project_id),'validUntil',card.valid_until))
      FROM mbox.member_card_menu_items mi JOIN mbox.member_cards card ON (card.tenant_id,card.store_id,card.project_id)=(mi.tenant_id,mi.store_id,mi.project_id)
      WHERE (mi.tenant_id,mi.store_id,mi.product_id)=(${p}.tenant_id,${p}.store_id,${p}.id) AND mi.active AND mi.exclusive
      AND card.status='active' AND card.valid_from<=clock_timestamp() AND (card.valid_until IS NULL OR card.valid_until>clock_timestamp())
      AND mbox.canonical_customer_id(card.tenant_id,card.store_id,card.customer_id)=mbox.canonical_customer_id(${p}.tenant_id,${p}.store_id,${customer}::uuid)
      AND mbox.customer_has_usable_member_card(mi.tenant_id,mi.store_id,mi.project_id,${customer}::uuid,true)
      AND mbox.service_window_deadline(mi.tenant_id,mi.store_id,mi.product_id,CASE WHEN EXISTS(SELECT 1 FROM mbox.product_service_windows w WHERE (w.tenant_id,w.store_id,w.product_id,w.card_project_id)=(mi.tenant_id,mi.store_id,mi.product_id,mi.project_id)) THEN mi.project_id ELSE NULL END,true) IS NOT NULL
    ),'[]'::jsonb) END) AS supply_presentation`
}
const weekdays=['','周一','周二','周三','周四','周五','周六','周日']
const minute=(value:number)=>`${value>=1440?'次日':''}${String(Math.floor(value%1440/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`
function describe(w:ProductServiceWindow) {
  const dates=w.dateFrom&&w.dateThrough?`${w.dateFrom}至${w.dateThrough}`:w.dateFrom?`${w.dateFrom}起`:w.dateThrough?`截至${w.dateThrough}`:''
  return [dates,w.weekdays.length===7?'每天':w.weekdays.map(day=>weekdays[day]).join('、'),`${minute(w.saleStartMinute)}–${minute(w.saleEndMinute)}`].filter(Boolean).join(' ')
}
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
function window(value:unknown){try{return parseProductServiceWindow(value)}catch{return null}}
export function customerSupplyCopy(value:unknown) {
  const data=record(value),base=window(data.window),zone=typeof data.timezone==='string'?data.timezone:'Asia/Shanghai'
  const now=typeof data.at==='string'?new Date(data.at):new Date(),parts:string[]=[]
  const rules:ProductServiceWindow[]=[]
  if(typeof data.from==='string'&&typeof data.until==='string'){
    const minutes=(v:string)=>Number(v.slice(0,2))*60+Number(v.slice(3,5)),start=minutes(data.from),end=minutes(data.until)
    if(Number.isFinite(start)&&Number.isFinite(end))rules.push({dateFrom:null,dateThrough:null,weekdays:[1,2,3,4,5,6,7],saleStartMinute:start,saleEndMinute:end<=start?end+1440:end,visibleStartMinute:start,visibleEndMinute:end<=start?end+1440:end})
  }
  if(base)rules.push(base)
  for(const rule of rules)parts.push(describe(rule))
  const cards=Array.isArray(data.cards)?data.cards.map(record):[]
  if(cards.length)parts.push(`同时满足本人持卡时段之一：${[...new Set(cards.map(card=>{
    const w=window(card.window),end=typeof card.validUntil==='string'?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'short',timeStyle:'short',hourCycle:'h23'}).format(new Date(card.validUntil)):''
    return `${w?describe(w):'按商品供应时段'}${end?`（卡有效至 ${end}）`:''}`
  }))].join(' 或 ')}`)
  const description=parts.length?`供应条件（${zone==='Asia/Shanghai'?'北京时间':zone}，须同时满足）：${parts.join('；')}`:''
  let reason='当前不在可购时段'
  // Date/weekday restrictions explain the next eligible occasion. A recurring
  // legacy daily closure must not hide them when both rules currently fail.
  const inactive=base&&!serviceWindowState(base,now,zone).active
    ?base:rules.find(rule=>!serviceWindowState(rule,now,zone).active)
  if(inactive){
    const dateParts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now)
    const part=(name:string)=>dateParts.find(p=>p.type===name)?.value??'0'
    let anchor=new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`),current=Number(part('hour'))*60+Number(part('minute'))
    if(inactive.saleEndMinute>1440&&current<inactive.saleStartMinute){anchor=new Date(anchor.getTime()-86400000);current+=1440}
    const day=anchor.toISOString().slice(0,10)
    reason=inactive.dateFrom&&day<inactive.dateFrom?'供应日期尚未开始':inactive.dateThrough&&day>inactive.dateThrough?'供应日期已结束':!inactive.weekdays.includes(anchor.getUTCDay()||7)?'当前不在供应星期':current<inactive.saleStartMinute?'本时段尚未开售':'本时段已结束'
  }else if(cards.length)reason='当前不在本人持卡可购时段'
  return {description,unavailableText:`${reason}${description?`。${description}`:''}。请核对供应时间或选择其他商品。`}
}
