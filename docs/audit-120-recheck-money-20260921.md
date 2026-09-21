# SIM120 资金问题独立复核

复核时间：2026-09-21 06:47—06:51 CST。冻结源码：`f8306c7718e011f451af5f0eb29f0e8e16dbd532`，最近业务提交 `c87a014`；原审计源码 `77744bc4e9ed308546b630590bdfa5dfe5ce5b7d`。隔离数据库实际迁移到 schema **228**。

**结论：SIM120-01、SIM120-02、SIM120-03 均未修复，当前集成候选上真实数据库再次复现。** 4 项用例通过是“1 项正常对照和 3 项故障表现断言通过”，绝不是修复验收通过。未更改业务源码或商业清单，未提交或变更分支，未操作生产收退款。

## 本次证据

| 问题 | 当前复核读回 | 判定 |
|---|---|---|
| SIM120-01 / P1 | 40 元套餐已收 40 元，退 2 瓶后保留商品按原单点价应收 44 元，尚欠 4 元；收款列表和打印汇总正确。保留份数经真实履约仓库完成后，`begin-closing` 和 `close` 均 200，桌次为 `closed`，关桌欠款 0、无阻断，打印仍欠 400 分。 | 未修复 |
| SIM120-01 / 第二路径 | 原 40 元订单收 16 元，退 1 份并实际退 8 元后，有效应收 32 元、净收 8 元、待收 24 元。订单 `partially_refunded`，关桌资金阻断仍为 0，未结订单事实为空；本用例尚有出品阻断，不把它描述为已经再次实际关桌。 | 未修复 |
| SIM120-02 / P2 | 已付 40 元，按份退 8 元后，再服务补偿 1 元。真实持久票据仍为“预结账单/尚未收款 1 元”，收款列表却为空；无重收授权。普通订单仅补偿 1 元的对照正常无欠款。 | 未修复 |
| SIM120-03 / P2 | SIM120-01 第二路径正确待收 24 元，`mbox.operating_day_summary` 的该订单待收增量仍为 16 元，少 8 元。按前后增量隔离其他用例订单。 | 未修复 |

所有金额上表以元表达，机器日志以分记录。本次 4 个合成订单的实际收款 13,600 分、成功退款 1,800 分；数据库收款分录 4 笔合计 13,600 分、退款分录 4 笔合计 −1,800 分，收退款记录和分录一致。缺陷发生在应收/欠款及业务阻断投影，并非本次发生重复扣款或分录丢失。

## 源码比对和根因

下列文件与原审计源码逐字节相同，原始 SHA-256 对照已保存：

- `server/normalized/order-collection-sql.ts`：第 10—11 行只要存在数量计价事实，就使用全部成功退款，未分开服务补偿。
- `server/normalized/checkout-print-summary.ts`：第 11—14 行据上述谓词以有效应收减收款加全部退款生成待收。
- `server/normalized/business-day-blocker-facts.ts`：第 66—70 行按累计收款、不减退款；随后将 `paid/partially_refunded/refunded` 当作已结清。
- `server/normalized/item-after-sales-command-service.ts`：第 221—224 行原售后完成同步未增加本案欠款投影修复。
- `database/normalized-migrations/201_item_quantity_after_sales_foundation.sql`：第 596—601 行日报仍只在有效重收授权存在时计入已退金额；225—228 没有重定义 `operating_day_summary`。

当前 `table-session-closure-blockers.ts` 确有三屏修改，但仅增加重做份数的 KDS 未完成判断。第 128 行仅处理 `unpaid/pending/partially_paid`，第 133—134 行直接放过 `paid/partially_refunded/refunded` 的资金判断未改。`commerce-kds-api.ts` 的本轮变化为注册取餐路由、旧送达入口转由共享取餐屏处理，收款列表的相应计算未修。不能因相关文件有改动就判定 SIM120 资金缺陷已修。

## 与会员奖账修复的交叉

集成候选新增 225 迁移及 `loyalty-accrual-repository.ts` 等修改：奖账锚点和实际退款来源分开，未付款停品调整进入奖账基数，按原销售退款经济事实冲回，并保存混合计分与超收退款待核记录。这属于 SYS-311—313 的奖账工作；本次只做源码比对，没有复跑该会员专项，也不把开发方的会员测试结果当成本次独立实测。

这套奖账变化没有统一修复顾客实际欠款、普通关桌、结账票据与日报，因此不能替代 SIM120-01—03 的关闭证据。后续统一修复时需要交叉回归：

1. 套餐退品提高保留商品应收，尚欠/补收/原奖账与追加奖励一致，未授权重收保护继续有效。
2. 分笔收款后数量退款，实际消费余额不因退款付款来源或重收授权状态改变；积分成长只按已确认规则冲回。
3. 数量退款与服务补偿任意先后顺序，退款类别既不能凭空制造顾客欠款，也不能误作销售退回多扣奖励。

混合计分与真实超收的分配政策、`loyalty_refund_reviews` 待核关闭流程仍应由相应任务独立验收。本报告不扩大实施范围，也不授权自动重算或重放历史生产奖账。

## 可重现命令及证据

专属隔离库：`postgresql://mbox_audit@127.0.0.1:56521/mbox120_recheck_money`。使用真实 PostgreSQL、命令服务、权限校验和异人退款审批；Fastify 路由仅注入测试登录上下文，后台仍核验实际能力。打印目标为离线测试设备，没有纸票实打。当前三屏启用方式不影响这三个资金谓词；套餐场景使用原真实履约仓库清理物理未完成阻断，再测试原普通关桌 HTTP 门槛。

```sh
TEST_NORMALIZED_DATABASE_URL=postgresql://mbox_audit@127.0.0.1:56521/mbox120_recheck_money npx vitest run server/normalized/audit-120-recheck-money.test.ts --reporter=verbose
```

本次输出：1 文件、4 项通过，用时 2.27 秒，开始 06:47:53。首次创建隔离库被沙箱阻挡，提升仅本机连接权限后正常；这是环境限制，没有登记为业务缺陷。没有夹具业务失败，没有重跑全仓。

- 复核测试：`/Users/jingda/mbox/mbox-120-guests-recheck-20260921/server/normalized/audit-120-recheck-money.test.ts`
- 完整测试日志：`/Users/jingda/mbox/outputs/120-guests-recheck-20260921/money/reproduction.log`
- 源码 SHA-256、逐项读回及判定：`/Users/jingda/mbox/outputs/120-guests-recheck-20260921/money/money-evidence.json`
- schema 与收退款分录汇总：`/Users/jingda/mbox/outputs/120-guests-recheck-20260921/money/database-readback.json`

这是本地冻结集成候选的复核，生产身份与上线状态由根任务单独实查。三项不得标记修复完成；后续修复提交需要再次跑对应正向验收断言，而非把本文件的故障表现断言保留为发布验收。

复核完成后，已删除本次专属合成测试库 `mbox120_recheck_money`，保留上述日志与汇总证据；没有停止其他任务使用的本轮 PostgreSQL 实例。
