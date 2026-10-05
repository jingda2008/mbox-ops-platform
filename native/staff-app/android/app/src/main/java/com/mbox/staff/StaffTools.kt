package com.mbox.staff

data class StaffTool(val id:String,val title:String,val group:String,val detail:String)
val staffToolGroups=listOf("桌边服务","会员服务","库存与出品","经营管理","配置与发布")
fun staffTools(a:StaffIdentity?):List<StaffTool>{
 if(a==null)return emptyList()
 fun any(vararg p:String)=p.any(a::allows)
 fun route(vararg r:String)=r.any{a.hasRoute("/staff/$it")}
 return buildList{
  fun addIf(show:Boolean,id:String,title:String,group:String,detail:String){if(show)add(StaffTool(id,title,group,detail))}
  addIf(a.canOpenServiceTasks(),"service","服务任务","桌边服务","任务、紧急事项与主管转交")
  addIf(any("reservation.view")&&route("reservations"),"reservations","预约与排队","桌边服务","确认、到店、入座及历史")
  addIf(route("live","tasks","fulfillment"),"assignments","人员与责任桌","桌边服务","主责、备援、未来排班")
  addIf(any("song.view","song.manage")&&route("performance"),"songs","现场点歌","桌边服务","报价、原款与演唱处理")
  addIf(any("commercial.voucher.view")&&route("payments"),"vouchers","团购券核销与记录","桌边服务","查券、核销、原事项恢复及历史")
  addIf(any("loyalty.annual-benefit.view")&&route("member-management"),"annualPolicies","年度权益配置","配置与发布","生日、节日、优先订座与每日点心规则")
  addIf(membershipRecoveryPermissions.any(a::allows)&&route("member-management"),"membershipRecovery","历史会员找回与合并","会员服务","本人核验、候选选择与独立复核")
  addIf(any("member.card.manage")&&route("member-management"),"memberNumber","会员号规则","配置与发布","位数、起始数字与字母前缀")
  addIf(any("loyalty.account.view","loyalty.configuration.view")&&route("member-accounts","member-management"),"members","会员与签到","会员服务","扫码查询、到店签到与奖励审核")
  addIf(any("loyalty.policy.view")&&route("member-overview"),"membershipOverview","等级与权益规则","会员服务","已发布积分、成长值和等级权益")
  addIf(any("loyalty.account.view")&&route("member-accounts"),"benefitWallet","会员权益钱包","会员服务","发放、核销、取消及历史")
  addIf(any("bottle.manage.all")&&route("inventory"),"custody","会员存酒","会员服务","入库、取酒、验证码及实物交接")
  addIf(any("loyalty.redemption.fulfill")&&route("member-fulfillment"),"benefits","权益兑付","会员服务","礼遇、零食与套餐交付")
  addIf(memberCardPermissions.any(a::allows)&&route("member-management"),"memberCards","会员卡申请与项目","会员服务","申请审核、持卡状态与专属菜单")
  addIf(any("loyalty.redemption.exception")&&route("member-exceptions"),"benefitExceptions","礼遇出品异常","会员服务","原任务、重试与补偿凭证")
  addIf(any("loyalty.accrual.exception.view")&&route("member-exceptions"),"loyaltySupplements","积分对账与漏发","会员服务","核对原消费、补发申请和审核")
  addIf(canReadLoyaltyRefunds(a)&&route("member-exceptions"),"loyaltyRefund","退款积分复核","会员服务","退款归属、积分冲回与原账")
  addIf(any("loyalty.configuration.view")&&route("member-management"),"couponRefunds","退款后的券权益","会员服务","返券复核与已有补偿关联")
  addIf(StockBoard.permissions.any(a::allows)&&route("inventory"),"stock","库存与收货","库存与出品","扫码入库、采购历史与成本更正")
  addIf(any("inventory.count","inventory.waste","inventory.count.approve")&&route("inventory"),"stockAudit","盘点与报损","库存与出品","原库存、清点差异和独立审核")
  addIf(any("catalog.product.manage")&&route("inventory"),"products","商品与菜单","库存与出品","售罄、价格、分类、套餐与配方")
  addIf(canReadFulfillmentHistory(a)&&route("fulfillment","orders","payments"),"fulfillmentHistory","制作与送达历史","库存与出品","本人完成数量、共用取餐屏记录")
  addIf(any("kds.prepare")&&route("fulfillment"),"kitchen","厨房与吧台","库存与出品","当前制作批次、备齐与失败处理")
  addIf(any("kds.deliver","staff.access.configure")&&route("fulfillment","settings"),"pickup","取餐与交接","库存与出品","领取、撤回和按份送达")
  addIf(any("order.view","kds.prepare","kds.deliver","kds.exception.manage","fulfillment.view_all")&&route("fulfillment"),"fulfillment","出品异常与重做","库存与出品","原任务、主管结束与跨日记录")
  addIf(any("refund.request")&&any("inventory.receive","inventory.waste")&&route("fulfillment","payments"),"remakeHandover","离店实物交接","库存与出品","关台后原重做批次的实物去向")
  addIf(any("commercial.profit.view")&&route("operations"),"overview","经营概览","经营管理","实际收退款、成本与贡献")
  addIf((BusinessReports.allowed(a,"sales")&&route("operations"))||(BusinessReports.allowed(a,"experience")&&route("customer-experience")),"businessReports","销售与客户体验","经营管理","员工销售、客户反馈及证据分析")
  addIf(ownerPermissions.any(a::allows)&&route("operations"),"owner","经营费用与工资","经营管理","费用、周期规则与工资审核入账")
  addIf(performancePermissions.any(a::allows)&&route("performance"),"performance","演出排班与曲库","经营管理","月排班、场次修订与演出阶段")
  addIf(any("community.activity.view","community.activity.manage","community.activity.publish")&&route("customer-experience"),"activityOperations","活动运营与报名","经营管理","活动、签到、套餐领取与退款申请")
  addIf(any("marketing.notice.view","marketing.send","marketing.refusal.record","marketing.consent.audit")&&route("member-management"),"marketing","营销联系许可","经营管理","告知、本人许可历史与联系任务")
  addIf(any("member.card.manage","community.activity.manage")&&route("member-management","customer-experience"),"social","微信账号与群发","经营管理","渠道配置、原回调与活动群发")
  addIf(any("order.bill.print","print.view","print.view_all","print.reprint","hardware.manage","printer.manage")&&route("devices","payments"),"printing","票据与打印记录","库存与出品","原票据、失败重试与补打")
  addIf(any("hardware.manage","printer.manage")&&route("devices"),"devices","打印设备与路由","配置与发布","打印机、桥接器与票据策略")
  addIf(any("staff.access.configure")&&route("settings"),"staffAdministration","员工与岗位权限","配置与发布","账号、PIN、权限与门店口令")
  addIf(any("table.manage")&&route("settings"),"tableConfiguration","区域与桌台","配置与发布","容量、排序、最低消费与启停")
  addIf(any("payment.policy.manage")&&route("settings"),"commercePolicy","线上支付策略","配置与发布","支付开关与待付款库存保留")
  addIf((publicationPermissions.values+"privacy.policy.view").any(a::allows)&&route("settings","customer-experience"),"publication","顾客公开内容","配置与发布","公开服务名、联系信息与隐私政策")
  addIf(any("community.activity.view","community.activity.manage","community.activity.publish")&&route("customer-experience"),"homeContent","首页内容与排期","配置与发布","图片、活动入口、发布与暂停")
  addIf(any("community.activity.manage")&&route("customer-experience"),"launchPopup","小程序打开弹窗","配置与发布","推荐商品、文案与出现频次")
  addIf(any("loyalty.configuration.view","loyalty.operations.view")&&route("member-management","member-rule-drafts","member-rule-approvals","member-rule-publish"),"membershipConfig","会员规则与运行控制","配置与发布","草稿、审批、发布与紧急暂停")
  addIf(any("loyalty.configuration.view")&&route("member-management"),"memberGifts","会员赠礼与发放","配置与发布","活动、预算、对象与发放任务")
  addIf(any("loyalty.configuration.view")&&route("member-management"),"stackingPolicies","优惠叠加规则","配置与发布","折扣顺序、限额与价格试算")
  addIf(any("loyalty.configuration.view")&&route("member-management"),"couponCalendars","券日历与使用次数","配置与发布","期限、时段、审批与发布")
  addIf(any("recommendation.rule.view")&&route("customer-experience"),"recommendationPolicies","推荐规则与开放","配置与发布","权重、历史版本和顾客开放范围")
  addIf(any("checkout.upgrade.rule.view","fulfillment.capacity.view")&&route("customer-experience"),"checkoutManagement","升级规则与出品产能","配置与发布","商品匹配、加价限制与产能窗口")
  addIf(any("privacy.contact.retention.view")&&route("customer-experience"),"contactGovernance","联系方式保留","配置与发布","保留期限、法定保留与清除证据")
 }
}
fun filterStaffTools(tools:List<StaffTool>,query:String,group:String):List<StaffTool>{
 val terms=query.trim().split(Regex("\\s+")).filter{it.isNotBlank()}
 return tools.filter{(group.isBlank()||it.group==group)&&terms.all{q->(it.title+it.detail+it.group).contains(q,true)}}
}
