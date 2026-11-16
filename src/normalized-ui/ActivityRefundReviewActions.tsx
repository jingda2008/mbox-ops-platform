/** Preserve activity reviewers who do not have the broader activity cashier view. */
export function ActivityRefundReviewActions({registrationPublicId,canUseCashier,blockedReason,busy,onDecision}:{
 registrationPublicId:string;canUseCashier:boolean;blockedReason:string|null;busy:boolean;onDecision(action:'approve'|'reject'):void
}){
 if(canUseCashier)return <a href={`/staff/payments?query=${encodeURIComponent(registrationPublicId)}`} style={{display:'inline-flex',alignItems:'center',minHeight:44}}>到收银页核对退款权限与额度</a>
 if(blockedReason!==null)return <p>{blockedReason}</p>
 return <><button type="button" disabled={busy} onClick={()=>onDecision('approve')}>收银复核通过</button><button type="button" disabled={busy} onClick={()=>onDecision('reject')}>驳回</button></>
}
