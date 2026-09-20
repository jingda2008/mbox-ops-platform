export type MembershipDomain='base_points'|'tier_policy'|'tier_benefits'|'redemption_catalog'|'promotion_points'|'membership_terms'|'wechat_notifications'
export function openMembershipConfiguration(domain:MembershipDomain,configurationId:string){
  const query=new URLSearchParams({domain,configuration:configurationId})
  window.history.pushState(null,'',`/staff/member-rule-approvals?${query}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
export const membershipPublicationPermissions:Record<MembershipDomain,string>={base_points:'loyalty.policy.publish',tier_policy:'loyalty.policy.publish',tier_benefits:'loyalty.policy.publish',redemption_catalog:'loyalty.redemption.catalog.publish',promotion_points:'loyalty.promotion.publish',membership_terms:'membership.terms.publish',wechat_notifications:'loyalty.policy.publish'}
export function membershipPublicationPath(domain:MembershipDomain,id:string,version:number){
  const encoded=encodeURIComponent(id)
  if(domain==='membership_terms')return `/api/staff/membership-terms/${version}/publish`
  if(domain==='wechat_notifications')return `/api/staff/loyalty/configuration-center/wechat_notifications/${encoded}/publish`
  const paths={base_points:'policies',tier_policy:'tier-policies',tier_benefits:'tier-benefit-policies',redemption_catalog:'redemption-catalogs',promotion_points:'promotion-policies'} as const
  return `/api/staff/loyalty/${paths[domain]}/${encoded}/publish`
}
/** Staff scheduling is always Beijing time, independent of the device timezone. */
export function beijingDateTimeIso(value:string):string{
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))throw new Error('请选择完整的北京时间')
  const date=new Date(`${value}+08:00`)
  if(!Number.isFinite(date.getTime())||new Date(date.getTime()+8*3600_000).toISOString().slice(0,value.length)!==value)throw new Error('日期或时间无效')
  return date.toISOString()
}
export function beijingDateTimeInput(iso:string){const value=new Date(iso);return Number.isFinite(value.getTime())?new Date(value.getTime()+8*3600_000).toISOString().slice(0,16):''}
