# 经营费用与存酒报表旧回执授权修复

时间：2026-11-02 14:06 CST。基线：PR415 的 `16e602eec07e167e9b278ce53bdb4828f9f5486c`。只在本机一次性数据库验证，不连接生产，不部署、不合并，不修改现场桌台、订单、资金或存酒事实。

## 本轮已修复候选

### RULE-AUDIT-20261102-04：费用登记及更正

`commercial-ops-api.ts` 的费用登记、更正原先只在首次写入 handler 校验权限，命中旧回执后跳过。现在在 claim/读取回执前检查：

- `commercial.cost.manage`；
- 请求来源为 payroll **或** 分类为 personnel 时的 `commercial.payroll.manage`；
- 来源为 inventory_purchase **或** 分类为 beverage_purchase 时的 `inventory.receive`；
- 更正时再检查原费用不可变记录的来源和分类，防止把工资/采购改成租金后绕过原记录权限。

原费用历史保持追加式记录，重试不重新执行“已经更正”业务判断，恢复权限后仍得到原更正结果，不重复记账、审计或 outbox。普通租金不附加工资/采购权限，也不新增原业务未要求的费用查看权限。

### RULE-AUDIT-20261102-05：存酒可选范围报表

普通与原生 `report-export` 均在读取回执前检查导出权 `bottle.custody.export`、全量存酒权 `bottle.manage.all`；仅当实际范围为 sales/all 时，再检查 `order.history.all`。默认/显式 custody 及旧存酒明细导出不错误要求消费订单权限。

授权失败在 claim 前返回403；原生新请求原来由 handler 包装成409/未提交，本次改为明确403并更新对应回归。没有用“未提交”标记掩盖已存在的原回执。更换同键请求的范围不能获取旧工作簿，指纹冲突仍拒绝。

原生采用原有 `retainReceipt`、`expires_at=infinity` 长期幂等记录，**不是**菜单/库存的独立审计回执协议。因此验证保留90天前的记录仍重新授权，不以删除其唯一回执来模拟缓存到期。命名空间、指纹算法、回执结构和schema均未改变。

代码复核另处理两点：上下文重查移出持有连接的命令事务，避免同一单连接池嵌套查询；报表动作使用统一 write 上下文的员工身份，不再捕获另一份提前解析的身份。存酒跨门店无效员工映射401，停用/撤权403，不再泄露为500。

## 回归与证据

新增 `finance-custody-replay-authorization.integration.test.ts`：36项真实受限 PostgreSQL LOGIN、实际 Fastify 路由/命令执行器/权限仓库用例。最终测试在旧业务代码27失败/9通过；修后36项通过。初版探针曾有范围变量遮蔽、费用分类编码大小写的夹具错误，均修正后重跑，不计作产品根因。

覆盖登记和更正；工资/采购分别按来源与分类触发；更正前后来源组合；普通费用最小权限；普通/原生三类报表、默认范围和旧导出；撤权的新旧键、恢复后原结果；长期回执；修改同键范围；换账号、跨门店、员工停用；单连接池和解析期间身份变化。报表使用本地临时库的一条合成订单，验证工作簿确有一条数据；合成桌台、桌次和订单与现场完全隔离。验证失败/恢复不增加费用、订单、审计或 outbox 数量。

商业API单元执行器替身补执行 beforeClaim，匹配真实执行器合同。既有原生存酒无订单查看权断言从409改为403；没有放宽权限断言。

证据目录：`/Users/jingda/mbox/outputs/finance-custody-replay-fix-20261102/`。

- `before-final.log`：旧码反证（27失败/9通过）；`focused-final.log`：最终36项专项。
- `unit.log`：既有商业API单元测试；`check-final.log`、`postgres.log`：完整本机回归。
- 最终准确SHA的CI、数据库/HTTP/浏览器/性能结果及作者代码审查，以PR415最终记录为准。作者复核不等于独立外部批准，生产验收保持开放。

## 追加发现，尚未修复

| 编号 | 证据等级与范围 | 下一修复的关闭条件 |
|---|---|---|
| RULE-AUDIT-20261102-06 | P2；真实受限LOGIN复现：owner-finance 的费用分类创建首次201，撤销commercial.cost.manage后同键200/replayed=true、新键403。代码检查发现共用commandReply的普通入口未设置beforeClaim；周期费用及工资配置还需逐项核对附加来源权限和历史版本。尚未证明所有这些入口都可利用。 | 当前基础权限与请求/原记录附加权限分别覆盖；保留周期费用版本、更正、工资审批和双人规则；缓存/原生长期回执、恢复授权及不重复生成费用验证。 |
| RULE-AUDIT-20261102-07 | P2；真实受限LOGIN复现：销售提成规则首次201，撤销commercial.sales.rule.manage后同键200/replayed=true、新键403。销售归属及退款冲销入口有相似代码形态，尚未逐条动态确认。 | 普通/原生相关入口按各自权限与对象范围验证，保留规则有效期/重叠约束、历史销售事实和退款冲销幂等性。 |

新增失败探针保存在 `additional-probe.test.ts.txt`、`additional-probe-final.log`、`additional-probe-runner.mjs` 和 `probe.config.mjs`，没有将错误响应写成通过测试。复现时复制为 `server/normalized/finance-adjacent-audit.probe.ts`，用保存的独立配置运行器及本机 `TEST_NORMALIZED_ADMIN_URL` 运行，结束移出。`.probe.ts` 不属于日常测试集；运行器拒绝非回环数据库并创建、清理独立临时库及LOGIN。预期两项失败，不能据此关闭06/07。

现金交接在进入命令执行器前读取当前权限；平台券核销在读取原操作前检查当前核销权。本轮仅静态核查这些保护，不代表完整退款/现金/渠道验收，也不是全系统无缺陷证明。未向任何支付平台提交请求，未发送短信、通知或打印。
