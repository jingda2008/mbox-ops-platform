# 现场反馈与最新版本逐项核对

核查时间：2026-09-11 09:03 CST。用户编号12为空；其余16条有效反馈完整保留，第1/7项关联同一换桌流程。

需求状态（2026-09-11 09:12 CST）：用户已确认纳入[待开发与验收清单](field-feedback-development-requirements-20260911.md)，登记MBOX-PENDING-012。已实现部分保留原结论，仅补缺口和验收。

## 版本与核查证据

- 工作树：`/Users/jingda/mbox/mbox-member-growth-reliability-20260909`。本轮fetch后origin/main=HEAD=`b6db939d8b19e64691aebc06c7b0b3aaaf317367`；与rc.186运行提交的差异仅3份文档，业务源码相同。
- 公网readiness实时回读：`7d789f5a633e6e8a0aeb2e7f636b9981a33077ae`、schema189、workers healthy。线上角色、打印配置、图片引用和酸甜字段通过BEGIN READ ONLY核对；未修改生产数据或调用资金动作。
- 小程序ui.5记录：`1.0.0-rc.184-ui.5`，候选时间2026-09-11 00:10 CST，上传回执957829字节；app、session、首页、点单JS/模板/样式共6份相关文件与当前源码哈希一致。上传回执不是正式上线证据；本轮没有核实平台当前体验版/正式版选择。
- 本轮测试：扫码/布局82项通过；顾客链路含酸甜31项通过；服务端定向18项通过、2项数据库条件跳过；随后新建隔离数据库重测历史/换桌/履约/实际退库23项全部通过，测试库已清理。不同批次含重叠，不能简单相加为唯一覆盖数；布局代码断言不代替真机视觉验收。
- Windows桥上报仍为1.0.0，最后心跳2026-09-11 02:13:49；本轮未发测试票，不能证明当前终端在线或实物排版已验收。

## 总体判断

这些功能均可实现，但尚不能称全部修好。现有退库、历史事实查询和酸甜字段已有实现；换桌完整流程、历史页面简化、醒目金额、日报打印、月度排班和多订单合付仍有缺口。图片/iPhone问题需要区分已定位的代码条件与本次现场具体复现。

### 1. 换桌继续下单，保留两桌订单

**结论：部分已有，完整流程未完成。**

已核实：已有本人最近30笔已付/退款订单，查询不限制当前桌；但不返回/显示每笔桌号，也不含全部未付单。绑定另一活跃桌仍可能被拒绝。

可实现方式/剩余工作：可实现本人切换当前桌；原订单保留666，新订单归888，个人订单分桌展示。不能把旧桌其他顾客订单迁走。

关联：OPS-04/16。依据：[server/normalized/guest-table-orders-query.ts:76](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/guest-table-orders-query.ts:76)；[server/normalized/customer-benefit-api.ts:131](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/customer-benefit-api.ts:131)；[miniprogram/pages/account/index.wxml:14](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/miniprogram/pages/account/index.wxml:14)；

### 2. 调酒师历史制作、服务员历史送达

**结论：已具备查询基础，页面未达到需求。**

已核实：出品页有“查看制作与送达历史”跳转订单中心；线上BARTENDER和SERVER均有order.history.view。历史展示正式制作/送达员工及时间，缺原始凭据时不编造。

可实现方式/剩余工作：出品/配送页内增加待处理、已制作/已送达切换，复用现有历史事实和权限范围。

关联：OPS-01。依据：[src/normalized-ui/staff-actions/StaffActionsPanel.tsx:1159](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/StaffActionsPanel.tsx:1159)；[src/normalized-ui/OperatingHistoryPanel.tsx:80](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/OperatingHistoryPanel.tsx:80)；

### 3. 订单历史与出品界面保持一致

**结论：仍待界面简化。**

已核实：当前订单中心是多筛选字段、桌次分组、逐订单展开，未改成出品卡片式历史。

可实现方式/剩余工作：默认显示岗位相关当天卡片，桌号搜索和日期快捷切换；高级筛选折叠，保留同桌不同桌次隔离。

关联：OPS-01/12/16。依据：[src/normalized-ui/OperatingHistoryPanel.tsx:48](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/OperatingHistoryPanel.tsx:48)；

### 4. 后台图片上传后不显示

**结论：发现明确预览缺口，具体投诉对象待核对。**

已核实：上传组件可使用staffUrl预览，但商品编辑外层另有img直接用publicUrl。公开接口只允许已发布且顾客可见的引用；未发布图片在那里可能404。公网抽查已发布商品图和最新上传图均200，停用商品图404符合发布限制。

可实现方式/剩余工作：统一后台鉴权预览地址，保存后回读图片绑定；顾客端继续按公开可见规则。需具体商品/活动及未显示位置，才能确认本次现场问题根因。

关联：SYS-172。依据：[src/normalized-ui/CatalogManagementPanel.tsx:953](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CatalogManagementPanel.tsx:953)；[src/normalized-ui/MediaAssetPicker.tsx:50](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/MediaAssetPicker.tsx:50)；[server/normalized/media-asset-repository.ts:74](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/media-asset-repository.ts:74)；

### 5. 桌台消费详情显示单品金额

**结论：该入口仍缺失。**

已核实：本桌点单详情只显示名称、数量和履约状态，没有单价/小计。订单历史和取送页已有金额字段，不能代替本入口完成。

可实现方式/剩余工作：补成交单价、数量、小计、赠送/套餐包含说明；不得拿现价重算历史订单。

关联：OPS-02/20/21。依据：[src/normalized-ui/staff-actions/TableOrderStatusPanel.tsx:108](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/TableOrderStatusPanel.tsx:108)；

### 6. 酸甜度、酒水图片错版，新小程序核查

**结论：酸甜功能已进入ui.5；图片错版未证明解决。**

已核实：当前小程序列表/详情读取0—5级酸甜；与ui.5上传快照相关6个文件哈希一致。线上294条商品记录仅1条含任一数值酸甜字段，未填写不显示是正常。图片使用固定媒体区，已有布局检查，但没有本次错版的真机对照。

可实现方式/剩余工作：酸甜需同时保存数据并使用新版；空值不能当0。按用户实际机型、字体大小、图片和页面位置复现错版；发布/体验版选定单独核验。

关联：OPS-06/24。依据：[miniprogram/pages/order/index.js:245](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/miniprogram/pages/order/index.js:245)；[miniprogram/pages/order/index.wxml:59](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/miniprogram/pages/order/index.wxml:59)；[miniprogram/pages/order/index.wxss:537](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/miniprogram/pages/order/index.wxss:537)；

### 7. 扫新桌码仍显示旧桌，自动换桌

**结论：防旧缓存已有，自动换桌未完成。**

已核实：冷启动和小程序内扫码有新代次及旧请求隔离，回归通过；App只有onLaunch，没有统一onShow扫码重绑定。后台仍限制同一顾客另有活跃桌位，不能认为只清缓存就能自动迁移。热启动具体复现仍待实机。

可实现方式/剩余工作：与第1项合并：切换本人桌位，核对目标桌开放及身份；正在支付/待送达旧单保留归属并明确提醒，不迁移整桌账。

关联：OPS-04。依据：[miniprogram/app.js:29](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/miniprogram/app.js:29)；[miniprogram/utils/session.js:62](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/miniprogram/utils/session.js:62)；[server/normalized/guest-session-repository.ts:779](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/guest-session-repository.ts:779)；

### 8. 收银首页显眼展示今天总金额

**结论：尚未完成。**

已核实：顶部摘要主要显示订单/已收款笔数和退款待办，不是全营业日金额大字汇总；展开历史可按支付方式看资金流水。

可实现方式/剩余工作：顶部展示本营业日总收款、退款、净收及待收，销售额另列，注明统计时点；自然日与跨夜营业日不能混用。

关联：OPS-07。依据：[src/normalized-ui/CashierAfterSalesWorkbench.tsx:562](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CashierAfterSalesWorkbench.tsx:562)；[src/normalized-ui/OperatingHistoryPanel.tsx:64](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/OperatingHistoryPanel.tsx:64)；

### 9. 扎账：打印当日销售明细和总账单

**结论：尚未完整实现。**

已核实：当前有单笔订单账单打印；没有接通收银一键打印当日销售明细及总账单。线上daily_settlement自动策略也为关闭。

可实现方式/剩余工作：可实现截至当前时点的收工报表和营业日结束后的正式报表；这里的扎账按打印核对单理解，不提前关闭营业日。

关联：OPS-09/18/22。依据：[server/normalized/hardware-api.ts:126](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/hardware-api.ts:126)；[src/normalized-ui/OperatingHistoryPanel.tsx:78](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/OperatingHistoryPanel.tsx:78)；

### 10. 退款后酒水返回库存

**结论：受控退库已部署，专项测试通过。**

已核实：订单中心已退款/部分退款订单有实际退库入口；独立inventory.receive权限、已成功退款、数量上限、原成本回冲和防重复。未制作须先停出品，未开封仅允许可核对整包装。

可实现方式/剩余工作：已经可以按实际事实退库；退款不等于自动恢复全部库存，已调制原料不可伪造返还。真实退货和岗位入口现场验收仍需完成。

关联：OPS-10。依据：[src/normalized-ui/OperatingHistoryPanel.tsx:86](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/OperatingHistoryPanel.tsx:86)；[server/normalized/order-stock-return-repository.ts:1](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/order-stock-return-repository.ts:1)；[server/normalized/order-stock-return-repository.test.ts:1](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/order-stock-return-repository.test.ts:1)；

### 11. 制作单合张大字，付款自动桌台收据

**结论：合单和基础票据部分已有，自动付款票当前关闭，大字未完成。**

已核实：制作/配送来源已有分站点合单基础，9类策略已配置；cashier_payment=false。Windows仍上报1.0.0，当前脚本整页统一8.5/10pt，未做桌号/品名独立放大。

可实现方式/剩余工作：此次自动付款收据要求取代此前关闭自动支付凭条的口径，需开发验收后调整；收据明确本笔付款与桌台累计，部分付款不冒充全桌结清。按站点一张制作单，桌号品名加大并实物验证。

关联：OPS-11/18/20/21/22。依据：[deploy/windows-print-bridge/print-ticket.ps1:23](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/deploy/windows-print-bridge/print-ticket.ps1:23)；[server/normalized/print-ticket-source.ts:1](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/print-ticket-source.ts:1)；

### 13. iPhone赠送不能搜索商品

**结论：搜索代码存在，iPhone故障未证实修复。**

已核实：赠送入口共用搜索输入，按商品名称/编号过滤，并叠加当前分类；不是缺搜索功能。尚无具体机型、键盘和筛选状态的复现证据。

可实现方式/剩余工作：检查分类过滤导致搜不到、输入焦点、键盘遮挡、滚动与触控；需要真实iPhone验收，不能仅凭代码存在关闭。

关联：OPS-13（补充交互验收）。依据：[src/normalized-ui/staff-actions/AssistedOrderSheet.tsx:135](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/AssistedOrderSheet.tsx:135)；[src/normalized-ui/staff-actions/AssistedOrderSheet.tsx:440](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/AssistedOrderSheet.tsx:440)；

### 14. 吧台不打后厨票，调酒师不显示后厨单

**结论：纸票路由已分开，电子跨站可见原因已确认。**

已核实：线上bar→吧台、kitchen→后厨、cashier→吧台；测试后厨路由paused。调酒师角色同时有fulfillment.view_all和bar制作范围，全店可见权限使其能看到后厨单，制作权限仍按工作站控制。

可实现方式/剩余工作：纸票保持站点分流并现场验证；调酒师默认仅吧台，若需要全店只读另设明确入口。不能只改打印路由解决屏幕跨站可见。

关联：OPS-14/17。依据：[server/normalized/fulfillment-query-service.ts:123](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/fulfillment-query-service.ts:123)；[server/normalized/fulfillment-query-service.ts:268](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/fulfillment-query-service.ts:268)；

### 15. 按星期、时间、歌手生成可编辑月度演出表

**结论：已有单场排班/改期，月度规则生成未完成。**

已核实：目前新增单个日期时间场次并选择演员，可改期及处理预约影响；未找到每周规则生成整月、批量例外编辑发布入口。

可实现方式/剩余工作：可实现规则→整月预览→冲突检查→发布；例外日期可编辑，已预约场次需保留变更记录及通知，前端读发布版本。

关联：OPS-15。依据：[src/normalized-ui/StaffModulePanel.tsx:783](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/StaffModulePanel.tsx:783)；[server/normalized/reservation-performance-revision-api.ts:1](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/reservation-performance-revision-api.ts:1)；

### 16. 分次订单合并付款

**结论：当前仍逐单，完整合并收款未接通。**

已核实：桌台收款使用selectedOrderId，发起时传单个orderId；汇总可查看，不等于一次支付多单。

可实现方式/剩余工作：可实现同桌次多订单统一收款与逐单分摊；需处理部分已付、未知支付、优惠、退款和迟到多收，不直接改写为一个旧订单。跨桌合付另行定义，不由第1项自动推导。

关联：OPS-16/23（补充合并支付）。依据：[src/normalized-ui/staff-actions/TablePaymentSheet.tsx:30](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/TablePaymentSheet.tsx:30)；[src/normalized-ui/staff-actions/TablePaymentSheet.tsx:127](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/TablePaymentSheet.tsx:127)；

### 17. 调酒师不能编辑成本、套餐上架受阻

**结论：自动成本链已有，角色更正权限缺口确认。**

已核实：线上调酒师可查看成本和收货，但角色未授予inventory.cost.correct；更正按钮要求该权限。库存商品/套餐成本按物料配方自动计算，不允许随意覆盖整包成本。具体某套餐缺哪项成本尚待对象。

可实现方式/剩余工作：日常填真实采购总额入库，更新后续配方/套餐成本；历史补成本由有权人员更正，若需调酒师处理可单独授权并留审计，不绕过真实成本来源。

关联：OPS-成本链；SYS-171原因具体化。依据：[src/normalized-ui/StaffModulePanel.tsx:883](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/StaffModulePanel.tsx:883)；[src/normalized-ui/CatalogManagementPanel.tsx:706](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CatalogManagementPanel.tsx:706)；[server/normalized/inventory-api.ts:262](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/inventory-api.ts:262)；

## 新增确认风险与需求口径

SYS-172：商品编辑公开预览地址与未发布素材可见性不匹配。P2，负责人Codex，目标下一图片预览修复候选（版本待定）；待开发。完成标准：上传未发布素材、停用商品、正式在售商品均可由授权员工正确预览，顾客仍不能访问未公开素材，保存后绑定回读正确，浏览器及小程序相应入口验收。来源为第4项代码路径与公开接口规则；尚不能断言它就是用户未具名图片的唯一根因。

本轮第11项恢复自动付款收据的诉求，取代此前“自动支付凭条关闭”的目标口径；当前线上开关保持原值，尚未实施。第9项扎账定义为销售明细/总账单打印，不推导为提前结束营业日。第1/7项默认只迁移本人当前桌位，旧订单保留原桌号；配送去向、其他同桌人、未结款不静默迁移。

SYS-164/OPS既有项保持开放；本报告补充最新证据，不用旧文档中的“未部署”否认rc.185/186已上线部分，也不把上线部分推成全部OPS完成。SYS-171提示需求继续待开发，已处理¥20退款不重开。

原始只读及测试证据：`artifacts/feedback-verification-20260911/`。本轮只核对与更新需求/状态文档，没有改业务代码、提交合并、部署或小程序上传。
