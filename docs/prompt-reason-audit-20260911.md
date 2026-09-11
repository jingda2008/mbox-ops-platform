# 各岗位提示具体原因专项排查

审计日期：2026-09-11，北京时间。源码基线 `b6db939d8b19e64691aebc06c7b0b3aaaf317367`。工作树 `/Users/jingda/mbox/mbox-member-growth-reliability-20260909`。

结论：确认存在系统提示设计和原因传递缺口，本轮归并为 **31项可整改问题**。这是源码路径的问题数，不是31笔线上事故，也不表示所有不可售/失败本身都是系统故障。用户确认已处理的¥20退款不在排查范围。

需求状态（2026-09-11 08:47 CST）：用户已确认31项正式列入[待开发需求](prompt-reason-development-requirements-20260911.md)，关联SYS-171 / MBOX-PENDING-011；尚未开始实施。

## 覆盖与证据边界

- 扫描588个源代码/模板文件，得到1182处关键词候选；保留完整候选JSON和CSV。关键词候选不是缺陷计数，包含正常状态、测试之外的内部代码及历史页面。
- 根据当前Web入口`src/main.tsx`递归解析本地导入，得到121个可达文件；`src/components`命中的162处中，仅3处位于当前入口可达文件。旧版CommerceView、PaymentView、OperationsConsole等没有当作当前岗位页面重复报错。
- 核对配置全部14个岗位及导航；审核员工Web、服务端原因映射，扩展检查微信/支付宝顾客端。权限按实际有效授权决定，下面岗位名称表示相关场景，不保证所有该岗位员工都有操作权。
- 对下表逐项回看条件分支、接口或渲染证据；未逐一在线触发所有错误，未进行真实资金、实体打印或14账号实机验收。静态字符串搜索无法证明运行时生成提示、外部设备提示及全部未知错误已经穷尽。
- 本轮只生成审计材料并登记风险，没有修改业务代码、线上配置或业务状态；不是修复/部署完成报告。

| 岗位 | 配置导航覆盖 |
|---|---|
| 老板 | 现场、收银与退款、预约、演出与点歌、库存、设备、经营分析、客户体验与活动、系统配置 |
| 运营负责人 | 现场、任务、预约、演出与点歌、库存、经营分析、客户体验与活动、经营配置 |
| 系统管理员 | 系统配置、设备 |
| 店长 | 现场、任务、出品、预约、退款发起、演出与点歌、库存、经营分析、客户体验与活动、经营配置 |
| 副店长 | 现场、任务、出品、预约、演出与点歌、客户体验、库存 |
| 服务员 | 现场、任务、取送、预约、演出与点歌、会员权益待办 |
| 门迎 | 预约到店、现场 |
| 调酒师 | 吧台出品、吧台库存 |
| 收银员 | 收银复核、预约 |
| 后厨 | 后厨出品、后厨库存 |
| 舞台运营 | 演出点歌 |
| 调音灯光 | 演出现场 |
| 市场运营 | 预约、客户与活动、客户与销售 |
| 市场设计 | 活动预约、演出与点歌 |

## 逐项清单

P1表示优先处理可能导致误操作、错误归因或重复处理的提示；P2表示可解释性、可定位性与操作效率问题。优先级是本次评估，不代表已发生损失。下面拟定措辞所需数字、人员、时间必须来自真实数据。

### PR-01 · 套餐不可售原因混为一谈（P1）

- 涉及：商品配置。
- 当前提示：当前供应时段或组合内容未满足。
- 已核实缺口：只返回/消费可售布尔值，无法定位停售子商品、缺少选项还是供应窗口。
- 整改要求：返回全部阻断项：套餐、子商品名称/编号、实际停售状态；时段问题才显示北京时间和供应窗口。
- 代码依据：[src/normalized-ui/CatalogManagementPanel.tsx:1185](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CatalogManagementPanel.tsx:1185)；[server/normalized/catalog-api.ts:2348](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/catalog-api.ts:2348)。

### PR-02 · 只显示第一个阻断原因（P2）

- 涉及：商品配置。
- 当前提示：待完成：blockers[0]。
- 已核实缺口：多个真实原因同时存在时只看到第一项，逐次修完才发现下一个。
- 整改要求：卡片显示首项及另有N项，可展开全部阻断项；不要覆盖其余原因。
- 代码依据：[src/normalized-ui/CatalogManagementPanel.tsx:1007](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CatalogManagementPanel.tsx:1007)；[src/normalized-ui/CatalogManagementPanel.tsx:1177](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CatalogManagementPanel.tsx:1177)。

### PR-03 · 引用失效物料但不指明对象（P2）

- 涉及：商品/库存/活动配置。
- 当前提示：当前配方引用了已不可用的库存物料；已选物料当前不可用。
- 已核实缺口：配方已有物料ID；活动下拉只返回启用物料，丢失旧项名称与失效原因。不能单凭查不到就断言已停用。
- 整改要求：保留引用名称/编号；服务端在授权范围内区分停用、删除或未读到；列出受影响配方行。
- 代码依据：[src/normalized-ui/CatalogManagementPanel.tsx:350](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CatalogManagementPanel.tsx:350)；[src/normalized-ui/ActivityOperationsPanel.tsx:676](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/ActivityOperationsPanel.tsx:676)。

### PR-04 · 不可点提示没有具体商品条件（P1）

- 涉及：服务员/店长等协助点单岗位。
- 当前提示：库存或配方配置未完成；当前暂不可点。
- 已核实缺口：assistedAvailabilityReason只有三类兜底，无法解释套餐组件、渠道或售价原因。
- 整改要求：与商品页共用原因合同，显示阻断商品及可执行处理入口。
- 代码依据：[src/normalized-ui/staff-actions/AssistedOrderSheet.tsx:734](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/AssistedOrderSheet.tsx:734)；[src/normalized-ui/staff-actions/AssistedOrderSheet.tsx:461](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/AssistedOrderSheet.tsx:461)。

### PR-05 · 商品失效合并为下架或价格失效（P1）

- 涉及：点单/收银。
- 当前提示：订单中有商品已下架或价格失效。
- 已核实缺口：OrderProductUnavailableError只带商品ID文字，接口抹掉对象且不区分具体条件。
- 整改要求：结构化返回失效商品和确切条件，例如标准售价缺失；刷新后高亮对应行。
- 代码依据：[server/normalized/commerce-kds-api.ts:1793](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/commerce-kds-api.ts:1793)；[server/normalized/order-repository.ts:241](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/order-repository.ts:241)。

### PR-06 · 已知库存数字被丢弃（P1）

- 涉及：点单/库存。
- 当前提示：部分商品库存不足，请调整订单后重试。
- 已核实缺口：异常已经包含sku、availableQuantity、requiredQuantity，接口没有展示。
- 整改要求：员工按权限显示物料名、单位、可用量、需求量和缺口；顾客只显示商品售罄，不暴露成本或库存内部信息。
- 代码依据：[server/normalized/commerce-kds-api.ts:1802](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/commerce-kds-api.ts:1802)；[server/normalized/inventory-repository.ts:323](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/inventory-repository.ts:323)。

### PR-07 · 缺配方与缺库存余额被合并（P1）

- 涉及：点单/库存管理。
- 当前提示：商品库存配置不完整，请联系值班经理。
- 已核实缺口：InventoryRecipeMissingError与InventoryBalanceMissingError被映射为同一原因。
- 整改要求：分别指出哪件商品缺有效配方、哪件物料缺余额记录；给对应配置/入库入口。
- 代码依据：[server/normalized/commerce-kds-api.ts:1798](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/commerce-kds-api.ts:1798)；[server/normalized/inventory-repository.ts:310](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/inventory-repository.ts:310)。

### PR-08 · 额度不足与授权失效等混用（P1）

- 涉及：有赠送权限的岗位。
- 当前提示：本次赠送超过当前岗位额度，或赠送权限已失效。
- 已核实缺口：PricingAuthorizationDeniedError还可能来自授权来源不一致等原因，不能一概归因额度。
- 整改要求：权限、授权过期、来源不匹配、金额超限各自编码；金额不足时显示申请额、可用额度和授权处理人入口。
- 代码依据：[server/normalized/commerce-kds-api.ts:1808](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/commerce-kds-api.ts:1808)；[server/normalized/pricing-authorization-policy.ts:65](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/pricing-authorization-policy.ts:65)。

### PR-09 · 制作或送达状态冲突不显示当前状态（P1）

- 涉及：调酒师/后厨/配送/店长。
- 当前提示：出品状态已经变化；尚未完成制作或已被处理。
- 已核实缺口：状态冲突与送达阻断缺当前状态、操作目标及下一步。
- 整改要求：返回当前状态、已确认发生的操作及时间；只有有审计事实才显示操作人。
- 代码依据：[server/normalized/commerce-kds-api.ts:1811](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/commerce-kds-api.ts:1811)；[server/normalized/kds-repository.ts:89](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/kds-repository.ts:89)。

### PR-10 · 失败出品卡不带原失败原因（P1）

- 涉及：调酒师/后厨/配送/店长。
- 当前提示：制作失败，等待重新制作或后续处理。
- 已核实缺口：fulfillment查询没有异常原因字段，attentionMessages只来自订单/商品备注；异常记录实际另存reason_code/reason_note。
- 整改要求：关联原异常记录，显示失败类型、现场说明、记录时间及后续处理；无记录时明确未记录原因。
- 代码依据：[src/normalized-ui/staff-actions/StaffActionsPanel.tsx:1190](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/StaffActionsPanel.tsx:1190)；[server/normalized/fulfillment-query-service.ts:353](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/fulfillment-query-service.ts:353)。

### PR-11 · 批量操作失败被错误归因（P1）

- 涉及：店长/副店长等历史结案岗位。
- 当前提示：另有N项状态已变化或权限不足。
- 已核实缺口：catch无条件吞掉所有错误，网络/服务错误也被归因状态或权限；无法知道具体失败项。
- 整改要求：保留逐项结果：桌号、商品、成功/拒绝/未知、实际错误码和说明；未知项先回读。
- 代码依据：[src/normalized-ui/staff-actions/StaffActionsPanel.tsx:827](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/StaffActionsPanel.tsx:827)；[src/normalized-ui/staff-actions/StaffActionsPanel.tsx:840](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/staff-actions/StaffActionsPanel.tsx:840)。

### PR-12 · 打印失败码已有但页面未展示（P1）

- 涉及：系统管理员/设备管理。
- 当前提示：打印失败待办；已尝试N次。
- 已核实缺口：后台mapPrintJob返回failureCode，当前设备页仅显示打印机、次数、来源、时间。
- 整改要求：翻译受支持的失败码，显示原任务编号、最后错误及时间；明确未发送与出纸未知，未知不得提示盲目重打。
- 代码依据：[src/normalized-ui/StaffModulePanel.tsx:1568](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/StaffModulePanel.tsx:1568)；[server/normalized/hardware-repository.ts:893](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/hardware-repository.ts:893)。

### PR-13 · 票据未生成混淆原因（P1）

- 涉及：系统管理员/票据生成。
- 当前提示：无有效路由或业务已失效，未生成。
- 已核实缺口：接口已有lastErrorCode，前端Source类型及渲染忽略它；无法辨别具体跳过/停止原因。
- 整改要求：显示lastErrorCode安全中文映射及来源，区分主动关闭、路由缺失、业务终止或未知，不把正常关闭当故障。
- 代码依据：[src/normalized-ui/PrintSourceRecoveryPanel.tsx:6](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/PrintSourceRecoveryPanel.tsx:6)；[server/normalized/hardware-api.ts:198](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/hardware-api.ts:198)。

### PR-14 · 明确拒绝也被说成结果未知（P2）

- 涉及：系统管理员/票据恢复。
- 当前提示：操作结果未确认，请刷新核对。
- 已核实缺口：catch完全不读异常，后端的仅失败任务可重试等明确说明也丢失；原因不足3字按钮静默禁用。
- 整改要求：保留明确业务拒绝；只有超时/断网才提示未知；输入旁显示至少3字和还差几字。
- 代码依据：[src/normalized-ui/PrintSourceRecoveryPanel.tsx:29](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/PrintSourceRecoveryPanel.tsx:29)；[server/normalized/hardware-api.ts:217](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/hardware-api.ts:217)。

### PR-15 · 预约、演出、点歌状态冲突笼统（P2）

- 涉及：门迎/预约/舞台相关岗位。
- 当前提示：当前预约/演出/点歌状态不允许此操作。
- 已核实缺口：三类状态冲突统一不带当前状态、目标动作和合法后续动作。
- 整改要求：在原权限内返回当前状态与可操作项，例如已取消预约不可签到；必要时刷新后显示最近变更。
- 代码依据：[server/normalized/reservation-performance-api.ts:1460](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/reservation-performance-api.ts:1460)；[server/normalized/song-request-repository.ts:110](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/song-request-repository.ts:110)。

### PR-16 · 六种点歌资格失败折叠（P1）

- 涉及：舞台运营/点歌协助岗位。
- 当前提示：当前桌次或演出安排暂不支持该点歌请求。
- 已核实缺口：底层分别检查开台、场次可用、当日当前/下一歌手、加时对象、歌手状态、可唱歌单。
- 整改要求：六类原因独立中文：尚未开台、场次结束、歌手不在当前/下一场、仅当前歌手可加时、歌手停用、歌曲不在歌单。
- 代码依据：[server/normalized/reservation-performance-api.ts:1465](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/reservation-performance-api.ts:1465)；[server/normalized/song-request-repository.ts:157](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/song-request-repository.ts:157)。

### PR-17 · 桌位不可预约不显示条件（P2）

- 涉及：门迎/预约。
- 当前提示：所选桌位当前不可预约；所选桌位在该时段已不可预约。
- 已核实缺口：缺所选时段和阻断类型；不同原因需要不同改选动作。
- 整改要求：显示桌号、所选时间和可公开的阻断条件，提供可预约时间；不泄露其他顾客信息。
- 代码依据：[server/normalized/reservation-performance-api.ts:1450](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/reservation-performance-api.ts:1450)；[server/normalized/reservation-repository.ts:222](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/reservation-repository.ts:222)。

### PR-18 · 可能把源桌问题说成目标桌不可用（P1）

- 涉及：现场转桌/拆桌岗位。
- 当前提示：目标桌台当前不可用。
- 已核实缺口：同一查询同时要求目标区域启用、目标桌可用和源桌次open；无行统一归因为目标桌。
- 整改要求：在同一事务/权限范围内分别判断源桌已结束、目标桌停用、区域停用等，再返回准确原因。
- 代码依据：[server/normalized/table-management-api.ts:268](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/table-management-api.ts:268)；[server/normalized/table-management-api.ts:257](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/table-management-api.ts:257)。

### PR-19 · 所有非有效会员状态都称受限（P2）

- 涉及：客户体验/会员管理。
- 当前提示：会员状态受限。
- 已核实缺口：membershipStatus已有实际值，界面只区分active与其他状态。
- 整改要求：显示真实状态中文、允许的操作；如需解释状态成因，另取有权限的审计记录，不能猜测。
- 代码依据：[src/normalized-ui/CustomerExperienceManagementPanel.tsx:317](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CustomerExperienceManagementPanel.tsx:317)；[src/normalized-ui/CustomerExperienceManagementPanel.tsx:317](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CustomerExperienceManagementPanel.tsx:317)。

### PR-20 · 权益不可用多因合并且可能误导（P1）

- 涉及：会员权益核销/服务员。
- 当前提示：权益已过期、已用完或状态已变化。
- 已核实缺口：同类异常还承载客户身份同步、仅原桌申请、已由其他请求核销等具体原因，全部被盖掉。
- 整改要求：按可核实原因显示到期日、剩余/占用次数或身份同步中；并说明是否已占用/核销。
- 代码依据：[server/normalized/customer-benefit-api.ts:964](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/customer-benefit-api.ts:964)；[server/normalized/benefit-repository.ts:740](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/benefit-repository.ts:740)。

### PR-21 · 权限与赠送额度混合（P1）

- 涉及：权益赠送/审批岗位。
- 当前提示：当前账号无权执行此操作，或赠送额度不足。
- 已核实缺口：StaffAccessDeniedError与BenefitAuthorizationError映射为同一提示。
- 整改要求：拆分缺操作权限、缺桌台责任权限、额度不足；只显示当前授权范围可见信息。
- 代码依据：[server/normalized/customer-benefit-api.ts:951](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/customer-benefit-api.ts:951)；[server/normalized/customer-benefit-api.ts:950](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/customer-benefit-api.ts:950)。

### PR-22 · 不可用日期没有排除原因（P2）

- 涉及：运营/优惠券规则。
- 当前提示：不可用；没有任何可用时段。
- 已核实缺口：日历仅返回日期与windows，无法指出星期不符、排除日期、绝对/相对有效期哪项清空了窗口。
- 整改要求：每个空日期返回原因列表；全部为空时指出冲突规则及其交集，而非让员工逐项猜。
- 代码依据：[src/normalized-ui/CouponCalendarPreviewPanel.tsx:102](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CouponCalendarPreviewPanel.tsx:102)；[src/normalized-ui/CouponCalendarPreviewPanel.tsx:7](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/CouponCalendarPreviewPanel.tsx:7)。

### PR-23 · 购物车、报价和券规则多因混合（P2）

- 涉及：优惠试算/结算协助。
- 当前提示：购物车为空或有暂不可售商品；券种不适用此入口或剩余份数不足。
- 已核实缺口：条件使用复合判断，只生成一个文本；报价过期、购物车变化和会员离桌也合并。
- 整改要求：逐项结构化说明具体券/商品/条件；报价过期显示重新报价，数量不足显示剩余份数。身份不匹配保持必要隐私。
- 代码依据：[server/normalized/checkout-cart-pricing.ts:17](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/checkout-cart-pricing.ts:17)；[server/normalized/checkout-coupon-repository.ts:38](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/checkout-coupon-repository.ts:38)。

### PR-24 · 影响预览只给风险类别（P2）

- 涉及：运营/会员配置审批。
- 当前提示：库存可能不足；需要复核人工履约能力。
- 已核实缺口：Preview.warnings是字符串类别数组，没有受影响对象和判断依据；不能把风险提示当已证实库存不足。
- 整改要求：补充触发依据、商品/规则、数据时点和缺失信息；估算明确标明估算。
- 代码依据：[src/normalized-ui/MembershipConfigurationCenterPanel.tsx:18](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/MembershipConfigurationCenterPanel.tsx:18)；[src/normalized-ui/MembershipConfigurationCenterPanel.tsx:14](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/MembershipConfigurationCenterPanel.tsx:14)。

### PR-25 · 取消原因长度规则没说清（P2）

- 涉及：会员/年度礼遇操作。
- 当前提示：取消原因不足，未释放每日点心暂留。
- 已核实缺口：此处判断至少2字，但弹窗描述及错误未说明数字。审批弹窗已有至少2字，不能一并误判。
- 整改要求：输入前明示至少2字，错误显示实际长度/差额；同类字段统一检查但不覆盖已合格提示。
- 代码依据：[src/normalized-ui/AnnualBenefitManagementPanel.tsx:251](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/AnnualBenefitManagementPanel.tsx:251)；[src/normalized-ui/AnnualBenefitManagementPanel.tsx:250](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/AnnualBenefitManagementPanel.tsx:250)。

### PR-26 · 活动套餐暂不可订无具体原因（P2）

- 涉及：活动运营及顾客活动页。
- 当前提示：暂不可订/暂不可选。
- 已核实缺口：publicActivityPackages将未发布、不在窗口、库存不可用合并为temporarily_unavailable。付款blockedReason另有字段，不能混为此缺陷。
- 整改要求：员工显示确切发布/时段/库存原因，顾客显示适当业务解释与下次开放时间。
- 代码依据：[server/normalized/customer-experience-repository.ts:5675](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/customer-experience-repository.ts:5675)；[server/normalized/customer-experience-repository.ts:5698](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/customer-experience-repository.ts:5698)。

### PR-27 · 安全错误映射过粗且有码缺映射（P2）

- 涉及：微信/支付宝顾客端，影响服务员解释。
- 当前提示：每日点心暂时无法申请；有商品暂时无法供应。
- 已核实缺口：中文白名单是正确安全边界，但部分明确错误仍共用兜底；不应直接透传后台原文。
- 整改要求：扩展两端一致的安全原因码字典；未知码保留未知说明及查询编号。商品时段已有明确范围的提示保留。
- 代码依据：[miniprogram/utils/customer-error.js:14](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/miniprogram/utils/customer-error.js:14)；[alipay-miniprogram/utils/customer-error.js:14](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/alipay-miniprogram/utils/customer-error.js:14)。

### PR-28 · 非JSON响应可能显示英文且普通客户端丢查询编号（P2）

- 涉及：全部员工岗位公共请求层。
- 当前提示：response.statusText；请求超时，请重试。
- 已核实缺口：NormalizedApi客户端未提取referenceId，KDS服务已对500生成该编号；非JSON可能显示Bad Gateway等。另一staff-actions客户端已有referenceId，不能称全端缺失。
- 整改要求：统一中文兜底、操作名称、时间和查询编号；仅使用已确认网络/超时事实；资金与写操作先核对原请求。
- 代码依据：[src/normalized-api.ts:287](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-api.ts:287)；[server/normalized/commerce-kds-api.ts:1742](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/commerce-kds-api.ts:1742)。

### PR-29 · 库存错误类型混合且可能直接显示英文（P2）

- 涉及：调酒师/后厨/库存管理。
- 当前提示：INVENTORY_CONFLICT / Insufficient inventory for…。
- 已核实缺口：InsufficientInventory与幂等冲突等共用code；直接error.message导致已存在的英文库存异常暴露。数据库多种约束也合并。
- 整改要求：按类型做中文安全映射，库存不足保留单位与数量，幂等处理中引导查询；未知数据库故障不编造经营原因。
- 代码依据：[server/normalized/inventory-api.ts:1511](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/inventory-api.ts:1511)；[server/normalized/inventory-repository.ts:323](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/inventory-repository.ts:323)。

### PR-30 · 产能不足没有具体工作站和时段（P2）

- 涉及：点单/出品/运营配置。
- 当前提示：该出品时段的可用产能已满。
- 已核实缺口：数据库异常映射只有类别，缺是哪一窗口、哪种出品受限；配置缺失也不指出规则。
- 整改要求：补充工作站、北京时间窗口、占用与容量、可接受下一时段；只有权威容量结果才显示数字。
- 代码依据：[server/normalized/fulfillment-capacity-repository.ts:81](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/fulfillment-capacity-repository.ts:81)；[server/normalized/fulfillment-capacity-repository.ts:89](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/server/normalized/fulfillment-capacity-repository.ts:89)。

### PR-31 · 线上收款渠道不可用缺配置原因（P2）

- 涉及：收银/系统配置。
- 当前提示：策略开放 · 渠道不可用。
- 已核实缺口：presentation输入只有providerConfigured布尔值，不能判断缺哪项配置。策略开关与渠道状态已经区分，此处缺更具体诊断。
- 整改要求：收银显示渠道配置待管理员处理；管理员显示缺少配置项名称和检查时点，不显示密钥内容。
- 代码依据：[src/normalized-ui/payment-policy-presentation.ts:17](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/payment-policy-presentation.ts:17)；[src/normalized-ui/payment-policy-presentation.ts:1](/Users/jingda/mbox/mbox-member-growth-reliability-20260909/src/normalized-ui/payment-policy-presentation.ts:1)。

## 不误报为缺陷的情况

1. `failed/退款失败/已失效`作为列表状态标签本身合理，只有缺必要原因及处理路径才列问题。
2. 普通页面catch保留`error.message`的，不因备用文本“读取失败”就算已丢失后台原因。例如转桌人员预检页面还展示blockers；不是只有笼统报错。
3. 付款/退款“结果尚未确认，先查单不要重复付款”必须保留。断网不能证明服务未执行，不能改成“操作失败、没有扣款”。
4. 客群分析已经显示筛选不可用的具体数据依据；营销触达已有细分reason-code中文映射；摄像头不可用已有替代录入说明；顾客菜单scheduled状态已显示供应时段。这些做法应复用。
5. 年度礼遇审批弹窗已写“至少2个字”，不因后续“说明不足”重复计缺陷；PR-25针对未写阈值的取消入口。
6. 隐私/越权请求不得为了具体而泄露其他顾客、员工、库存成本、凭据或数据库内部结构。存在性不可披露时可保留“记录不存在或无权访问”，同时给合法验证/联系路径。

## 待进一步验证项，不计入31项确认清单

- 收银退款卡`CashierAfterSalesWorkbench.tsx:1479`显示“上次提交支付渠道失败”，未在该段看到渠道失败详情；需要进一步核对查询合同、失败日志与可安全公开字段后决定修改范围。本次没有重新查询已关闭的¥20退款。
- 会员礼遇历史状态“出品失败，已取消并释放”是否应有原始异常展开入口，需按各履约种类核对；与PR-10普通出品待办接口缺原因分开验收，不能凭状态标签直接定错。
- 仅剩布尔结果或历史原因未记录的接口，应先补明确原因来源；没有证据时显示“原始原因未记录”，不要回填推测原因。

## 统一验收口径

提示包含：**哪个对象 → 已确认原因 → 当前结果/是否已执行 → 下一步及合适处理岗位**。有多个阻断项要能展开全部；表单禁用要能看见具体缺项和阈值。

- 有原因码：展示安全中文并保留查询编号。只在权限允许且数据确定时显示商品/物料名、数量单位、时间或处理人。
- 结果不明：说明等待核对的原订单/请求，查询后恢复操作；不伪造失败、不创建第二笔资金动作。
- 同类原因统一来自一套结构化合同，供商品配置、员工点单、顾客Web、微信与支付宝消费；不能各自猜测isAvailable=false。
- 优先验收PR-01/04—13/16/18—21，其余并行纳入后续提示整治。实际开发应给每个原因建立有意义的分支测试，并检查权限脱敏、多因并存和并发状态变化；本次文档排查不运行无关全量测试。

## 交付文件

- `artifacts/prompt-reason-audit-20260911/findings.json`：31项归并问题及建议。
- `artifacts/prompt-reason-audit-20260911/candidates.json` / `candidates.csv`：1182处原始候选，未经逐条线上验收，不应直接作为缺陷工单导入。
- `artifacts/prompt-reason-audit-20260911/coverage.json`：14岗位导航及当前Web入口可达文件。

SYS-171：提示具体原因专项；负责人Codex（原因合同与呈现）、门店各岗位负责人（现场验收）；目标为下一提示整改候选，尚未排定版本。完成条件：31项逐条修复或给出可核实豁免、补充待验证项结论、定向测试通过、正式发布及真实岗位验收；不可凭本报告关闭。
