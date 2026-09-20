export function businessStatus(value:string,domain:'custody'|'sales'|'registration'|'policy'|'project'|'social'|'contact'){
  const labels:Record<string,Record<string,string>>={
    custody:{stored:'在存',collected:'已取走待处理',archived:'已归档',voided:'已作废'},
    sales:{unpaid:'未付款',pending:'付款结果待确认',partially_paid:'部分已付款',paid:'已付款',partially_refunded:'部分退款',refunded:'已退款',refund_pending:'退款处理中',closed:'已关闭',voided:'已作废'},
    registration:{reserved:'已预留待付款',no_show:'未到场',pending_payment:'待付款',paid:'已付款',confirmed:'报名成功',registered:'报名成功',checked_in:'已签到',completed:'已完成',cancelled:'已取消',expired:'已过期',refunded:'已退款',waitlisted:'候补中',payment_pending:'付款结果待确认'},
    contact:{active:'有效',inactive:'已停用',revoked:'已撤回',disposed:'已清除',pending_review:'待复核'},
    policy:{draft:'草稿',approved:'待发布',published:'已发布',active:'启用',paused:'已暂停',retired:'已停用',disabled:'关闭'},
    project:{draft:'草稿',open:'开放申请',paused:'暂停申请',closed:'已关闭'},
    social:{received:'已接收',processed:'已处理',ignored:'无需处理',failed:'处理失败',pending:'待处理',accepted:'已受理',rejected:'已拒绝',duplicate:'已处理过'},
  }
  return labels[domain]?.[value]??'状态待核对，请联系管理员'
}
export function businessCurrency(value:string){return value==='CNY'?'人民币（元）':'币种待核对'}
export function benefitKindLabel(value:string){return ({gift_product:'赠送商品',service_experience:'服务体验',activity_access:'活动名额',reservation_priority:'优先订座',customization:'定制服务',birthday_benefit:'生日礼遇',tier_benefit:'等级权益',points_redemption:'积分兑换',product:'商品',coupon:'优惠券',discount:'折扣',fixed_discount:'金额优惠',percentage_discount:'比例优惠',complimentary_product:'赠送商品',service:'服务',activity:'活动',priority_seating:'优先排座',birthday:'生日礼遇',festival:'节日礼遇',daily_snack:'每日点心',gift:'礼品'} as Record<string,string>)[value]??'权益类型待核对'}
