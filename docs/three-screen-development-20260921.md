# 三屏制作与取餐统一开发记录

最后更新：2026-09-21（北京时间）。本文件先登记基线、预计改动、接口和迁移；验收证据按实际追加，不以原型通过替代正式实现。

## 基线与分工

- 远端 fetch 后核定基线：`77744bc4e9ed308546b630590bdfa5dfe5ce5b7d`，当前源码版本 rc.216，基线源码包含迁移 001–224。
- 独立工作区：`/Users/jingda/mbox/mbox-three-screen-workflow-20260921`。
- 分支：`feat/three-screen-workflow-20260921`；依赖 `npm ci --offline` 完成。
- 协同任务“检查代码并部署合并”：`/Users/jingda/mbox/mbox-audit-remediation-20260921`，同基线；负责 SYS310–313、316–320 及共享商业化清单。
- 本任务独占制作、待取、取走、撤回及 SYS314/315。暂不合并、不部署。
- 本地数据库使用 127.0.0.1:55443，仅建立 `three_screen_20260921_*` 与浏览器专用 `mbox_normalized_browser_*` 随机隔离库；浏览器端口 18921/18922。不修改共享数据库角色，不停止共享数据库。

## 已确定规则

1. 一名调酒师、一名厨师、四名服务员；三块屏幕：酒水制作、后厨制作、共用取餐。调酒师10寸横屏，取餐屏独立。
2. 后厨放好旁边取餐口后一次确认；酒水放好吧台后一次确认。无需额外搬运到达确认。
3. 共用取餐屏不选领取姓名；手机无需再次确认。**取走即按业务认定为送达**，数据库保留取走来源，不伪造观察到客桌的时间。
4. 领取精确原份与当前重做代际；同桌酒水、小食可合取。后来出品不并入旧点击；不同桌次不得混取。
5. 误触整次撤回原领取集合，实物仍在取餐区为操作前提；份已重做、终止、关桌等冲突时拒绝。不得重开制作、重复耗料、重复发放权益或改变收退款。
6. SYS314 接班保留原创建人，显式核对关联制作范围并原子变更当前负责人；同时覆盖KDS任务归属、版本防迟到和永久回执。
7. SYS315 排除已由重做接续的原份，统一在制查询与前端计数；未实际清空的设备仍必须显式释放。

## 正式实现的文件范围（开发前登记，现已核对）

| 文件 | 实际实现 |
| --- | --- |
| `src/shared/kitchen-production.ts` | station、当前/原制作负责人、所有权版本、交接预览/命令 |
| `server/normalized/kitchen-production-api.ts`、`kitchen-production-query.ts`、`kds-authorization-policy.ts` | 酒水/厨房同权威模型、SYS314/315、持久回执、岗位权限 |
| `src/normalized-ui/staff-actions/KitchenProductionBoard.tsx`、`kitchen-board-state.ts`、相关CSS | 横屏合批、原份分配、接班、设备释放、待取/取走投影 |
| 新增 `src/shared/pickup-workflow.ts` | 原份/重做实物、版本、取走/撤回回执、设备用途契约 |
| 新增 `server/normalized/pickup-workflow-api.ts`、`pickup-workflow-repository.ts`、`pickup-workflow-query.ts` | 精确领取/撤回、可信设备、永久命令回执、统一读回 |
| 逐份原货/重做仓库、`item-quantity-projection.ts` | 精确份数送达及仅原回执可用的受控撤回，保持库存与历史边界 |
| `table-session-closure-blockers.ts`、相关履约/历史/权益读模型 | 当前待取重做阻塞、撤回恢复待取、设备来源不算领取员工绩效、权益兑换不重发 |
| 新增 `PickupBoard.tsx`、`pickup-board-state.ts`、`pickup-board.css`、`pickup-api.ts` | 4桌待取页、完整备注、分批、近期撤回、持久未知结果、防连触 |
| `StaffActionsPanel.tsx`、`StaffReadyNotice.tsx`、`staff-actions-api.ts`、`NormalizedStaffApp.tsx`，新增专屏入口 | 三屏挂载、手机只同步无需二次确认、消除旧重复送达入口 |
| `server/normalized/commerce-kds-api.ts` | 注册新插件；三屏启用时防旧入口绕过共同取走回执 |
| `server/normalized/normalized-runtime-config.ts`、`normalized-app.ts`必要配置段、履约契约/查询 | 新总开关 `MBOX_THREE_SCREEN_WORKFLOW_ENABLED` 默认关闭；已有可信设备继续收尾，旧厨房开关不意外启用酒水和取餐 |
| `database/normalized-migrations/228_three_screen_workflow.sql` | 见迁移章节；不改001–224 |
| 对应单元/真实PG/API/浏览器测试、fixture、本文档 | 同一源码逐项验收、记录未覆盖边界 |

上述开发前范围已核对；最终业务提交共65个文件，完整清单见文末。`normalized-app.ts`仅配置与注册片段，我方不改另一任务的API/worker身份检查；`normalized-contracts.ts`最终未改；履约必要字段放在独立契约与查询中；`command-executor.ts`不改。共享商业化清单由协同任务单一写入，本文保存本任务证据并同步交付。

## 接口契约

- 现有 `GET /api/commerce/kitchen-board?station=kitchen|bar`：缺省厨房，按岗位返回对应原份/制作批/当前负责人；bar新增受总开关控制。
- 现有 `POST /api/commerce/kitchen-board/commands`：请求为`{employeeId,stationCode,command}`，stationCode缺省厨房；command.action支持start、quick-ready、release、ready、handoff。旧厨房幂等键与请求指纹保持兼容；bar按工位隔离。ready/release核对所有权版本。
- 新增 `GET /api/commerce/kitchen-board/handoff-preview?batchId=...&station=...`：冻结相连活跃批及任务归属，显示接班实际范围。handoff命令提交`batchId、expectedBatches、expectedTasks、physicalChecked:true、reason`；要求有效会话、对应岗位范围、`kds.prepare`与`kds.exception.manage`。
- 新增 `GET /api/commerce/pickup-board`：可信取餐设备返回同一权威快照的待取精确实物、近期回执/可撤回原因。手机继续读原履约队列，无第二次送达命令。
- 新增 `POST /api/commerce/pickup-board/commands`：`take`带`tableId、tableSessionId、locationVersion、units[{kind,unitId,version}]`；`undo`带`receiptId、expectedRevision、physicalStillAtPickupPoint:true`。Idempotency-Key原键原体永久恢复。授权来源由当前会话/租约解析，不接受客户端姓名或完成时间。
- 新增取餐设备设置接口（同一模块）：有`staff.access.configure`权限的有效管理员将当前已验证设备指定为共用取餐屏；绑定服务端device_key_hash，允许撤销。不是每次领取步骤；前端URL参数不能授予全店取餐权限。具体为`POST /api/commerce/pickup-board/device`，请求`{enabled,label?}`并携带Idempotency-Key。
- 领取和撤回响应后强制读回；其余在线前台屏按现有约5秒轮询/可见性恢复读回。离线不假成功，不把轮询描述为实时推送。

## 迁移和数据边界

- 225 支付积分、226 报损回执、227 权限发布回执由协同任务独占；隔离测试使用审计候选 `44b54dc0f7c4da941a6e7ce2189348479655423e` 的真实SQL。225混合退款政策仍由审计任务跟进，因此这不是发布冻结；这些依赖不归入本任务业务提交。迁移器要求连续编号，不建占位迁移、不绕过检查。
- 我方228：制作批新增station（旧批默认kitchen）、设备唯一性含station；不可变制作来源保留；新增append-only交接历史/连续归属版本。
- 228同迁移新增取餐设备用途配置、领取回执/精确实物明细、撤回事实/永久命令回执；实物当前领取指针和履约版本；数据库只允许绑定当前原领取的一次受控delivered→ready，普通随意倒退继续拒绝。
- 全部tenant/store复合FK、FORCE RLS、运行角色最小授权；数据库权限组复查。应用用户和迁移维护管理员分离。
- 不给旧delivered历史补写猜测的取走人或时间，不让旧无回执送达记录获得随意撤回能力；旧异常拆份失败必须可见并可核对。
- 原份历史`quantity_unit_has_delivery`不能为UI方便改成最新代际，避免改变既有售后金额。当前重做未取单独阻塞关桌。
- 年度权益保留原兑换/完成历史与grant占用，不重新激活可领资格；用原兑换订单的当前履约读模型更正为待取，保持账务和权益资格不变。
- 关闭三屏总开关后，酒水新开工和新设备设置暂停；后厨新开工仍由原后厨开关控制。已有启用取餐设备继续领取/撤回、手机继续自动同步；保留已开始制作接续和入口，不执行破坏历史的down迁移。

## 验收顺序与证据边界

1. 固定同一新原型指纹：三轮高峰、取走/撤回/丢回执/离线、低高度与长备注。通过后正式开发。
2. 正式接口与真实隔离PG验证：权限/跨店、精确份数、同键异体/缓存过期、并发重复/关桌/转桌、撤回原份与重做代际、权益不重发、库存/支付不变。
3. SYS314：停用原厨师接班、同task拆批、并发接班、A→B→A旧请求、丢响应恢复、设备释放；SYS315：全/部分/多代重做、原设备未释放、历史保留。
4. 正式挂载三屏浏览器：10寸横屏1024×600/768、完整备注、按钮可达、真实API与数据一致、手机自动消失/撤回重现且无二次确认；记录每项检查。
5. 类型/构建/相关回归通过后提交独立分支供统一集成。无自主合并部署。现场实物、真实平板触感和实际高峰产能仍需门店验收。

原型目录：`/Users/jingda/mbox/outputs/three-screen-optimized-20260921/`。三轮同输入模拟80/80/180份均通过，取餐40/41/106次；30项独立复算与9项异常联测通过。最终新取餐原型SHA256 `ee108d90ed2e59cd2572c01c72e985f46e8c767e46c8bf543a8506ad84eae98c`。正式实现与真实库回归已完成；最终验证结果见后文。详见输出目录优化方案与复测报告。

## 实现补充与协作边界

- 专屏入口：`/staff/fulfillment?screen=bar|kitchen|pickup`。正常岗位导航保留权限判断；设备设为取餐屏是管理员的一次性设置，实际领取不选姓名。
- `POST /api/commerce/pickup-board/device` 设置或停用当前可信设备；`POST /api/commerce/pickup-board/recovery` 在重新登录后显式核对本机原操作，保留原 scope、key、body，服务端验证同一真实设备。不能用新凭据复制上一笔领取。recovery请求为`{staffSessionId,commandScope,idempotencyKey,request:{kind:"command"|"device",command}}`，其中会话、scope、key、body均是原操作值；当前登录身份仍重新授权。
- 前台 `sharedPickupActive` 表示共用取餐仍在使用；`threeScreenRecoveryAvailable` 保留已开工/可信取餐入口。暂停新流程不会迫使服务员改用手机二次确认；后厨原开关保持独立，不把设备设置暂停误显示成全店停止制作。
- 手机历史沿用`GET /api/operations/history`，待取沿用`GET /api/commerce/fulfillment`，追加 `OperatingHistory.sharedDeliveries`。共享取走单独显示，按当前有效桌台分配/全店查看权限过滤，原员工的个人历史与工作量不变；撤回移除当前送达条目，原回执仍留取餐历史。
- 跨屏自动更新沿用约5秒轮询（手机历史10秒），不是推送或零延迟承诺；网络异常保留原意图，明确暂停新动作。
- 每次最多领取50个制作任务、同一桌次内精确份数；超出时界面明确分批，服务端返回确定未执行，避免留下永久未知操作。
- 年度每日点心保留兑换/完成历史，追加当前履约状态。管理后台、微信及支付宝小程序显示“已核销·当前待取”，不会重新开放权益资格。
- 旧 `goods.redelivery` 是“已送达原货的补送”独立服务流程，不由常规待取自动关闭；仍从原服务待办处理。本次覆盖正常出品及重做实物的制作、取走、撤回。
- 本轮修改 `normalized-app.ts` / `normalized-runtime-config.ts` / 配置生成脚本仅三屏注册与开关片段；与审计任务API/worker身份、权限部署请求、财务积分修改逐段集成。共享清单由审计任务单一更新。

## 冻结来源与最终验证

- 正式业务主提交：`c1c972dd4a008dc610f33fecf0e6c348cdbf6d08`，65个文件；最终实现提交：`7e2250db74e826d9531d384d037f9dfb1b4ce854`，在`89049bd`制作提示修复后进一步修正隐藏读屏提示引发的手机自动滚动，并加强真实可见性验证，累计仍为65个文件。后续交付说明提交只更新本文档。
- 验证组合：该业务提交 + 审计任务`44b54dc0f7c4da941a6e7ce2189348479655423e`的225、226、227迁移，以及该提交的`normalized-rls.integration.test.ts`。这4个依赖文件明确留在本工作区但未纳入本任务提交，不能把工作区称为全净，也不能把本分支当作可独立发布包。
- 227将元数据SELECT授权给运行角色，UPDATE仍不允许；因此采用审计对应断言，不修改权限迁就旧测试。
- 我方228 SHA256：`cd6bed2f58633ce3b43c47909c82e353be24ca518799649252d2c4c8e5597a04`。新增六表：`kitchen_production_handoffs、pickup_devices、pickup_receipts、pickup_receipt_parts、pickup_undos、pickup_command_receipts`。两类实物追加当前领取回执指针与履约版本。完整SQL仍须在225–227确定后统一集成，不单独跳号执行。
- 225–227及对应测试的精确哈希见[临时依赖清单](/Users/jingda/mbox/outputs/three-screen-development-20260921/temporary-migration-dependencies.json)。本轮没有对这些依赖进行业务修订。
- 取走响应的`result.revision`与快照`board.revision`均为数据库事务时间的微秒顺序token；回执`receipt.revision`独立表示领取/撤回版本，不能混用。错误`commitDisposition:not_committed`才允许确定未提交；`unknown`（包括权限会话过期、连接错误、操作仍执行中）必须保留原意图等待恢复，不能换键重复操作。

## 逐项验收矩阵

| 要求 | 正式证据 | 当前结论 |
| --- | --- | --- |
| 不选姓名、取走视为送达、手机不二次确认 | pickup真实PG匿名来源/时间等值；正式三屏浏览器20桌80份 | 最终真实浏览器通过 |
| 整次撤回、重取、重复/迟到请求 | 精确原份与重做代际、永久命令回执、版本守卫 | 两轮26/26及整体回归通过 |
| 断网、丢回执、重新登录恢复 | 同机原意图恢复，异设备/篡改拒绝；真实浏览器丢已提交响应、刷新与换会话 | 接口与最终真实浏览器通过 |
| SYS-314 接班阻塞 | 停用原厨师、相连拆批、任务归属、并发接班、A→B→A迟到、设备释放 | 制作专项8项及整体回归通过 |
| SYS-315 重做残留 | 全部/部分/多代重做排除原在制；未清设备保留显式释放 | 制作专项及整体回归通过 |
| 低权限运行与数据约束 | FORCE RLS、不可改删回执、空/部分/跨桌伪造事务、旧撤回凭据、已提交回执补份、重复snapshot key | 11项真实PG安全测试，两轮及整体回归通过 |
| 权益/库存/支付不重复变化 | 非空库存流水/余额快照、年度兑换已完成撤回不重发 | 两轮专项及整体回归通过 |
| 手机已送达历史来源与权限 | sharedDeliveries+原个人历史、撤回刷新、当前桌分配、跨店隔离 | 新PG4+原PG5、手机组件2及整体回归通过 |
| 横屏按钮、完整备注、多人快取 | 1024×600/640/768制作组件、19项真实React取餐控件；正式全系统浏览器 | 组件6/6、取餐控件19项及最终实际截图通过 |
| 多品项与持续运行性能 | 51任务分批、累计历史、1000份外范围数据、强制generic plan | 两轮26/26通过；整体回归51任务场景384ms |
| 真实10寸平板触感、摆放与人员现场配合 | 需要门店实物与真实设备 | 尚未现场验收；模拟不能替代 |

手机自然历史页不再自行向下滚动，标题与首条记录可见；取餐、撤回恢复与最后20条共享送达记录均已通过真实UI核对。[逐项验收表](/Users/jingda/mbox/outputs/three-screen-development-20260921/acceptance-matrix.csv)。

## 最终检查结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| server/normalized整体回归 | 2276通过、0失败、1条件跳过；279文件通过/1文件跳过；115.17秒 | [最终报告](/Users/jingda/mbox/outputs/three-screen-development-20260921/full-postgres-final-summary.md) |
| 取餐与独立数据库安全 | 两轮各26/26；第二轮新数据+强制generic plan；源文件指纹相同 | [取餐报告](/Users/jingda/mbox/outputs/three-screen-development-20260921/pickup-production-verification.md) |
| npm run check | 通过；其中Vitest2052通过、804条件跳过；含Web类型、lint、构建、架构/发布元数据、微信/支付宝检查与相关测试 | [冻结提交检查日志](/Users/jingda/mbox/outputs/three-screen-development-20260921/check-final-scroll.log) |
| 正式三屏浏览器联动 | 最终7e2250d通过：20桌80份，2.3分钟；自然手机标题/命中、全部截图复核通过 | [日志](/Users/jingda/mbox/outputs/three-screen-development-20260921/browser-final-scroll.log) |
| 发布配置检查（不执行发布） | 33项运行配置+1项模板通过；原Linux shell3/3、三屏默认值2/2、规范化16次断言通过 | [配置专项](/Users/jingda/mbox/outputs/three-screen-development-20260921/configuration-linux-c1c972d/README.md) |

整体回归的唯一跳过为专用容器数据库恢复演练；共享55443容器不运行有宽前缀清理的恢复测试。审计任务的独立容器演练属于另一个证据，不拼成本轮通过数。普通npm check的数据库条件跳过由上述真实PG回归补充；各套测试有交集，数字不能相加当作独立用例总量。构建通过仍有原有分包体积/动态引入提示，lint为0错误，不能称作完全无提示。

性能复核：两轮每轮33次队列读取最大49ms；单份取走约21–26ms；50份取走113–119ms，整体撤回138–153ms。在整套测试的累计数据场景，51任务检查共384ms。均是本机Fastify API和隔离PostgreSQL耗时，不含真实网络、制作、步行或手指操作，不是现场产能或p95承诺。早期累计数据缺陷与失败日志已保留，未将旧失败样本删除或计作通过。

正式浏览器模拟角色为调酒师、厨师、共用取餐屏及一个手机观察端；四名服务员的人流/轮次来自原型模拟，领取并发冲突由独立接口测试覆盖。20桌80份场景包含真实页面点击、实库状态校验、提交成功后响应丢失、刷新恢复、撤回、重取、会话切换恢复和完整长备注核对。自动化运行耗时不能当作80份实物完成时间。

制作反馈截图复核另发现：原先“等待取走”的成功提示在随后领取后仍残留，现改为“上次操作：已确认放好”的过去操作事实，当前数量只由权威待取/已取走投影展示。修复后6项横屏组件检查均通过。[组件复核](/Users/jingda/mbox/outputs/three-screen-development-20260921/kitchen-ui/latest-review.md)。原失败截图保留在`browser-c1c972d-visual-review/`，不冒充终态视觉通过。

手机视觉复核另定位到隐藏的读屏announcer被全局反馈观察器当作可见消息，触发长历史页自动向下滚动。最小修复为给该隐藏元素加`data-action-reveal="off"`，保留`aria-live="polite"`读屏语义，不改全局滚动器。独立真实浏览器合成页对照中，旧元素触发2次smooth滚动、800ms后scrollY=4264；修复后0次、scrollY=0。最终7e2250d真实三屏测试通过，并核对自然切换历史后的实际命中和遮挡；原始自然截图与定位后的截图均由root目视核验。[滚动审查证据](/Users/jingda/mbox/outputs/three-screen-development-20260921/phone-scroll-review/review.md)。

## 集成交接与未完成边界

- 已与“检查代码并部署合并”对齐：本分支负责SYS314/315和完整制作/待取/取走/撤回；审计分支负责225–227及共享清单，双方同基线。最终统一集成需要保留两个任务在`normalized-app.ts`、运行配置和生成脚本的不同片段，不用任一文件整体覆盖另一方；`command-executor.ts`未改。
- 完整PG回归的918个受检文件在最终两次UI修正后仍逐文件一致；配置专项8个源文件同样未变。数据库/配置证据可按哈希关联到最终实现，UI变更则重新运行npm check与正式浏览器，不将旧截图冒充新版本。
- 本轮只做本地业务与交付说明提交。未推送、未合并、未部署、未上传小程序。微信/支付宝本轮为源码文案与本地检查证据。
- 225混合退款政策及候选发布冻结由审计任务负责，当前不能声称依赖已具备发布批准；正式集成后需以最终组合重新完成必要发布前检查。
- 真实10寸平板、店内网络、相邻取餐口的实物摆放、4名服务员同时来取的手势与动线、真实高峰制作产能尚未现场验收。可确认的是本地实现和已列出的模拟/自动化要求，不是“全部现场要求已验证”。

## 店内最终验收动作（尚未执行）

1. 实际10寸横屏打开制作屏，确认普通与长备注订单、份数步进、放好按钮在真实浏览器工具栏高度下均可用。
2. 调酒师和厨师分别放好同桌酒水/小食；取餐屏只出现确实摆好的份数，四名服务员从相邻取餐点核对后领取，不选姓名。
3. 一次合取与一次少取；核对实物、桌号、手机及制作屏计数，手机不再确认送达。
4. 实物仍在取餐口时误触并整次撤回；手机重现待取，重取不重复制作、扣库存或发放权益。
5. 模拟店内网络中断及恢复，核对原操作能恢复、未摆好的货不会被并入、未收到回执不会假报成功。
6. 实际交班和一次重做，确认接班人可继续、原在制不残留，设备真正清空后才释放。

以上是现场验收要求，不是本轮已通过记录；当前不启动生产或门店操作。

## 最终65个业务文件

以下清单对应基线至最终实现`7e2250db74e826d9531d384d037f9dfb1b4ce854`的累计差异，不含四个审计依赖；交付说明后续更新不改变实现。

- `alipay-miniprogram/pages/member-center/index.js`
- `database/normalized-migrations/228_three_screen_workflow.sql`
- `deploy/aliyun/normalize-runtime-env.sh`
- `docs/three-screen-development-20260921.md`
- `miniprogram/pages/member-center/index.js`
- `package.json`
- `scripts/fixtures/three-screen-browser-fixture.ts`
- `scripts/generate-normalized-runtime-config.ts`
- `scripts/start-normalized-browser-e2e.ts`
- `scripts/three-screen-benefit-display.test.mjs`
- `server/migrate-normalized.test.ts`
- `server/normalized/annual-daily-snack-claim-service.ts`
- `server/normalized/commerce-kds-api.test.ts`
- `server/normalized/commerce-kds-api.ts`
- `server/normalized/customer-experience-repository.ts`
- `server/normalized/fulfillment-query-service.test.ts`
- `server/normalized/fulfillment-query-service.ts`
- `server/normalized/item-quantity-projection.ts`
- `server/normalized/kds-authorization-policy.ts`
- `server/normalized/kitchen-production-api.ts`
- `server/normalized/kitchen-production-command.test.ts`
- `server/normalized/kitchen-production-handoff.ts`
- `server/normalized/kitchen-production-query.ts`
- `server/normalized/kitchen-production-successor.test.ts`
- `server/normalized/normalized-app.ts`
- `server/normalized/normalized-runtime-config.test.ts`
- `server/normalized/normalized-runtime-config.ts`
- `server/normalized/operating-history-pickup.test.ts`
- `server/normalized/operating-history-query.test.ts`
- `server/normalized/operating-history-query.ts`
- `server/normalized/operations-query-service.ts`
- `server/normalized/pickup-workflow-api.ts`
- `server/normalized/pickup-workflow-query.ts`
- `server/normalized/pickup-workflow-repository.ts`
- `server/normalized/pickup-workflow.test.ts`
- `server/normalized/table-session-closure-blockers.ts`
- `server/normalized/three-screen-security.test.ts`
- `src/normalized-ui/AnnualBenefitManagementPanel.tsx`
- `src/normalized-ui/NormalizedStaffApp.tsx`
- `src/normalized-ui/staff-actions/FulfillmentHistoryPanel.tsx`
- `src/normalized-ui/staff-actions/KitchenProductionBoard.tsx`
- `src/normalized-ui/staff-actions/PickupBoard.tsx`
- `src/normalized-ui/staff-actions/StaffActionsPanel.tsx`
- `src/normalized-ui/staff-actions/StaffReadyNotice.tsx`
- `src/normalized-ui/staff-actions/ThreeScreenWorkspace.tsx`
- `src/normalized-ui/staff-actions/kitchen-board-state.test.ts`
- `src/normalized-ui/staff-actions/kitchen-board-state.ts`
- `src/normalized-ui/staff-actions/kitchen-production-board.css`
- `src/normalized-ui/staff-actions/pickup-api.test.ts`
- `src/normalized-ui/staff-actions/pickup-api.ts`
- `src/normalized-ui/staff-actions/pickup-board-state.test.ts`
- `src/normalized-ui/staff-actions/pickup-board-state.ts`
- `src/normalized-ui/staff-actions/pickup-board.css`
- `src/normalized-ui/staff-actions/pickup-phone-notice.test.ts`
- `src/normalized-ui/staff-actions/pickup-test-fixtures.ts`
- `src/normalized-ui/staff-actions/staff-actions-api.test.ts`
- `src/normalized-ui/staff-actions/staff-actions-api.ts`
- `src/normalized-ui/staff-actions/staff-notice-controller.ts`
- `src/normalized-ui/staff-actions/three-screen-route.ts`
- `src/normalized-ui/staff-actions/three-screen-workspace.css`
- `src/normalized-ui/staff-actions/types.ts`
- `src/shared/kitchen-production.ts`
- `src/shared/operating-history.ts`
- `src/shared/pickup-workflow.ts`
- `tests/normalized-e2e/normalized-three-screen.spec.ts`
