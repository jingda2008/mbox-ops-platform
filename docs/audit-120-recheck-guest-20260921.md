# SIM120 顾客侧独立复核：04—07、10

复核日期：2026-09-21 06:47—06:50 CST。冻结候选 `f8306c7718e011f451af5f0eb29f0e8e16dbd532`，工作区 `/Users/jingda/mbox/mbox-120-guests-recheck-20260921`；原审计业务基线 `77744bc4e9ed308546b630590bdfa5dfe5ce5b7d`。

**结论：本组五项全部仍可复现，已修复 0 项。** 本次已运行新候选的真实 Fastify 服务路由、PostgreSQL、实际微信页面模块及网页提交回调，不能只因文件存在或测试显示绿色而宣布修复。以下三项测试刻意断言缺陷，因此 `3 passed` 代表三种故障复现成功，合计覆盖 SIM120-04—07 四项；扫码脚本另有 48 次服务调用，不能将含失败的观察算作功能通过。

## 动态结果

| 编号 | 原优先级 | 本次判断 | 实际证据 | 本次候选定位 |
|---|---|---|---|---|
| SIM120-04 | P1 | 仍复现 | 5 次普通服务后新投诉首次 429；隔离库仅将限流窗口前移并重建微信运行时，持久原键仍返回重放 429，投诉任务 0。新键对照立即 201、任务 1。客户端仍为 `HTTP_ERROR`，丢失 `retryAt`。 | `server/normalized/guest-commerce-service-api.ts:762-832`；`miniprogram/utils/recoverable-command.js:24-37`；`miniprogram/utils/request.js:228-233` |
| SIM120-05 | P2 | 仍复现 | 实际网页服务回调提交“请送一张消费单据”，原请求提交成功且服务任务已完成后丢失响应；重试生成第二个幂等键。数据库两任务状态 `completed`、`pending`，首次界面通知仍为“网络好像走神了，请检查网络后重试。”。 | `src/normalized-ui/guest/GuestApp.tsx:436-456` |
| SIM120-06 | P1 | 仍复现 | 31 笔未付订单各 10 元，数据库 310 元；API 返回第 2—31 笔合计 300 元，实际微信账户页显示 `¥300.00`、当前桌无分页，并删除第 1 笔未付订单的本地付款恢复记录。数据库未丢失该订单。 | `server/normalized/guest-table-orders-query.ts:211-219`；`miniprogram/pages/account/index.js:177-183,225-227` |
| SIM120-07 | P2 | 仍复现 | 在同一 31 笔夹具中，实际微信服务页仅提供 8 笔订单（第 2—9 笔）及整桌选项；最新第 31 笔不可选。整桌投诉仍可发起，不等于完全没有投诉入口。 | `miniprogram/pages/service/index.js:62-73` |
| SIM120-10 | P1 | 仍复现 | 三组并发分别失败 9/12，PostgreSQL `40001`；失败请求都已尝试 3 次。顺序对照 12/12 成功。不是没有事务重试，而是既有立即重试仍耗尽。 | `server/normalized/guest-session-repository.ts:748`；`server/normalized/transaction-runner.ts:193-199` |

扫码使用真实 `GuestSessionService`、`CustomerRepository` 与事务 runner，连接池 12，各组独立合成门店、桌台和设备身份：

| 场景 | 成功 | 失败 | 事务尝试总数 |
|---|---:|---:|---:|
| 12 人同桌、匿名身份、并发 | 3 | 9 | 33 |
| 12 人异桌、匿名身份、并发 | 3 | 9 | 33 |
| 12 人异桌、预建的不同顾客身份、并发 | 3 | 9 | 33 |
| 12 人异桌、匿名身份、顺序 | 12 | 0 | 12 |

同桌失败为并发更新序列化冲突，异桌失败为读写依赖序列化冲突。本次只定向验证缺陷仍在，没有重跑原 120 人 HTTP 全场，也没有测量门店真实失败率；不得将这些本机受控突发比例外推到生产。新库统计信息及查询计划仍可能放大 SSI 冲突，唯一底层 SQL 根因和生产规模性能不在本次结论范围。

## 源码比对与相关修复边界

以下九个文件与原审计基线逐字节相同：`guest-table-orders-query.ts`、`guest-session-repository.ts`、`customer-repository.ts`、`transaction-runner.ts`、微信 `pages/service/index.js`、`pages/account/index.js`、`utils/api.js`、`utils/recoverable-command.js`、`utils/request.js`。

`guest-commerce-service-api.ts`、网页 `GuestApp.tsx`、`guest-api.ts` 已有变化，但比对内容为共享购物车/原支付终态恢复；本组服务提交、限流回执和当前桌订单截断路径未修正。因此相关支付恢复变更不能作为 SIM120-04—07、10 的关闭证据。逐文件 SHA-256 在 `source-comparison.json`。

## 执行与证据

- 测试文件：`/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/audit-120-recheck-guest.test.ts`。仅从原审计复制并注明复核语义，没有改变业务断言或生产实现。
- 扫码脚本：`/Users/jingda/mbox/mbox-120-guests-recheck-20260921/scripts/audit-120-recheck-scan.ts`。仅适配专用库名、候选 SHA 与输出路径，保持原四组 12 人对照。
- 三个缺陷断言原始日志：`/Users/jingda/mbox/outputs/120-guests-recheck-20260921/guest/defect-reproductions.log`。
- 扫码原始日志及逐请求 JSON：`/Users/jingda/mbox/outputs/120-guests-recheck-20260921/guest/scan-contention.log`、`scan-contention.json`。
- 源码摘要：`/Users/jingda/mbox/outputs/120-guests-recheck-20260921/guest/source-comparison.json`。
- 执行信息和文件摘要：`/Users/jingda/mbox/outputs/120-guests-recheck-20260921/guest/recheck-summary.json`。

执行命令（只连接本机专属合成数据库）：

```sh
TEST_NORMALIZED_DATABASE_URL=postgresql://mbox_audit@127.0.0.1:56521/mbox120_recheck_guest PGOPTIONS='-c TimeZone=UTC' node node_modules/vitest/vitest.mjs run server/normalized/audit-120-recheck-guest.test.ts --reporter=verbose --hookTimeout=120000
TEST_NORMALIZED_DATABASE_URL=postgresql://mbox_audit@127.0.0.1:56521/mbox120_recheck_guest PGOPTIONS='-c TimeZone=UTC' node --import tsx scripts/audit-120-recheck-scan.ts
```

迁移执行至 `228_three_screen_workflow.sql`，三项缺陷复现测试 3/3 完成、0 跳过；扫码四组共 48 次真实服务调用。顾客鉴权、商品、订单均由隔离夹具提供；页面在 VM 执行实际模块，并非微信真机或完整浏览器操作。服务完成步骤用系统测试 actor 调用真实仓库，不声称岗位真人验收。

本组没有生产请求、真实支付退款、打印、部署、业务源码修复或清单写入。仅操作自己的 `mbox120_recheck_guest` 数据库，全部取证后已成功删除；未停止共享测试实例或操作其他子任务数据库。修复关闭仍须在最终 A/B 集成 SHA 上重新复现并验证正确结果。
