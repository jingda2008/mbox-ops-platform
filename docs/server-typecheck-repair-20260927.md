# 服务端存量类型错误修复

验证时间：2026-09-27 10:35 CST。工作目录：`mbox-native-staff-app-20260926`。

## 结论与范围

修复前重新执行 `tsc -p tsconfig.server.json --noEmit --incremental false`，复现原48项报错；修复后同一命令退出0、零报错。未修改任何tsconfig、未排除源码或审计脚本、未降低strict/noUncheckedIndexedAccess等检查要求，未添加any或忽略指令。

`tsconfig.server.json`覆盖范围比当前正式服务入口更广。正式构建使用`tsconfig.normalized-server.json`；后者在修复前也通过。因此48项基线错误不能等同于48个营业故障，也不能据此声称正式构建原先失败。

## 修改

- 退款查询向渠道适配器传递原退款的amount/currency，保持原退款号、渠道交易号、商户和密钥上下文。新增断言先失败（缺少两字段），修复后通过；金额取退款金额1200，非原支付3000。
- `prioritizeActionFact`从React页面移动至纯模型，页面保留原导出；审计脚本直接引用模型，避免服务端类型检查导入整个TSX页面。排序和截取逻辑原样保留。
- 补齐NodeNext需要的`.js`模块路径。员工优先级的两项“可能未定义”报错由类型导入失败引起，修正后消失；没有修改优先级或给未知值伪造默认等级。
- 四份120人历史复现脚本补齐数组和幂等键参数类型；金额脚本对必需查询/票据首行增加明确缺失检查，并使用已有票据解析器验证JSON快照。
- 保留主线程已有收银补收、原生App和台账修改；未操作生产数据或修改App功能。

## 验证

| 检查 | 结果 |
|---|---|
| `tsc -p tsconfig.server.json --noEmit --incremental false` | 通过，原48项清零 |
| `tsc -p tsconfig.normalized-server.json --noEmit --incremental false` | 通过 |
| `tsc -p tsconfig.normalized-web.json --incremental false` | 通过 |
| 定向回归：payment-provider、StaffActionsPanel、staff-actions-model、order-payment-allocation、product-display-snapshot、guest-api、guest-model | 7个文件70项通过 |
| payment-provider-action-repository、print-ticket-layout回归 | 2个文件24项通过 |
| 正式服务端编译及Vite生产构建 | 通过；输出到独立临时目录，未覆盖主线程构建目录 |
| 本次变更源码oxlint | 退出0；StaffActionsPanel仍有9条非阻断Fast Refresh/Hook依赖警告 |
| `git diff --check` | 通过 |

构建等价执行正式build的两步：`tsc -p tsconfig.normalized-server.json --incremental false --outDir /tmp/mbox-typecheck-repair-H8feVY/server`和`vite build --outDir /tmp/mbox-typecheck-repair-H8feVY/web`。保留构建提示：混合静态/动态导入、超过500kB分块；它们不是本次类型错误。

## 验收边界

本轮为本地类型修复和相关回归，共94项通过。历史`.repro.ts`脚本以“复现旧缺陷”为断言目的，本轮只验证编译，未连接数据库重新执行它们，也没有把历史缺陷断言当作当前功能验收。未执行完整商业验收、真实资金操作、真机验收、提交推送或部署。

NATIVE-20260927-06的本地类型修复部分完成；其原定正式发布、网页收款兼容及配套版本上线条件仍保留，不能据此关闭整个商业验收项。此前48项错误日志保留为历史证据。

## 后续发布更新（2026-09-27 12:20 CST）

本修复及原生历史补收配套后端已随rc.242上线，完整CI及生产检查通过。上文“未部署”为修复当时的历史状态；最新结果见[生产发布记录](production-release-1.0.0-rc.242.md)。
