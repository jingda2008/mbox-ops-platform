# 120 人场景复核：投诉与三屏履约

日期：2026-09-21。复核对象固定为 `f8306c7718e011f451af5f0eb29f0e8e16dbd532`（业务集成 `c87a01430fb3ef2e55e2d27b33250f5e4c69ac37`）。

**结论：SIM120-08、SIM120-09、SIM120-11 均仍复现。** 4 个专用缺陷捕获用例执行成功，含 SIM120-11 的两个现行三屏路径；这表示故障已被捕获，不能表述为“4 项功能验收通过”。本轮没有修复业务源码，没有生产写入或发布。

| 问题 | 复核结论 | 动态证据 |
| --- | --- | --- |
| SIM120-08 紧急投诉被已分配普通任务挡住 | 仍复现 | 真实 DB 创建 120 项任务，服务端紧急投诉排序第 1；实际前端排序函数将它排到第 9，默认仅显示前 8 项 |
| SIM120-09 顾客离店翻台取消未处理投诉 | 仍复现 | 没有 `service.manage` 的翻台员工成功翻台，投诉由 pending 变 cancelled，从工作队列消失；无店长解决事件 |
| SIM120-11 现金和出品相反锁顺序 | 仍复现 | 现金实际命令分别与现行厨房 ready、共享取餐 take 路由并发，两组均产生真实 PostgreSQL `40P01` |

## 证据及运行方式

- 专用测试：[audit-120-recheck-fulfillment.test.ts](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/audit-120-recheck-fulfillment.test.ts)。
- 完整日志：[run-1.log](/Users/jingda/mbox/outputs/120-guests-recheck-20260921/fulfillment/run-1.log)。
- 重试后账本回读：[ledger-readback.csv](/Users/jingda/mbox/outputs/120-guests-recheck-20260921/fulfillment/ledger-readback.csv)。
- 隔离 PostgreSQL `127.0.0.1:56521`，专属库 `mbox120_recheck_fulfillment`，迁移至 228。业务事务显式 `SET LOCAL ROLE mbox_runtime`，保留 RLS、数据库约束、实际权限检查；初始化夹具使用本地管理员。
- 执行命令：`TEST_NORMALIZED_DATABASE_URL=postgresql://mbox_audit@127.0.0.1:56521/mbox120_recheck_fulfillment node node_modules/vitest/vitest.mjs run server/normalized/audit-120-recheck-fulfillment.test.ts --reporter=verbose`。
- 结果：`1 file / 4 tests passed`；约 4.35 秒仅是本次定向测试时长，不是性能承诺。

旧夹具已按当前接口适配：使用真实业务日和六小时员工会话；增加设备配置及现金权限；启用当前 kitchen / pickup 插件；取餐设备通过当前配置路由启用；厨房提交当前批次所有权版本；选择实际返回的单位版本。没有调用旧 `deliver` 接口，也没有新增第二次送达确认。单个测试员工合并持有制作、取餐、现金权限，以隔离事务锁顺序；这不证明真实门店角色配置正确。现金侧调用实际 `PaymentCommandService.recordManual` 与授权、幂等执行器；三屏侧使用 Fastify `inject` 经当前路由（不是外部 HTTP 监听器或浏览器实点）。

## SIM120-08：默认列表仍会挡住紧急投诉

120 个真实服务任务中，8 个普通任务分配给当前员工，第 120 个任务是未分配给当前员工、要求店长处理的 urgent 投诉。所有测试桌台共用同一个 areaId；本轮证明的是分配归属优先导致紧急投诉被挡住，没有独立验证跨区条件。`OperationsQueryService.getStaffView` 返回全部 120 项，投诉位于第 1。随后调用页面实际使用的 `actionableServiceTasks` 和 `prioritizeActionFact`，投诉索引变为 8（第 9 位），默认 8 条不可见。

根因仍是“是否分配给自己”优先于紧急程度，然后固定截取 8 条。来源：

- [staff-actions-model.ts:80](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/src/normalized-ui/staff-actions/staff-actions-model.ts:80)。
- [StaffActionsPanel.tsx:451](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/src/normalized-ui/staff-actions/StaffActionsPanel.tsx:451)、[默认截断:1590](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/src/normalized-ui/staff-actions/StaffActionsPanel.tsx:1590)。

边界：数据库没有丢失投诉；已有工作台深链接能将指定投诉置顶，本轮也验证该回退方式成立。证据是 DB + 实际 UI 数据函数，没有重做浏览器视觉验收。不能扩大为所有入口都不可见。

## SIM120-09：离店翻台仍把未解决投诉作取消处理

创建“食品异物投诉要求后续答复”，详情明确顾客先走但仍须跟进。另一员工只有 `table.close`、`table.turnover_unsettled`，并是该桌主服务员；实查 `service.manage=false`。调用当前 `PostgresTableCustomerLeftTurnoverRepository.close` 后：

- `cancelledServiceTaskCount=1`，投诉状态 cancelled。
- 投诉从当前员工工作队列消失。
- 事件仅 `task.created` 和 `customer_left_cancelled`；取消备注是“顾客已经离店立即翻台”，没有店长处理、答复或结案事实。

SQL 对该桌所有 pending / acknowledged / in_progress 服务任务直接取消，没有投诉类型排除：[140_customer_left_table_turnover.sql:435](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/database/normalized-migrations/140_customer_left_table_turnover.sql:435)。当前全迁移真实执行结果确认后续迁移没有消除此行为。

边界：原投诉及取消事件仍保留，并非物理删除。系统把“顾客离开”当作取消投诉的充分条件，造成跟进闭环中断；是否另有人工线下记录不在本轮证据中。此场景刻意使用无销售订单的已开桌，证明问题不依赖退款结账争议。

## SIM120-11：新三屏路径仍能与现金命令形成死锁

真实控制流：

1. 现金在 [payment-security-policy.ts:163](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/payment-security-policy.ts:163) 先锁 order `FOR SHARE`，再经 [employee-table-access.ts:56](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/employee-table-access.ts:56) 请求 table_session `FOR UPDATE`。
2. 当前厨房 ready 在 [kitchen-production-api.ts:102](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/kitchen-production-api.ts:102)，共享取餐 take 在 [pickup-workflow-repository.ts:35](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/pickup-workflow-repository.ts:35)，均调用 [quantity-task-lock.ts:15](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/quantity-task-lock.ts:15)，先锁 table_session `FOR SHARE` 再请求 order `FOR UPDATE`。
3. 测试仅在两个真实锁已获取后设置调度屏障，不替换 SQL、不注入虚假数据库错误。双方各持一个对方需要升级的锁，PG 检出循环等待并回滚一方。
4. 当前通用命令执行器不传冲突重试参数，transaction runner 默认 `retryOnConflict=0`：[command-executor.ts:153](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/command-executor.ts:153)、[transaction-runner.ts:193](/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/transaction-runner.ts:193)。

实际两组结果：

| 并发操作 | 初次现金结果 | 初次三屏结果 | 数据库证据 |
| --- | --- | --- | --- |
| cash + kitchen ready（5 份） | 收款成功 | HTTP 500 `INTERNAL_ERROR` | 出品事务 `40P01 deadlock detected` |
| cash + pickup take（5 份） | 命令抛出 `40P01`、回滚 | HTTP 200，5 份取走即送达 | 现金事务 `40P01 deadlock detected` |

第一组 PG detail 是事务 28248 / 28250 循环等待，第二组是 28267 / 28269，完整日志保留进程号及错误细节。死锁牺牲方由 PG 决定，不保证每次都是上述一方；本轮不把现金服务异常冒称为已实测现金 HTTP 状态，也没有声称取餐本次返回 503。

取消屏障后，两组使用原幂等键分别重试、再重放。当前路径能恢复，数据库回读：

- 每个订单仅 1 笔 succeeded 现金 payment，金额 5000 分；每笔仅 1 条 payment 对账分录，金额同为 5000 分。
- 厨房组 5 份 ready，取餐组 5 份 delivered。
- 取餐仅 1 张回执、5 份，`takenAt=deliveryConfirmedAt` 且 `deliverySource=pickup`，符合“取走即送达”。

这证明在本组错误后正确保留原凭据可恢复且未重复记账；不能据此认定首轮死锁已修复。该证据确认可达锁序缺陷，不估计真实 120 人高峰的发生率；没有本轮全量 120 份履约回归，也没有生产流量或现场设备验证。

## 收尾

只新增专用审计测试和此报告，其他报告由根任务汇总；业务源码、清单、Git 和其他工作树未修改。隔离库清理结果见 `cleanup.log`。生产版本和发布链身份由根任务独立回读，本报告不将本地候选复核等同线上已部署。
