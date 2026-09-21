# 120位顾客审计证据交接

状态：审计完成，系统验收未通过；11项新增问题（6项P1、5项P2）均未在本审计分支修复。按监督任务要求，本次只提交报告、场景矩阵及复现脚本，不启动SIM120修复，不重跑已完成测试，不合并或部署。等待监督任务提供A/B最终集成SHA与复核指令。

## 源码身份与交接范围

- 审计源码基线：`77744bc4e9ed308546b630590bdfa5dfe5ce5b7d`。
- 当次生产只读身份：`5b9d929499b1d8cb0eb3a0c0668604e9a398f1fe`，rc.216；与审计基线仅文档/证据不同。此为原审计时点记录，不是本交接再次查生产。
- 独立分支：`audit/120-guests-20260921`。
- 工作树：`/Users/jingda/mbox/mbox-120-guests-audit-20260921`。
- 本文件所在审计交付提交的40位SHA及逐文件SHA256，提交后记录在Git外的`/Users/jingda/mbox/outputs/120-guests-audit-20260921/handoff/commit-receipt.json`，并在交接回复中提供。交付提交SHA与被审计业务源码SHA必须分别引用。
- 提交只包含本文件、4份报告、1份46行情景矩阵、2个运行脚本及3个审计测试文件；不含商业清单、大日志、密钥、原始生产查询结果或数据库导出。测试中的PIN、令牌签名串和设备标识均为隔离夹具值，不是生产凭据。
- `docs/commercialization-pending-checklist.md`保留未暂存差异，供A统一审阅；不覆盖A版本。原差异另保存于`/Users/jingda/mbox/outputs/120-guests-audit-20260921/handoff/commercialization-checklist.pending.patch`，SHA256为`269a8e054bccda39d809499734c7caf46bada269cdce701ad62f3469303912b1`。此补丁相对上述审计基线，不应直接覆盖并行任务清单。

## 报告和脚本索引

以下路径均在`/Users/jingda/mbox/mbox-120-guests-audit-20260921/`内；原文件内容保持审计完成时快照。本交接未执行功能测试。

场景CSV保留原UTF-8 BOM及CRLF行尾以保持文件摘要一致。默认`git diff --cached --check`将其CRLF报告为行尾空白；按此既有CSV格式使用`git -c core.whitespace=cr-at-eol diff --cached --check`核查，不改动数据或重写历史证据。

| 文件 | 内容摘要 | SHA256 |
|---|---|---|
| `docs/audit-120-guests-20260921.md` | 主报告：1977次HTTP、90/92核对通过、11项新增问题、资金库存核对及现场边界 | `1e55dc04e3ec9f3dce84d8d11d4d191f901b84249c1c69a8eb386defd39a6d1c` |
| `docs/audit-120-money-20260921.md` | SIM120-01—03：退品欠款关桌、补偿后票据、日结待收 | `cba3b1efe16137e15c58341bb6310ce8b1a8bc83ca360b188e859def8918385d` |
| `docs/audit-120-guest-20260921.md` | SIM120-04—07/10：投诉恢复、网页重复服务、账单截断、订单选择、扫码冲突 | `c772216a6f9b01ebb63d0efa778066779a45cfa3438f0e86591c815f678b8490` |
| `docs/audit-120-fulfillment-20260921.md` | SIM120-08—09/11：服务排序、客离投诉权限、收银/KDS死锁及120份食品守恒 | `a9def6df88429536ac04ba4a2b775a8f310877006a5edcf2e3262bacbf39e272` |
| `docs/audit-120-scenario-matrix-20260921.csv` | 46项场景，区分本轮、既有证据和未验项 | `be467f61f5d68f940aeec517ec2ea5bd07e6eeb7f0fdb31112312b507180b2f3` |
| `scripts/audit-120-guests.ts` | 120顾客、30桌、7员工真实HTTP混合模拟与金额/库存断言 | `57b600655abf9bca48ffce04dc1bd7d81fad260ff798c5793678a77c7c1d91b9` |
| `scripts/audit-120-guest-scan-contention.ts` | 同桌/异桌、新建/已建顾客、顺序/并发4组扫码对照 | `ab993a3a1e188264c00a95dec8b3ce439bcc9f4972234d462f6dbceb8cb4330a` |
| `server/normalized/audit-120-money.test.ts` | 4个资金故障/对照用例，含实际关桌与持久票据快照 | `ff0f5955023d68ddb3950124b0a2e9f0fc8340a364e50ddb519ffe061457b0d3` |
| `server/normalized/guest-120-guest-recovery.test.ts` | 3个顾客故障用例，使用真实路由和实际页面模块 | `bcc507655cd4587808e21f1f6d139ff067dfba1450897e2b7cf9fee1b87a2b03` |
| `server/normalized/audit-120-fulfillment.test.ts` | 食品守恒、服务排序、投诉权限和受控双事务锁序复现 | `540069a79c918eae467a27b4dbd14da6ecc2e4374f431c90f30850991374f31b` |

## 原始证据位置

- 总目录：`/Users/jingda/mbox/outputs/120-guests-audit-20260921/`。
- 已核验55个文件的原始清单：`/Users/jingda/mbox/outputs/120-guests-audit-20260921/evidence-manifest.json`；SHA256：`af360454f22ead21340c86020e0c9102356a2afcf11b004785c0f853a67d5f46`。交接只重算文件摘要，55项均匹配，未重新执行测试。
- 最终完整HTTP结果：`/Users/jingda/mbox/outputs/120-guests-audit-20260921/run-final.json`；原轮次为同目录`run-mbox120_http_1789934214879.json`和`http-run-10.log`，保留失败，不能用较早中止轮次替代。
- 混合业务快照：`/Users/jingda/mbox/outputs/120-guests-audit-20260921/snapshot.json`及`before-recovery.json`。
- 原数据库错误证据：`/Users/jingda/mbox/outputs/120-guests-audit-20260921/postgres.log`。
- 生产只读聚合：`/Users/jingda/mbox/outputs/120-guests-audit-20260921/production-readonly.json`；仅在本机保留，不进入Git。
- 出品锁序证据：`/Users/jingda/mbox/mbox-120-guests-audit-20260921/artifacts/audit-120-fulfillment-20260921/cash-kds-deadlock-evidence.json`及`final-with-deadlock-output.txt`。
- 顾客专项：`/Users/jingda/mbox/mbox-120-guests-audit-20260921/artifacts/audit-120-guest-20260921/`中的`scan-contention.json`、`mbox120-guest-recovery.log`、`mbox120-guest-mini-tests.log`。
- 资金专项：`/Users/jingda/mbox/outputs/120-guests-audit-20260921/combined-tests.log`及`money-final-reproductions.log`。

独立实例已停止、专项数据库已删除；不为交接启动数据库。日志包含失败及早期夹具失误；主报告已区分产品缺陷和夹具错误。Git外证据依赖这些本机路径，不应误认为仅获取审计提交就已获得全部原始日志。

## 与A/B的交叉及集成复核要求

A为《检查代码并部署合并》，B为《梳理后台界面与展示逻辑》。本交接不替它们确认完成状态，不提前修复SIM120，不依据候选改动关闭风险。

| 问题组 | 交叉点 | A/B集成后必须共同核对 |
|---|---|---|
| SIM120-01—03与会员奖账SYS-311—313 | 数量退款、部分/多笔付款、服务补偿共同影响有效应收、净收、关桌/日结和奖励冲回；本轮已证分录正确不等于会员奖账正确 | 同一订单原金额、退品重算、付款归属、退款用途、剩余欠款、票据、日结及会员奖励逐项对照；包含40元套餐退品后欠4元、收16退8后欠24元、数量退8再补偿1元；核对禁止自审、退款上限及重收授权 |
| SIM120-04—05/08—09与服务及SYS-318—319 | 请求受理、未知回执恢复、重复任务、投诉优先级、离店后的权限/负责人和顾客确认投影跨前后台与双端 | 限流过后同一意图可恢复且不重复；回执丢失且员工已完成仍恢复原任务；120条任务中紧急投诉可见；无service.manage者翻台不得隐式取消管理投诉；离店后仍有管理处理及读回 |
| SIM120-11与三屏锁路径 | 收银先锁订单后锁桌次，KDS相反；后厨屏、调酒屏、服务取走与收银并发可触发同一等待环 | 统一验证现金收款、两站制作完成、分盘/取走在同桌与跨桌并发的锁序；保留幂等、权限和守恒；不得只增加重试掩盖死锁。遵守用户“取走视为送达”，不增设第二送达确认 |
| SIM120-06—07/10与账单、订单入口和顾客身份 | 分页明细与权威聚合、投诉关联订单、扫码事务范围及重试均可能受集成改动影响 | 30/31/60笔和早期未付恢复记录；最新订单可投诉；同桌/异桌、新/旧身份、渐进到店/120并发分别核对，不把本地失败率外推现场 |

编号固定：出品子报告`F-03`唯一映射`SIM120-11`，不是另一个新增问题。其余映射见各子报告；总数仍为11，不重复计入已有SYS-310—320。

收到监督提供的最终40位集成SHA后，先建立独立复核工作树并确认其准确身份，再按授权重放11项及相关旧问题。当前故障复现测试中部分断言刻意匹配错误行为，修复后应改为正确验收断言；不能把旧故障断言仍通过写成修复通过。原审计文件保留，变更过的复核夹具另行标明与原证据的差异。

主HTTP脚本当前固定本机端口56521/56522、审计源码标记及旧输出目录；专项使用`TEST_NORMALIZED_DATABASE_URL`。未来复核需要在独立隔离实例和新的输出目录运行，先绑定集成SHA并避免覆盖此次证据；不得指向生产或共用其他任务数据库。现在不作这些运行适配，也不重跑。局部测试、最终集成验证、生产回读、真机、真实渠道及实体纸票仍是不同的验收证据。
