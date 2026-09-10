export const marketingChannels=['wechat','sms','phone'] as const
export const marketingPurposes=['own_activities','mbox_joint_activities'] as const
export type MarketingChannel=typeof marketingChannels[number]
export type MarketingPurpose=typeof marketingPurposes[number]
export class MarketingContactError extends Error{constructor(message:string){super(message);this.name='MarketingContactError'}}
export interface MarketingNotice{
  operatorName:string;operatorContact:string;summary:string;withdrawalInstructions:string
  purposes:MarketingPurpose[];channels:MarketingChannel[];dataCategories:string[]
  validFrom:string;validUntil:string;consentDays:number
  contactStartMinute:number;contactEndMinute:number;weekdays:number[]
  maximumPerDay:number;maximumPerMonth:number
  // Joint activities here are contacted only by M-BOX. This is never authority
  // to export a list or let an unnamed partner independently contact a member.
  sharingMode:'no_partner_list'
}
const own=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
function text(value:unknown,label:string,max:number){if(typeof value!=='string'||value.trim().length<2||value.length>max)throw new MarketingContactError(`${label}须为2至${max}字`);return value.trim()}
function int(value:unknown,label:string,min:number,max:number){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new MarketingContactError(`${label}须为${min}至${max}的整数`);return value}
function instant(value:unknown){if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)||!Number.isFinite(Date.parse(value)))throw new MarketingContactError('告知有效期必须含时区');return new Date(value).toISOString()}
function choices<T extends string>(value:unknown,allowed:readonly T[],label:string):T[]{if(!Array.isArray(value)||!value.length||value.some(v=>!allowed.includes(v as T))||new Set(value).size!==value.length)throw new MarketingContactError(`${label}必须明确且不重复`);return [...value].sort() as T[]}
export function parseMarketingNotice(value:unknown):MarketingNotice{
  if(!own(value))throw new MarketingContactError('营销告知内容无效')
  if(value.sharingMode!=='no_partner_list')throw new MarketingContactError('独立合作方名单提供不在此许可范围，须另行具名审批和单独同意')
  const validFrom=instant(value.validFrom),validUntil=instant(value.validUntil)
  if(validUntil<=validFrom)throw new MarketingContactError('告知期限须正序，不能无限期')
  const weekdays=value.weekdays
  if(!Array.isArray(weekdays)||!weekdays.length||weekdays.some(n=>!Number.isInteger(n)||n<1||n>7)||new Set(weekdays).size!==weekdays.length)throw new MarketingContactError('须明确可联系星期')
  if(!Array.isArray(value.dataCategories)||!value.dataCategories.length||value.dataCategories.length>20)throw new MarketingContactError('须明确必要资料类型')
  const dataCategories=value.dataCategories.map(v=>text(v,'资料类型',80))
  if(new Set(dataCategories).size!==dataCategories.length)throw new MarketingContactError('资料类型不能重复')
  const result:MarketingNotice={operatorName:text(value.operatorName,'实际经营主体',200),operatorContact:text(value.operatorContact,'主体联系方式',300),summary:text(value.summary,'营销用途与范围',3000),withdrawalInstructions:text(value.withdrawalInstructions,'停止联系方法',1000),purposes:choices(value.purposes,marketingPurposes,'联系用途'),channels:choices(value.channels,marketingChannels,'联系渠道'),dataCategories,validFrom,validUntil,consentDays:int(value.consentDays,'同意有效天数',1,3660),contactStartMinute:int(value.contactStartMinute,'联系开始分钟',0,1439),contactEndMinute:int(value.contactEndMinute,'联系结束分钟',1,1440),weekdays:[...weekdays].sort(),maximumPerDay:int(value.maximumPerDay,'每日频次上限',1,100),maximumPerMonth:int(value.maximumPerMonth,'每月频次上限',1,1000),sharingMode:'no_partner_list'}
  if(result.contactStartMinute>=result.contactEndMinute||result.maximumPerDay>result.maximumPerMonth)throw new MarketingContactError('联系时段或频次上下限互相矛盾')
  return result
}
export interface MarketingConsentProof{decision:'granted'|'withdrawn'|'denied';noticeId:string;consentId:string;validUntil:string;afterLatestStop:boolean}
export interface MarketingExecutionFacts{
  channel:MarketingChannel;purpose:MarketingPurpose;now:Date;noticeId:string;noticePublished:boolean
  consent:MarketingConsentProof|null;queuedConsentId?:string
  channelReady:boolean;platformPermissionVerified:boolean;verifiedRecipient:boolean
  sentOrSubmittedToday:number;sentOrSubmittedMonth:number;unknownAttempt:boolean
}
/** Evaluated both when queueing and immediately before the send/phone handoff.
 * This function does not create platform subscription opportunities or send.
 * Include submitted/unknown attempts in counters; a timeout is not a free retry. */
export function assessMarketingContact(notice:MarketingNotice,facts:MarketingExecutionFacts){
  const deny=(reason:string)=>({allowed:false as const,reason})
  const now=facts.now.getTime()
  if(!Number.isFinite(now))throw new MarketingContactError('发送时间无效')
  if(!facts.noticePublished||now<Date.parse(notice.validFrom)||now>=Date.parse(notice.validUntil))return deny('notice_unavailable')
  if(!notice.channels.includes(facts.channel)||!notice.purposes.includes(facts.purpose))return deny('scope_not_covered')
  const consent=facts.consent
  if(!consent||consent.decision!=='granted'||!consent.afterLatestStop)return deny('not_consented')
  if(consent.noticeId!==facts.noticeId||!Number.isFinite(Date.parse(consent.validUntil))||Date.parse(consent.validUntil)<=now)return deny('consent_expired_or_scope_changed')
  if(facts.queuedConsentId!==undefined&&facts.queuedConsentId!==consent.consentId)return deny('consent_changed_since_queue')
  if(facts.unknownAttempt)return deny('previous_delivery_unknown')
  if(!facts.channelReady)return deny('channel_not_configured')
  if(!facts.verifiedRecipient)return deny('recipient_not_verified')
  if(!facts.platformPermissionVerified)return deny('channel_authority_missing')
  const local=new Date(now+8*3600000),weekday=local.getUTCDay()||7,minute=local.getUTCHours()*60+local.getUTCMinutes()
  if(!notice.weekdays.includes(weekday)||minute<notice.contactStartMinute||minute>=notice.contactEndMinute)return deny('outside_contact_window')
  int(facts.sentOrSubmittedToday,'当日已提交数',0,Number.MAX_SAFE_INTEGER);int(facts.sentOrSubmittedMonth,'当月已提交数',0,Number.MAX_SAFE_INTEGER)
  if(facts.sentOrSubmittedToday>=notice.maximumPerDay||facts.sentOrSubmittedMonth>=notice.maximumPerMonth)return deny('frequency_limit')
  return{allowed:true as const,consentId:consent.consentId}
}
