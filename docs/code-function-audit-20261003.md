# M-BOX 点菜支付与前后端闭环审计

审计日期：2026年10月3日，北京时间。对象为顾客网页、微信及支付宝小程序、员工网页、原生员工 App 与规范化后端。结论：主流程已有事务、权限、金额和恢复保护，但本轮确认四项功能缺陷，尚不能认定完整闭环。四项均暂定 P2，需要修复；本轮没有证实重复扣款、超额退款或越权入账事故。

本次只新增审计报告和风险登记，未修改业务实现，未提交、推送、部署或执行生产订单、收退款、库存动作。所有产生订单的复现使用独立本地数据库及模拟支付。

## 版本与证据边界

| 对象 | 核实结果 |
| --- | --- |
| 审计代码 | `/Users/jingda/mbox/mbox-release-rc244-20261003`，HEAD `e67b327eedd7693a5eb31317976eaa9939ab9c0b`，rc.244；开始时工作区干净 |
| 远端主线 | `git ls-remote` 核实 `680c4f18b069daef6ac0a8979c6da7f6ffea4102`；与审计代码仅三份文档有差异，业务代码一致 |
| 线上只读就绪 | `/api/ready` 返回 ready、schema 251、workers healthy、commit `33168ef756cb2a8c7761ba134e8660d947d68614`，核对标签为 rc.243 |
| 生产深查 | 配置中的 SSH 中继在握手阶段断开，退出码 255；未取得当前生产数据库和业务日志。此结果不代表网站停服 |
| 缺陷与线上源码 | 四项涉及的实现文件在 rc.243 与本次 HEAD 之间无差异。可确认源码同样存在缺口，但未在生产执行缺陷复现，也未核实已发布小程序包的精确版本 |

原始证据集中于 [审计证据目录](/Users/jingda/mbox/outputs/code-logic-audit-20261003)，版本及测试计数见 [audit-manifest.json](/Users/jingda/mbox/outputs/code-logic-audit-20261003/audit-manifest.json)。ready 只支持运行身份及健康判断，不支持资金正确、全部工作器任务已完成或现场性能达标的结论。

## 已证实的缺陷

### 网页下单丢失回执后不能沿原请求恢复

编号 `LOGIC-20261003-01`，P2。顾客提交共享购物车，后台已建立订单，浏览器未收到响应时，页面提示重试，但再次提交会生成新的幂等编号。后端的版本校验仍能阻止旧购物车再次下单，却不会把新编号解释为原请求的回执查询。

浏览器复现：第一次请求由真实本地接口返回 201，然后在浏览器侧丢弃响应；延迟购物车轮询读回以模拟旧画面仍在显示。点击重试后，第二次请求使用不同编号，真实接口返回 409 `SHARED_CART_VERSION_CONFLICT`；用原编号和原载荷重放则返回 200，找回同一订单。后端有恢复能力，网页没有保留并使用它。该复现没有产生第二笔订单或真实扣款。

代码位置：[GuestApp.tsx](/Users/jingda/mbox/mbox-release-rc244-20261003/src/normalized-ui/guest/GuestApp.tsx:593)、[生成随机编号](/Users/jingda/mbox/mbox-release-rc244-20261003/src/normalized-ui/guest/guest-model.ts:172)、[现有后端回读](/Users/jingda/mbox/mbox-release-rc244-20261003/server/normalized/guest-commerce-service-api.ts:480)。v1 网页提交也每次换号；本轮实际浏览器故障注入覆盖 v2，不把 v1 重复订单可能性当成已发生事实。

证据：[原请求、新请求和原编号恢复结果](/Users/jingda/mbox/outputs/code-logic-audit-20261003/repro-checkout-recovery.json)。影响包括顾客误判订单失败、支付接续中断及员工核对成本。正常轮询可能清空已提交购物车，但不能替代原请求回执恢复。

关闭标准：提交前按桌次持久保存原编号与完整载荷；未知结果时锁定该业务意图，刷新、重开页面、弱网恢复继续原请求；明确未提交才允许修改后新建请求。用断网、丢响应、刷新、已支付后恢复四类回归证明不重复建单、不重复付钱且能看到原订单。

### 网页商品备注没有进入共享购物车订单

编号 `LOGIC-20261003-02`，P2。顾客购物车显示可编辑的“此商品备注”，但共享购物车结账只提交整单 `note`，没有把商品 `note` 转换成后端支持的 `lineNotes`。订单可以成功，商品特殊要求却被静默丢弃。

浏览器在商品备注填写“本份少冰不加糖”，真实结账接口返回 201；捕获的请求没有 `lineNotes`，返回的订单商品 `note` 为空。整单备注是另一字段，本项不表示整单备注也丢失。

代码位置：[备注输入](/Users/jingda/mbox/mbox-release-rc244-20261003/src/components/MenuOrderingWorkspace.tsx:819)、[提交载荷](/Users/jingda/mbox/mbox-release-rc244-20261003/src/normalized-ui/guest/GuestApp.tsx:593)、[按份备注转换](/Users/jingda/mbox/mbox-release-rc244-20261003/server/normalized/checkout-line-notes.ts:15)。证据：[请求与订单回执](/Users/jingda/mbox/outputs/code-logic-audit-20261003/repro-note-loss.json)。

关闭标准：网页合同补齐购物车 `portionIds` 与 `lineNotes`；将“适用这几份”的商品备注明确映射到本次各份，保留整单备注。验证同商品多份、套餐选择、购物车版本变化、付款后 KDS/取送及票据均能读回相应备注，不能仅验证输入框显示。

### 按份备注或优惠拆行后重复点单比较失真

编号 `LOGIC-20261003-03`，P2。后端旧订单按商品汇总数量，新请求却用 `Object.fromEntries` 生成比较对象。同商品出现多行时，后行覆盖前行，没有累加数量。按份备注或优惠恰好会把同商品拆成多行数量 1。

真实本地接口对照复现：同桌刚提交某商品 3 份，再提交同商品 3 份时，无按份备注返回 409，要求确认重复加单；原购物车只增加一份的备注后，返回 201，创建了另一张 3 份订单，未提交重复确认编号。缺口在下单提醒保护，不是支付通道的幂等扣款机制失效。若桌上另有该商品 1 份订单，还可能错误命中那张订单；本轮正式复现保存的是漏拦截场景。

代码位置：[新请求数量覆盖](/Users/jingda/mbox/mbox-release-rc244-20261003/server/normalized/guest-order-safety.ts:154)、[旧订单数量汇总](/Users/jingda/mbox/mbox-release-rc244-20261003/server/normalized/guest-order-safety.ts:129)、[按份拆行](/Users/jingda/mbox/mbox-release-rc244-20261003/server/normalized/checkout-line-notes.ts:17)。证据：[无备注与按份备注的接口对照](/Users/jingda/mbox/outputs/code-logic-audit-20261003/repro-duplicate-portions.json)。优惠拆行共享同一代码路径，实际对照使用按份备注，未宣称已执行真实优惠核销。

关闭标准：新旧请求统一按商品累加数量，明确套餐具体选择是否参与同单判断；多行排列变化、按份备注、优惠拆行应保持相同的重复确认行为；真实有意加单仍需显式确认并能成功。

### 两端小程序没有完成重复加单确认交互

编号 `LOGIC-20261003-04`，P2。后端返回“请确认这是继续加单而不是重复操作”及冲突订单编号，微信和支付宝页面都把它归入明确未提交错误，清掉原尝试并显示错误；用户再点结账时，页面仍不带 `confirmedDuplicateOrderId`，没有真正完成后端要求的确认。默认保护窗口为 45 秒，生产实际配置本轮未读取；窗口内正常的同桌再次加点会受影响。

使用两端实际页面的 `submitOrder` 方法做故障注入：连续收到该 409 后，页面可重试，但两次载荷均没有确认编号，错误仍要求确认。2 项行为复现通过。API 工具层已经支持该字段，缺口在页面交互与载荷接续。

代码位置：[微信提交](/Users/jingda/mbox/mbox-release-rc244-20261003/miniprogram/pages/order/index.js:2059)、[微信错误处理](/Users/jingda/mbox/mbox-release-rc244-20261003/miniprogram/pages/order/index.js:2116)、[支付宝提交](/Users/jingda/mbox/mbox-release-rc244-20261003/alipay-miniprogram/pages/order/index.js:2043)。证据：[两端复现结果](/Users/jingda/mbox/outputs/code-logic-audit-20261003/repro-mini-duplicate.json)。

关闭标准：展示冲突订单并让用户明确选择“确实继续加单”或返回核对；只有确认后才提交服务端指定的原订单编号。确认之后购物车或最新冲突单变化时重新核对，不允许自动确认全部重复请求。

## 业务闭环覆盖

| 业务面 | 已审查及验证 | 本轮判断 |
| --- | --- | --- |
| 菜单与选择 | 商品和类目可见性、渠道、现价、库存、套餐选择、菜单分页；相关后端与小程序测试 | 常规回归通过，不代表生产每项菜单配置均已核对 |
| 同桌购物车 | 代次/版本控制、并发更新、共享可见、跨桌响应隔离、冻结与结账事务；两客人浏览器场景 | 主机制有效；异常下单恢复见 01 |
| 点单到库存与制作 | 服务端重算价格；先付款订单先预留，到账后启动制作；挂桌账路径消耗与出品；事务和 outbox | 数据库回归通过；备注与重复保护见 02、03 |
| 单单与合并收款 | 同桌同币种、未结金额、付款分摊、活跃付款尝试复用、员工与顾客并发 | 未出现现有回归失败；没有真实资金验收 |
| 支付回调 | 原始报文验签、可信商户作用域、金额/币种/交易绑定、回调去重与入账 | 源码与数据库回归支持保护存在，未取得本日真实回调日志 |
| 未知支付与取消 | 原付款查询、渠道关闭、未付款库存释放、后到款与原订单恢复；浏览器多端收款场景 | 常规回归通过；网页原提交恢复仍有缺口 |
| 退款与售后 | 累计不超实付、原商品分摊、部分停止、后到款只退款不重启出品、重收授权与权益恢复 | 数据库及相关浏览器回归通过，不证明生产历史账平 |
| 员工点单与收银 | 原请求编号恢复、现金待确认、角色权限、退款申请/审核隔离、关桌后历史欠款 | 当前选定网页回归通过 |
| 原生员工 App | 点单回执绑定、金额与原付款匹配、未知结果恢复、换品原单关系 | Android 32 项单测及 iOS 170 项断言通过；未运行本轮真机收款 |
| 履约与打印 | 付款前后 KDS 状态、库存事务、取送、打印任务与原票据恢复相关后端回归 | 无实体打印机、弱网跨设备、整班验收证据 |
| 发布与运行 | 代码/远端/线上 SHA、schema、workers、构建与静态检查 | 线上仍 rc.243；rc.244 主线集成不等于已经部署 |

## 验证结果与复现方法

测试均从上述冻结源码执行，使用 Node 26.0.0、npm 11.12.1、本机 PostgreSQL 16.15。数据库只监听本机独立端口 55473，测试脚本创建独立数据库及受限 LOGIN，未连接生产。构建过程中存在非阻断的分包体积/动态导入提示；lint 有警告但退出码为 0，不将它们解释为已证实的现场性能根因。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `npm test` | Vitest 2290 通过、1273 环境跳过；另 9 项负载模型单测通过 | [unit-tests.log](/Users/jingda/mbox/outputs/code-logic-audit-20261003/unit-tests.log) |
| 独立 PostgreSQL 全套 | 2963 通过、1 跳过；跳过的是要求 Docker 容器的数据库维护恢复演练 | [postgres-tests.log](/Users/jingda/mbox/outputs/code-logic-audit-20261003/postgres-tests.log) |
| 前后端类型 | 网页类型与完整 server tsconfig 均通过 | [typecheck.log](/Users/jingda/mbox/outputs/code-logic-audit-20261003/typecheck.log) |
| 小程序回归 | 343 通过 | [miniprogram-tests.log](/Users/jingda/mbox/outputs/code-logic-audit-20261003/miniprogram-tests.log) |
| 小程序静态检查 | 微信 166 文件；支付宝 23 页、5 Tab；支付宝平台 13 项通过 | [微信检查](/Users/jingda/mbox/outputs/code-logic-audit-20261003/mini-compile.log)、[支付宝检查](/Users/jingda/mbox/outputs/code-logic-audit-20261003/alipay-compile.log) |
| 浏览器常规闭环 | 29 通过，含顾客点单、共享购物车、员工/顾客支付同步、财务原请求恢复和后到款退款 | [browser-regression.log](/Users/jingda/mbox/outputs/code-logic-audit-20261003/browser-regression.log) |
| 新缺陷复现 | 3 个真实本地 API + Chromium 场景、2 个小程序页面方法场景均复现 | [浏览器复现](/Users/jingda/mbox/outputs/code-logic-audit-20261003/browser-repros-verified.log)、[小程序复现](/Users/jingda/mbox/outputs/code-logic-audit-20261003/mini-duplicate-repro.log) |
| iOS 点单/日常支付/支付接续 | 分别 68、50、52 项断言通过 | [点单](/Users/jingda/mbox/outputs/code-logic-audit-20261003/ios-order.log)、[支付](/Users/jingda/mbox/outputs/code-logic-audit-20261003/ios-payment.log)、[接续](/Users/jingda/mbox/outputs/code-logic-audit-20261003/ios-payment-completion.log) |
| Android 点单/支付 | 3 个测试类共 32 项通过，0 失败/错误/跳过 | [Android 日志](/Users/jingda/mbox/outputs/code-logic-audit-20261003/android-payment-order.log)，同目录保留 JUnit XML |

这些测试集合有重叠，不能相加宣称独立场景总数。新增复现用例的“通过”表示准确证明现有缺陷，不表示缺陷已修复。现有测试没有覆盖这四个组合路径，因此大批回归通过与发现缺陷并不矛盾。

复现源保存在 [audit-repros.spec.ts](/Users/jingda/mbox/outputs/code-logic-audit-20261003/audit-repros.spec.ts)、[独立浏览器配置](/Users/jingda/mbox/outputs/code-logic-audit-20261003/audit.playwright.config.ts)、[mini-duplicate-repro.test.mjs](/Users/jingda/mbox/outputs/code-logic-audit-20261003/mini-duplicate-repro.test.mjs)。最初两轮复现日志保留：第一轮存在按钮从“加入”变“增加”的定位遗漏和前例残留购物车；第二轮拆行数量 1 又命中第一例旧订单。最终选用独立商品、清理本地测试购物车，三项联合验证通过。未修改业务代码或放宽断言掩盖问题。

## 修复顺序与剩余验收

建议先补网页原请求恢复和商品备注接续，再同时修正服务端重复数量汇总与两端重复确认交互。四项均应把当前“缺陷表征”改为正确行为的回归断言，随后联合验证点单、付款、制作、退款及继续加单。仅改报错文案或禁用按钮不能关闭相应问题。

本轮未完成：生产数据库及日志逐笔核对、已发布小程序包追溯、真实微信/支付宝资金与退款、现场打印、真机弱网及高峰混合负载。未执行的项是证据缺口，不自动等于存在故障。既有 rc.244 发布记录中的收银性能等修复尚不能用于评价当前 rc.243 现场效果；本地数据库耗时和测试通过也不能代替门店高峰 p95、失败率、未知支付积压量及恢复时间。

风险登记见 [商业化待处理清单](/Users/jingda/mbox/mbox-release-rc244-20261003/docs/commercialization-pending-checklist.md)。四项尚未修复或验收，原有商业验收事项继续按各自证据要求处理。

## rc.245 修复进展（2026-10-03）

以上为修复前审计快照，早期 rc.243 生产读回不能替代后来 rc.244 的上线记录。本轮四项修复、回归和发布结果见 [rc.245 发布记录](release-1.0.0-rc.245.md)。原始复现证据保留，不能把复现通过计为修复通过。
