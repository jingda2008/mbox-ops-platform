# 双端业务合同 v0.1

Swift `Domain.swift` 与 Kotlin `Domain.kt` 为独立原生实现，遵循同一行为合同。前8条描述本机演练；真实接口遵循后续条目和服务器合同，客户端构建不代表真实支付验收。

1. 命令携带 request id、table id、expected session；先查询原命令回执，再校验当前桌次。因此已成功且随后关台的旧请求恢复也只返回原回执。
2. 原编号原载荷 → 原回执且不新增订单/收款；原编号不同载荷 → 拒绝。
3. 开台必须为空桌，人数介于 1 与容量；打开新桌次，旧草稿不可带入。
4. 点单逐项核对商品、售罄、价格、规格、数量；重复商品规格行拒绝；成功增加账单且清除本桌次草稿。
5. 现金要求原款已确认、待收大于零。记账=min(顾客交付,待收)，找零=max(0,交付−记账)。支持部分收款；禁止超过上限的输入。
6. 关台要求待收为零、无未知付款、无服务任务、无未送订单。结清本身不释放桌台。
7. 转台保持桌次、账单、款项、服务及草稿；目标必须空闲且容量够。来源桌恢复为空。
8. 请求在执行前保存，处理后保存世界和日志，最后确认清除未决标记；中断保留请求，禁止新命令及重置。
9. 真实模式使用独立 StaffAPI：门店设备准入、登录/切换/退出、心跳、桌台与本桌订单读取；不保存口令/PIN，会话只驻留内存。
10. 第一批真实写入仅开台、转台、两阶段关台、加购冻结/恢复、服务完成；按钮同时校验员工权限、operations capabilities、会话租约、数据新鲜度和未决请求。服务器继续最终授权。
11. 发送前原子保存请求；原员工按原载荷与原幂等键恢复。每个成功步骤校验 data/meta 回执并持久化进度；全部写入完成后仍须刷新服务器状态才清除请求。401清空旧身份，未决操作不丢失。
12. 仅明确业务拒绝允许清除失败请求；TABLE_OPERATION_CONFLICT、IDEMPOTENCY_IN_PROGRESS、断网、服务器错误或无法识别的成功响应都保留原请求。不能靠HTTP状态码409判断一定未执行。
13. 本机演练、真实桌台原请求分开存储；真实订单另存不可变请求：原publicId查询确认、原employee/session绑定，仅同登录同营业日允许原键重放；跨登录查无结果仍未知，不能换号重下。

真实接口合同来源：`src/normalized-api.ts`、`src/normalized-ui/staff-actions/staff-actions-api.ts`、`src/normalized-ui/staff-actions/types.ts`。真实 POST 接口有不同幂等头、套餐结构、辅助下单上下文和闭台两阶段过程；不得将演练命令直接映射为盲目重试请求。

14. 真实商品只读取 assisted-order-products 的价格、库存与渠道，目录失效不能加菜；草稿按员工和桌次隔离，不混用演练商品。套餐逐套保留 choices，发送订单时按 productId 合并 quantity/bundleSelections；同商品共用备注不超过300 UTF-16字符。真实提交使用assisted context及服务端最新价格/库存/权限；成功回执必须绑定原publicId/tableSessionId，随后只清理原提交draftIDs。

15. 礼赠强制table_tab，校验order.gift、gift额度/CNY及原因；已付商品选择table_tab或immediate_payment，不把paymentNextStep当作已收。
16. payment-orders为应收来源；存在未知线上款不登记新收款。现金/POS/外部登记固定publicId、原订单id、金额、凭证和幂等键，必须返回succeeded且金额/CNY/编号一致。多单分摊由服务器完成。
17. 出品绑定原份数、task/table/session/locationVersion、批次负责人版本；实物释放设备与商品备齐区分。接班保存完整预览，显式确认实物与理由；同一原负责人且非自己才接班，回执完整批次和每批+1归属版本须匹配。
18. 取餐按kind+unitId区分原品和重做，最多999份/50任务；领取记录是业务送达事实。撤回绑定receipt/revision且显式确认所有实物仍在取餐区。跨登录调用recovery，原设备session/scope/key/body不变；PICKUP业务错误还必须not_committed才允许重选。
19. 真实订单标签查询operations/history；首屏营业日由服务端返回，筛选字面编码、日期范围不超过366天、分页绑定。资金统计尊重financialSummaryVisible，金额沿用effectiveAmountMinor；套餐内商品不另计费，缺失履约凭据不推测。

20. 真实开台人数1—200，超过容量必须2—1000 UTF-16字符的capacityOverrideReason；未超不发送旧理由。转台可选更小空桌，按原guestCount校验同样理由并保留expectedSourceTableId/locationVersion；客户端不自行改变服务器授权政策。

21. 收银工作台读workbench，原款查询只在明确点击时触发。客户端同时校验员工权限、服务端action flag、60秒新鲜度和租约；收银岗位不依赖dashboard。手工收款原桌次随请求持久化，用原session/payment-orders回读后才清除完成记录；回读失败不再次收款。
22. 独立退款明确用途及按原orderItemId的金额分摊，不能超过原支付及各商品剩余可退余额。fundsOnly只允许price_adjustment/duplicate_payment。申请人不能复核或驳回本人申请；关联afterSalesCase只允许查原退款，不绕过原售后审批。审批线上退款可能自动执行，须明确确认。
23. 退款publicId、原paymentId、商品分摊、CNY、金额和幂等key/body固定并保存；成功回执逐一核对原款、原退款及金额，申请回执还核对完整商品分摊。线上原路退款不允许登记人工成功；现金由服务端生成退款凭证，POS/外部必须独立退款凭证。渠道processing查询不是退款成功。
24. 未被证明未提交的金融错误、错回执、断网继续保留原请求，不凭409自动取消、换号或重新收退款。仍需补金融拒绝与跨登录/撤权后的完整恢复验收（NATIVE-20260927-04），不能据本地测试宣称资金闭环。
25. CSV导出重新验证原岗位和同一已应用筛选；全部导出由服务端exportAll一次读取，客户端拒绝超过5000单。UTF8 BOM/CRLF、每格引号转义、公式首字符防护（含CRLF）、上海时间、整数分转十进制；套餐内金额空白、缺失制作送达证据留空。原生系统保存，不请求整个文件存储权限；员工切换清除待保存内容。

26. 更新与员工业务API隔离，不携带员工会话；preview/stable渠道由构建固定，清单不能跨渠道。仅较新build可更新，最低系统需满足；服务缺失或错误不宣称最新版。
27. Android仅本站HTTPS安装包，无重定向/路径穿越；下载流限制大小/时间/空间，摘要/包名/原证书/严格递增版本全部通过，安装前再校验并调用系统确认。不授予未知来源权限、不静默安装、不卸载旧包。签名轮换暂不接受。
28. iOS只打开允许的Apple官方更新入口，不下载可执行热补丁；stable不跳转TestFlight。安装前保留并检查全部未决请求，不以“已打开安装器”宣称升级成功。真正更新状态以新进程版本为准。
29. 发布工具只本地准备清单，不自动部署；Android正式包必须签名验证且拒绝调试证书，APK先可用后原子切清单，构建号不回退。任意存储结构升级仍需单独迁移与未决请求回归，不以系统覆盖安装假定所有版本兼容。


### 原款历史关闭与重收授权（2026-09-27）

- POST `/api/payments/:paymentId/close-unpresented-history`：reason 4—500 UTF16字，idempotency-key。服务端白名单和完整closableUnpresentedPayments必备；整笔totalAmountMinor与所有orderIds/orderPublicIds绑定，不能使用订单卡分摊金额。当前四项权限均需满足；服务端最终重新验证未外送、全部原订单及桌次。仅本地关闭，不联系通道，不退款。
- POST `/api/orders/:orderId/recollection-authorizations`：reason 4—500字，idempotency-key。重收资格及服务端flag，客人明确同意当前原单应收后才创建。默认30分钟单次使用，原补偿保留，不自动收款。返回授权对象而非Payment，无status字段；校验orderId/amountMinor/currency/authorizedByEmployeeId/reason及非空id/publicId/时间字段，随后重新读取工作台。已过期幂等回执可以证明原命令结果，不能据此认为当前仍可收款。
- 公开Payment序列化会过滤内部localUnpresentedHistoryClosed字段，客户端不依赖此字段。通过专用端点回执、原付款id/publicId、整笔金额/CNY/payableKind和closed校验。
- 恢复沿用既有原员工原键原body落盘流程；不清除不匹配的回执。授权接口没有expectedAmount/version参数，余额并发改变会在回执校验阻断后续App操作，需要原单核对；409/跨登录/撤权恢复仍属NATIVE-20260927-04，不宣称闭环。


### 历史已关桌原单全额补收（2026-09-27）

- 工作台actions新增可选布尔supportsGuardedClosedDebtCollection；原生端必须为true才开放。手工收款provider对应flag、payment.collect.all_tables及payment.recollect.authorize同时要求，拒绝覆盖允许。原工作台新鲜度≤60秒、原员工/登录租约及无未决请求检查沿用。
- POST `/api/payments/manual/closed-debt` 发送原orderId/publicId/provider/method/receiptReference与凭证；不发送顶层amountMinor/orderIds。API现有readOrderCollection遇到amountMinor会转换orderIds，不能用于已关桌原单路径。
- 新增可选closedDebtGuard对象：amountMinor是确认的原欠款全额，authorizationId为当前原单授权。服务端在锁内比较，金额/授权变化时不入账；字段进入幂等指纹。不提供guard的旧网页请求指纹和语义不变。guard与部分/合付参数不能混用。
- 服务端仅在变更处理器入账前抛HistoricalCollectionChangedError时返回HTTP409/HISTORICAL_COLLECTION_CHANGED/error.commitDisposition=not_committed。原生端只对白名单错误+明确未提交凭据允许确认失败后刷新；不能把金融409整体视为未提交。成功原键回放绕过已消耗授权/余额的变更条件，但仍重新授权。
- 回执须匹配原orderId、新payment publicId、全额/CNY、payableKind=order、succeeded、provider/method、原凭证和收款员工，附加终端/外部方式/说明也须一致。收款回执成功后回读收银；不去查询已关桌的payment-orders。回读失败保留完成检查点，恢复不重收。
- 实收现金和找零仅用于人工确认，记录的是原欠款全额。收款记服务器当前营业日，原订单/桌次营业日保留，历史桌不重新开、不激活新增出品。旧服务器没有能力标记时不发送新历史收款请求。本批未部署服务器。

- 专用 `/api/payments/manual/closed-debt` 强制提供guard；混合版本或回退到旧服务器时该路径不存在，不会因旧节点忽略新字段而入账。旧 `/api/payments/manual` 仍兼容原载荷，支持可选guard但原生历史补收不使用旧路径。
- 明确失败确认清除后，双端清空收银/付款新鲜度，必须刷新再登记；不可复用已变化的旧表单。
