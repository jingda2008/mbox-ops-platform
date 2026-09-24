# 下单、支付、制作与取走闭环检查

检查日期：2026-09-24；最终只读数据复核10:18 CST。结论：能确认历史顾客订单从提交、确认收款到KDS出品记录；不能认定三屏取走及实物送达已经完整闭环。

## 范围与运行状态

- 生产rc.230，应用SHA `8d8c134e533283bad6033b9db99e7b5de25f88a0`，schema245；10:17 CST readiness为ready、workers healthy、writeEnabled=true。
- 审计源码SHA `3c004919ae372181d2fde5cdce416ca73e6898e4`。与生产SHA相比，server/src/database/miniprogram范围仅新增历史退款修复集成测试，无本次业务运行时代码差异。
- 生产只读事务，statement_timeout=8s、lock_timeout=1s；本轮没有下测试单、扣款/退款、生产数据修改、服务重启或发布，没有访问或同步旧120人任务。
- 06:00为营业日边界。最近营业日7笔guest_qr订单全部发生在rc.230切换前；当前版本尚无切换后的顾客下单支付样本，因此不能把这7笔当成本次版本现场验收。

## 现场证据矩阵

| 环节 | 已核实的事实 | 结论和边界 |
| --- | --- | --- |
| 下单 | 上一营业日7笔顾客订单；4笔有确认收款，3笔未支付且已关闭 | 未支付3笔没有KDS任务；没有通过人工标已付来补闭环 |
| 支付 | 已付4笔分别254、98、300、196元，合计848元；每笔1笔确认收款，成功退款0，当前应收等于原订单总额，欠款0 | 来自数据库确认支付事实，本轮未再次调用支付渠道；不把支付尝试当收款 |
| 派单 | 已付4笔共8商品行、11份，每行均有原始KDS任务；全店检查原始任务重复分组0、活跃且需制作商品漏任务0 | 付款时间之后生成制作任务，未发现该检查口径内的重复派单 |
| 制作 | 8行均保留accepted/preparing/ready事件；1行厨房、7行吧台 | 数据证明系统登记出品；不能凭瞬时连点的状态时间证明实际制作耗时或实物质量 |
| 库存 | 7个tracked商品行均有sale扣料及consumed预留，逐行数量匹配；1行not_managed无扣料 | 本次4笔范围内未发现清桌把已耗材料退回；未验证全部历史配方用量和实物盘点 |
| 取走/送达 | 4笔没有取走记录，没有按份units；全库制作批次0、取走回执0、取走撤回0、启用取餐设备0 | 三屏功能开关已开并不代表设备绑定和真实流程启用；当前样本使用旧KDS整行操作 |
| 跨日清桌 | 4笔桌台在06:00:04 automatic_cutoff关闭；其8行商品及KDS状态变为cancelled，原订单仍paid/active | 既有设计结束未登记送达的营业任务，保留财务；不是资金撤销，也不能推断实物没送到。现场缺送达记录且状态表达容易误解 |

另有一组历史“已确认收款但履约不活跃”记录为已退款且履约cancelled；该筛选结果本身不足以认定付款漏制作，未列为故障。

## 隔离验证及缺陷

第一轮12个测试文件、333项：332通过、1失败。覆盖订单、确认支付和激活、支付/履约锁序、未支付过期、厨房/吧台分批、交接、取走与撤回、权限、重做库存、关桌终止、顾客API、按份售后。临时本地数据库运行001–245迁移并配置独立受限LOGIN；各测试按自身fixture选择admin/SET ROLE或真实runtime LOGIN，不把整套测试统称为真实受限登录覆盖。临时数据库和角色已清理。

失败项：`kitchen-production-successor.test.ts` 的“rechecks handoff exception permission and session before replay and preserves immutable original evidence”，撤销交接权限后，board.canHandoff仍为true。

根因已独立复现：`StaffAccessRepository.resolve`默认用JavaScript毫秒精度ISO时间，权限覆盖starts_at默认PostgreSQL微秒精度clock_timestamp。同一毫秒内刚提交deny、立即鉴权，应用时间可能早于starts_at，因此deny未生效。150次本地立即撤销/读取实验有108次出现，差值0.004–0.737毫秒；相同记录用其数据库精确starts_at求值全部拒绝。这个比例只是低延迟本地复现，不是生产发生率；没有生产越权操作证据。数据库时钟与应用时钟偏差可能放大窗口，当前未测生产时钟差。

该补充实验1项通过，仅表示根因复现成功，不替代首轮失败，也不表示代码已修复。原始失败日志保留；本轮未通过重跑或加sleep把缺陷掩盖成全绿。

## 最小后续工作

1. SYS-376：在实际取餐设备完成可信设备绑定和最小权限登录，让后续真实订单形成“制作完成→取走即送达→误触按原回执撤回”证据。旧整行出品入口与三屏之间需核对实际使用路线；不得自动编造历史送达记录。
2. SYS-376：跨日记录应清楚保留“已出品、送达未登记、跨日终止”含义，使其与未制作取消可区分；继续保留旧事件、原收退款和已耗库存。不得因清桌重新收款或擅自补退款。先验证现有页面展示，再决定是否需要小范围展示/审计补丁。
3. SYS-377：在线权限鉴权统一使用可信数据库时间并保留精度，保持显式历史时间查询语义；增加立即撤销、到期、未来生效及交接幂等重放回归。修复验证后按标准程序发布；本轮不以检查结果冒充已修复/已部署。

## 证据与复现

受限原始证据目录：`/Users/jingda/mbox/outputs/order-payment-production-audit-20260924/`。包括flow-overview、guest-flow-traces、financial-stock-crosscheck的SQL和JSON，flow-tests.log，clock-audit-evidence.json和clock-audit.log。逐订单技术标识仅在受限目录，不放入本报告。

查询校正：最初未设置app.tenant_id/app.store_id，order_receivable_amount显式范围校验返回NULL，因此那一轮函数派生金额不可用。已保留`*-unscoped`原件并明确废弃其金额结论；最终在只读事务中设置正确门店范围重新查询，四笔应收分别25400/9800/30000/19600分、欠款均0。原始支付/退款和库存事实不依赖这个NULL推断。

本地时钟复现源保存在受限目录`kitchen-production-clock-audit.test.ts`，专用运行器`run-clock-audit.mjs`；复制回同名server/normalized测试路径和.runtime运行器路径，再用显式localhost临时数据库运行，可复核。补充用例只在隔离环境创建合成员工、权限等数据。生产设备实物操作与新版本顾客真实订单未做，闭环验收保持未完成。

代码定位：`commerce-command-service.ts`、`payment-fulfillment-repository.ts`、`kitchen-production-query.ts`、`pickup-workflow-query.ts`、`staff-access-repository.ts`；迁移143/149保留财务并跨日终止营业任务，202定义应收范围保护。


## 2026-09-24 10:33 CST 修复进度

已形成rc.231候选：鉴权时间统一数据库精度；历史记录与导出增加基于原始出品、送达审计和跨日事实的说明；三屏入口单独显示实际设备未配置。363项专项数据库、2140项常规及完整npm run check通过。原失败证据保留，固定SHA CI、正式部署与真实门店设备验收分别记录；本节不覆盖前述审计时的生产事实。
