# 首店六域商用开发审计 · 2026-10-15

## 范围、结论与证据边界

按用户指定的微信顾客端、员工网页、收银、出品、库存、积分检查。基线为已包含PR362的主线`8e84fdf97b660fff3cfaf74ae0ecfa3210343331`，本次分支`fix/first-store-commercial-20261015`。本轮确认四类代码缺口并补齐：人工积分独立审核、员工积分异常入口及读取状态、收银未知结果原请求保留、商用检查非法输入拦截。没有重写已有正常的库存和出品逻辑。

下表是具体业务路径的源码与自动化证据索引，不是“全系统完成率”。“已实现”只表示选定路径有真实实现和回归覆盖；测试支付、隔离数据库、浏览器截图都不能证明真实渠道、纸票或门店已验收。本轮不部署、不上传小程序、不发APK、不生成真实收退款、积分或库存变动。

## 逐条检查

源码路径相对仓库根目录。常规检查、数据库和浏览器结果统一见后文验证记录，避免将同一条测试重复计数。

| ID | 范围与检查项 | 代码判断、处理及证据 |
|---|---|---|
| WX-01 | 微信扫码、桌台身份及过期码 | 已实现桌次绑定和失效恢复。`guest-session-repository.ts`、`guest-request-context.ts`、`guest-scan-concurrency.integration.test.ts`；小程序`miniprogram-table-scope-race`、`miniprogram-invalid-scan-recovery`专项。旧桌身份不可继续下单 |
| WX-02 | 菜单价格、选择项、库存可售 | 已实现服务端重新计价、套餐/选项校验；前端报价不作为收款依据。`checkout-cart-pricing.ts`、`checkout-basket.test.ts`、`checkout-upgrade-eligibility.test.ts`；实际菜单/配方配置属于上线检查 |
| WX-03 | 购物车、重复点击与同桌重复菜篮 | 已实现原请求复用、同桌相同菜篮确认、个人与桌台限流。`guest-order-safety.test.ts`、`guest-shared-cart-repository.test.ts`、`payment-provider-action-concurrency.integration.test.ts` |
| WX-04 | 付款发起、超时、关闭和晚到 | 已有支付状态与订单联动、未知结果不擅自释放。`payment-attempt-reuse.integration.test.ts`、`payment-retry-release.integration.test.ts`、`stale-guest-immediate-payment-worker.test.ts`；真实微信渠道仍单独验收 |
| WX-05 | 会员零进度与规则读取 | PR362已修0值完整底槽、无规则不伪装0、旧响应隔离、下一等级权益入口；本轮复跑`release:miniprogram:test`，不重复开发 |
| WX-06 | 订单详情、取消及恢复 | 已有终态恢复与原订单核对。`miniprogram-checkout-terminal-recovery`、`miniprogram-checkout-duplicate`、`normalized-guest-checkout-closure.spec.ts`；失败状态必须与原订单核对 |
| WEB-01 | 员工身份、门店与岗位权限 | 已有服务端权限、会话、门店隔离；页面可见性不替代授权。`staff-access-repository.ts`、`staff-permission-recovery.test.ts`、`normalized-after-sales-access-recovery.spec.ts` |
| WEB-02 | 会员异常入口 | **本轮补齐**：已有`LoyaltyPolicyPanel`的exceptions模式从未挂载；接到`/staff/member-exceptions`，保留原消费漏发申请/复核。`first-store-member-entry.test.ts`验证实际父组件及无权限隐藏 |
| WEB-03 | 读取失败、旧响应与空列表 | **本轮补齐**：积分异常未读取/失败显示无法确认而非无差异；增加刷新和读取代次隔离。人工积分页面保留原请求，身份/门店变化拦截 |
| WEB-04 | 人工积分申请与复核入口 | **本轮新增**：同一异常页面可按会员号申请正负整数调整、填写实际依据、独立审核、查看原申请及有效期；关键操作确认显示会员和数量。`normalized-manual-points.spec.ts`验证实际登录、持久恢复和两人流程 |
| WEB-05 | 小屏操作与授权撤销 | 320/360像素真实浏览器核验布局及操作；新页面按员工/会话重置，发送前重查权限；服务端每次含重放重新授权。存储不可用时不发送积分命令 |
| CASH-01 | 金额精度和原付款复用 | 已有整数分计算、订单/支付锁、并发只生成一次渠道动作。`single-payment-lock-order.integration.test.ts`、`payment-provider-action-concurrency.integration.test.ts` |
| CASH-02 | 收银请求失败后的安全重试 | **本轮修复**：不再将“非retryable”当作未提交证据；复制并保留原请求体/编号，同次双击共用一次请求，确认读回后清除。`cashier-mutation-recovery.test.ts`覆盖网络错误、403、读回失败和双击 |
| CASH-03 | 读回与导航竞态 | **本轮修复**：收银读取失败向命令确认传播；`RefreshQueue.requestConfirmed`在导航取消后拒绝确认，防止取消读回被当成功。原轮询保持合并策略 |
| CASH-04 | 现金、POS及外部凭证 | 已有真实收款确认及凭证重复控制，不能把点击记账当作渠道到账。`external-manual-payment.integration.test.ts`、`CashierAfterSalesWorkbench.test.ts` |
| CASH-05 | 原路退款、部分退款、晚到款 | 已有独立审核、额度、原付款容量及重复回调保护。`payment-api.test.ts`、`loyalty-refund-review.integration.test.ts`和数量售后回归；实际渠道及对账证据另计 |
| CASH-06 | 营业日结束和待办 | 已有未处理账单/退款阻断；本轮对自动关闭请求同样保留原编号并确认读回。`normalized-auto-only-day-end.spec.ts`、`cashier-closed-batch-client.test.ts` |
| KDS-01 | 下单到出品任务 | 已有订单项关联和事件记录，无复制状态作为第二事实源。`kds-repository.test.ts`、`commerce-kds-api.test.ts` |
| KDS-02 | 出品、送达及岗位范围 | 已有岗位/站点/桌台与有效会话授权、条件行锁、非法状态拒绝。`kds-authorization-policy.test.ts`、`kitchen-production-command.test.ts` |
| KDS-03 | 并发出品、整桌与数量动作 | 已有数量任务和三屏状态处理；`kitchen-production.test.ts`、`kitchen-production-successor.test.ts`、`normalized-kitchen-batch.spec.ts`及三屏专项。开关是否启用属于配置事实 |
| KDS-04 | 取消、重做与库存 | 已有重做预留、开始制作才第二次扣料、取消释放和并发只建一次。`kds-remake-inventory.integration.test.ts`、`closed-session-kds-terminalization.integration.test.ts` |
| KDS-05 | 纸票与断网恢复 | PrintBridge专用路径存在，通用`print.deliver`不可用不能推出全部不能打印。保留打印恢复测试；纸票、设备离线重连、重打与原单关联须在对应设备验收 |
| INV-01 | 原料、单位、配方和可售 | 已有严格库存模式、单位校验、明确不管理库存商品例外；缺配方或余额拒绝扣减。`inventory-repository.test.ts`、`inventory-unit-policy.test.ts` |
| INV-02 | 下单预留和出品扣料 | 已有确定顺序的余额锁与缺货回滚，禁止部分扣料提交。`inventory-repository.ts`及数据库全量回归；不改生产初始库存 |
| INV-03 | 入库和成本 | 已有入库原请求、整单原子入库、成本预览及价格变化回滚。`inventory-native-setup.test.ts`验证后端共用仓储；网页路径由商业浏览器回归覆盖 |
| INV-04 | 盘点及独立复核 | 已有申请人与审批人分离；锁余额后验证盘点快照及期间流水，即使售出又退回相同数量也不能套用旧盘点。`inventory-repository.ts:approveStockCount`、`normalized-stock-count-batch.spec.ts` |
| INV-05 | 报损、退料与成本追溯 | 已有独立流水、实际退料数量/成本处理。`inventory-waste-repository.ts`、`inventory-return-cost-projection.integration.test.ts`、数量库存回归。实物清点与账面准确性不是代码可替代事项 |
| PTS-01 | 按实付满10元积1分 | PR362已实现逐单向下取整，不跨单累计零头、不套用等级倍数。`loyalty-accrual-repository.test.ts`、migration267；不修改历史余额 |
| PTS-02 | 每分抵1元、不可叠券 | PR362已实现顾客确认订单报价/提交绑定。`checkout-points-policy.test.ts`、`checkout-cart-pricing.test.ts`、`member-gift-campaign-repository.test.ts`；只抵整数元，小数分仍需支付 |
| PTS-03 | 抵至0元和新积分下一单使用 | 已有零金额结清事实，不伪造外部付款；旧积分预留在本次奖励前，不用新积分抵本单。`checkout-points-repository.ts`、migration268及顾客结账集成测试 |
| PTS-04 | 预留、并发、防超扣 | 已有账户/批次锁，预留立即减少可用批次；失败或明确取消按原批次恢复，未知渠道结果不释放。`checkout-points-repository.ts`及顾客接口集成回归 |
| PTS-05 | 退款返分、有效期与欠分 | 已有按真实商品退款分摊、原批次/原有效期恢复、欠分限制和独立人工复核。`loyalty-supplement-refund-consistency.test.ts`、`loyalty-refund-review.integration.test.ts` |
| PTS-06 | 原消费漏发 | 继续使用原订单和锁定规则计算补发差额，不允许自由输入该笔应得积分。本轮只补网页入口，不改原计算服务 |
| PTS-07 | 无原订单人工关怀/纠错 | **本轮新增完整审核链**：申请不改余额；审批需人工积分权限、积分复核权限、另一名员工、显式CNY额度。旧直改HTTP返回409。不能通过接口绕过审核 |
| PTS-08 | 人工积分入账和恢复 | schema269申请/决定/回执只允许追加、强制RLS；审批流水必须匹配会员/客户/数量/规则/审核人；余额、批次、审核、回执、审计同一事务。正分先偿欠分，负分仅扣可用批次；不改成长值 |
| GATE-01 | 商用基础检查 | **本轮修复**：schema45与文字门槛46不一致、NaN/Infinity/负数统计穿透；严格安全整数并阻断。通用schema46下限不证明本候选schema269已迁移 |

## 新增人工积分的约束与迁移

1. migration269新增申请、决定、永久回执表及独立审核/精确流水关联约束。新增“人工积分调整审批”配置定义，同时支持已有门店和新门店。**不授予角色额度，不自动给员工权限，不改现有积分**。
2. 人工正向补分受紧急暂停控制；申请和复核都确认有效会员，复核时规则必须仍为原已发布版本。以每分1元核对审批额度，审批额度为明确非空人民币上限；不接受其他计算模式代替额度。
3. 权限检查含原请求重放；借用他人编号或改变正文拒绝。权限配置与执行共用配置锁，审核请求锁保证并发仅一次；数据库拒绝申请人自审及不匹配流水。
4. 原请求在浏览器按门店/员工保存，刷新后恢复同一编号，不能覆盖未知请求；只有已知业务拒绝且明确未提交才允许更正。收到成功回执但读回失败仍保留。该存储包含会员号、数量、依据，不保存登录凭据或顾客付款码。
5. 原消费漏发、人工关怀补分、退款积分复核是不同业务依据，页面分别保留；人工负数调整不能替代原退款/冲回流程。误补后应新建有依据的纠错申请，历史申请和流水不可删除。
6. 旧`POST /staff/customers/:customerId/points`拒绝直改，旧调用者会收到改走审核的提示。新流程交付员工网页；不声称旧客户端也已有新页面。

## 本轮验证记录

原始日志目录：`outputs/first-store-commercial-20261015`（仓库父目录下的本任务证据，不提交真实经营数据）。失败记录保留；夹具权限码/导航路径等调试错误不能当生产缺陷。

- 商用门禁：修前7条失败、6条通过；修后全部定向通过，覆盖非法版本及计数。
- 第一轮定向：6文件96条通过；真实受限PostgreSQL LOGIN：最终新增10条通过，包含并发一次入账、重放撤权、额度、欠分、负数余额、跨店RLS、追加权限、自审数据库约束、入账后回执失败整体回滚、暂停、停用会员及已发布规则换版拒绝旧申请。
- 浏览器：320/360两条真实隔离API流程通过，验证服务端已保存但响应丢失、刷新后同编号恢复、不可自审、另一员工通过、余额10分及无横向溢出；截图保存在浏览器结果目录。最终含会员到店/赠礼的专门浏览器批次共10条通过，覆盖样式调整后结果及503/不完整响应不显示无差异。
- 完整`npm run check`通过：含清单、架构、质量模型、微信/支付宝静态、小程序专项、类型、lint、常规测试和构建。商用门禁13条随后加入默认测试入口，常规测试2553条通过（环境依赖1501条跳过）。全部隔离数据库另跑3306条通过、1条条件跳过；不以常规环境跳过替代数据库验证。
- 完整浏览器及远端CI绑定本分支关联PR的当前提交，Checks为最终权威记录。最终运行编号和精确提交保存在任务证据目录及交付消息；本段不预先声称尚未结束的运行成功。Android源码未改，按工作流路径规则无需额外Android构建；无发布标签，不运行镜像发布。

### 回归发现与修正

首轮完整浏览器136通过、2失败、38条件跳过。人员安排密度原断言测整页，前序流程留下4条预约提醒使整页高度2402px；改测实际责任安排面板，保留2400px上限、原触控与溢出断言，未修改生产布局。启动测试失败样本记录本机`ERR_NETWORK_CHANGED`，单独复核，不放宽门禁。原失败日志、截图和跟踪保存于`browser-baseline`；最终完整回归仍以PR368当前提交CI为准。

永久回执里的余额明确标注“该次入账后”，不把重放的历史余额称为当前余额；当前余额应从会员账户读取。

## 仍需经营配置或发布/现场证据

| 门禁 | 本轮处理边界 | 需要的证据/负责人 |
|---|---|---|
| 后台与微信发布 | 用户明确暂停部署；本候选尚未线上生效 | 发布负责人后续授权，锁定提交/镜像/schema269/回滚；微信管理员上传、审核发布及对应版本读取 |
| 积分规则与审批额度 | 不代替经营负责人决定额度、审核人或启用现金抵扣 | 经营负责人确认已发布满10元积1分/每分抵1元规则、不可叠券；配置人工积分金额上限与两名独立角色。允许全抵但不免小数分 |
| 微信真实支付和退款 | 使用隔离/模拟通道不产生真实资金 | 真实单号、渠道回执、订单/资金/积分/退款核对；正常、未知、晚到、部分退款、全积分零付款各按实际使用范围验收 |
| 出品、打印、实物库存 | 自动化不证明纸票或实物一致 | 门店岗位核对同单出品、送达、取消重做、PrintBridge纸票、断网恢复和盘点；沿用对应版本已有效的历史验收，补测本次变更相关场景 |
| 营业收尾与运维 | 不把数据库测试耗时当门店峰值性能 | 发布/门店负责人核对负载、监控、备份恢复、日结/对账及真实营业记录；旧TC未执行/阻断状态继续保留 |

首店范围不包含营销外发通道、通用外部执行器、支付宝完整交易、多品牌离线推送、iOS、供应商采购退货和员工已下单桌账积分抵扣。历史缺口仍见`system-development-completeness-audit-2026-10-13.md`，并未被此次审计关闭；如实际经营依赖这些能力，需调整首店范围再开发/验收。
