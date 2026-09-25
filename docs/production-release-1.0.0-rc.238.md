# rc.238 完整桌号搜索正式发布

2026-09-26 01:26:46 CST标准发布完成，公网HTTP与浏览器验证通过；01:31:04 CST完成全部68个目标桌号的生产只读查询复查。生产ready、writeEnabled=true，schema248，无新增迁移。

| 项目 | 已验证结果 |
|---|---|
| 发布提交 | `e34adcde6c8afbab5571f1207523dbddc42214e9`；PR [#307](https://github.com/jingda2008/mbox-ops-platform/pull/307) |
| 版本及镜像 | `v1.0.0-rc.238`；`mbox-normalized:1.0.0-rc.238-e34adcd` |
| 镜像摘要 | `sha256:4afbabc6019612d20b90c4d4461bf90870e143083d2671dd0f4767ec79d4980f` |
| 平台镜像摘要 | `sha256:78512dfe5394688d67c7f2dbe4aaab4409aba77ca9e5ebca86a266cbe4aff334` |
| PR CI | [36162792081](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36162792081)，success；首轮36162329724因旧placeholder断言失败，修正测试预期后重跑，失败记录保留 |
| 标签 CI / 发布 | [36164798418](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36164798418) / [36164798646](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36164798646)，均success |
| 标签验证 | 数据库2755项、浏览器主流程107项和三屏专项17项通过；浏览器28项条件跳过，不计入通过数。常规单测2196项通过，另1138项条件跳过；专项数据库作业独立执行 |
| 备份 | `/opt/mbox/backups/mbox-20260925T172426Z-g2rfgr.dump`，OSS上传及读回已验证 |
| 回退保留 | `mbox-app-rollback-e34adcd-20260926-012613`，上一健康版本rc.237，schema不变，application_image回退模式 |
| 标准发布 | 独立工作区执行 `./deploy/aliyun/deploy-release.sh`；候选、备份、OSS发布与完成证据、公网HTTP及浏览器均通过 |

## 实际搜索结果

生产部署代码的`readOperatingHistory`以门店运行时权限、只读事务执行，营业日为2026-09-25（06:00换日），包含导出全量结果。68个目标桌号逐一用小写编号查询：39个有订单，均只返回本桌；29个无订单，均返回空结果；未发现其他桌混入。空结果不代表验证过该桌的实际有单场景，完整场景由隔离数据库及浏览器回归补充。

| 查询 | 上线后结果 |
|---|---|
| a5 / A05 | 1单，仅A5 |
| w1 / W01 | 3单，仅W1 |
| B1 | 8单，仅B1 |
| C1 | 2单，仅C1 |
| A5导出 | 1单，仅A5；同一订单按完整订单号查询仍可找回 |

与发布前快照比较，94个桌台的ID、编号和状态完全一致。本次没有移动桌次或改写订单、账目、二维码。旧规则下38个桌号会命中其他桌的订单编号片段，这是查询污染，不能说成38张桌错绑或错账。修复范围见[全入口记录](order-center-table-search-20260926.md)。

## 三屏和现场边界

后厨批次、三屏、数量售后开关均true。复核选取的既有后厨会话登录和设备授权仍有效，但在线租约于01:09:28 CST到期，早于01:26切换；01:28复核时canPrepare/canStart/actionSessionValid及旧入口授权均false，待制作/批次均0。口令轮换记录在01:25更新，rc.236保留的既有会话兼容规则继续存在；未伪造在线心跳或制作操作。

SYS-387代码发布和生产查询复核完成，门店终端刷新后的实际操作验收继续开放。SYS-385物理桌牌/二维码对应、SYS-384实机制作验收分别保留，不以本次查询验证替代。部署范围为员工网页、服务端及数据库，不包含微信小程序上传。

私有证据保存在`outputs/table-order-mapping-20260926/`：deploy-rc238.log、after-release-ready.json、deployed-verification.json、deployed-all-tables.json、after-release-kitchen-flags.json、after-release-kitchen-session-timing.json及PR/标签CI日志；包含业务数据的原始文件不提交Git。
