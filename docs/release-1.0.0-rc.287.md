# 1.0.0-rc.287 — 转台、预收、跨日核对与收银查询稳定性

承接[rc286](release-1.0.0-rc.286.md)全部功能：转台同步目标桌号及低消、补款可抵商品、员工自填及分次收款、顾客自行下单补足、跨日挂账授权核对、限时商品简洁销售时间。服务费转换仍排除。当前已完成后台部署和微信开发版上传；准确结果见下方最终交付记录。以下候选及失败诊断保留为历史证据。

rc286的PR436已合并，标签与Release成功，但主干CI42489277347两轮分别出现15.69秒、8.61秒收银查询超限，未执行生产切换。准确同源PR与标签测试通过并不能否定该性能问题。原失败日志与不可变rc286资产保留，禁止改写旧标签或跳过主干失败上线。

在独立数据库的5002单夹具中，执行ANALYZE更新订单统计后可重复触发：计划成本升至911775，编译1733个函数，EXPLAIN总执行4933ms，其中JIT编译4905ms，真正执行仅几十毫秒。这里的数字来自隔离诊断，不是生产容量承诺。原始计划在`/Users/jingda/mbox/outputs/cashier-query-plan-fix-20261108/plan-2.json`；诊断夹具包含额外EXPLAIN执行，不能用其整体耗时充当原测试性能结果。

修复仅在收银工作台读取事务内执行`SET LOCAL jit = off`。不修改财务计算、RLS、授权、数据库全局参数或历史迁移。依据PostgreSQL 16官方说明，[短查询的编译成本可能超过收益](https://www.postgresql.org/docs/16/jit-decision.html)，[SET LOCAL在事务提交或回滚后失效](https://www.postgresql.org/docs/16/sql-set.html)。新增真实受限LOGIN检查覆盖设置在提交、回滚后恢复；5002单原测试增加订单统计单独刷新、付款统计随后刷新两种状态，8秒断言保持。

本地专项4项通过。追加相同夹具的EXPLAIN对照：修后5个查询43—91ms、计划执行28—48ms、JIT函数数为0；原8秒门槛的独立专项与诊断脚本分别留档，不混用计时。完整check和准确候选CI结果后续追加。schema仍304，生产基线仍rc285/schema300；上线继续采用标准停写、停写后新备份与OSS验证、迁移及候选零流量检查，再恢复写入。恢复写入后只允许理解schema304的向前修复，禁止旧程序或旧备份覆盖现场新事实。后台部署与只读核验成功后再上传同提交微信开发版；平台提审、正式发布、真机实收与实物出纸分别记录。


## 本地完整检查

`npm run check`完成，包含小程序、类型、lint、常规测试、架构、发布元数据和构建；受限LOGIN专项4项通过。初次检查因rc287经营TC报告未生成而中止，按标准`npm run tc:register`生成新版本计划表后完整重跑通过，未预填任何现场验收通过。证据：`outputs/cashier-query-plan-fix-20261108/check-all-final.log`、`targeted-after.log`、`diagnostic-summary.json`。准确PR、主干、标签CI及部署/上传结果继续独立记录。


## 最终交付：2026-11-09

[PR436](https://github.com/jingda2008/mbox-ops-platform/pull/436)和[PR437](https://github.com/jingda2008/mbox-ops-platform/pull/437)已合并。实际发布为 `v1.0.0-rc.287`，提交 `a4cf3ca547c28e34324016b2f684fefb9c08d0dd`，schema304；rc286从未部署或上传。合并树与审查候选一致。

准确[PR CI42493834989](https://github.com/jingda2008/mbox-ops-platform/actions/runs/42493834989)、[主干CI42496535122](https://github.com/jingda2008/mbox-ops-platform/actions/runs/42496535122)、[标签CI42496555381](https://github.com/jingda2008/mbox-ops-platform/actions/runs/42496555381)和[Release42496555305](https://github.com/jingda2008/mbox-ops-platform/actions/runs/42496555305)全部成功。Linux数据库4415项全部通过，包含受限LOGIN、独立恢复与统计刷新后的查询；HTTP、完整浏览器、质量、5 RPS性能及发布系统检查通过。本地全库4414通过/1条件跳过，Linux已执行该恢复用例，不能将本地跳过误记为通过。8秒收银性能门槛未放宽。

后台部署清单记录00:45:02 CST部署，标准状态机于00:47:27 CST完成。停写时间00:40:38，停写后备份OSS验证00:44:19，迁移00:44:20，新候选深度检查00:44:38，切换验证00:44:57；这些是流程时间点，不作为用户端实际可用性时长测量。停写备份为 `/opt/mbox/backups/mbox-20261108T164041Z-dDGRNz.dump`，OSS的4个备份对象已校验。恢复写入后只允许向前修复；保留旧容器不意味着允许旧程序恢复写入或用旧备份覆盖新事实。

正式首次尝试在激活前停止：准备期间VIP9于00:20:14开台，开放桌次数9→10，与初始快照不一致。只读核实该新增桌次后保留中止日志并重新执行标准流程，未停写、未迁移就中止的第一次尝试没有改动现场桌次。第二次激活前10桌及在途处理复核通过。

部署后的公网Node/真实Chromium回查通过：`/`、`/guest?table=W01`、`/reserve`、`/staff/live`。64项只读比对全部通过：304个迁移校验和、5张新表的RLS与权限、9个触发器、4个函数、生成列与视图、15组业务事实、13组历史事实、历史应收与已关营业日汇总、配置及17个员工账号权限、10个开放/关闭中桌次均符合预期。网站容器及入口配置与部署前一致，未生成生产测试收退款。五张新业务事实表回查时均为0行。

原A16测试单 `order-616c50d53d1ed4c14288fe3c` 只读确认可进入跨日授权核对且核对依据完整；原状态仍cancelled/table_tab，应收0，核对决定0、支付事实0。没有替员工确认欠款或人为收款。实际核对金额及后续收款仍由授权员工按顾客事实操作。

微信官方工具于00:49:53 CST成功上传开发版 `1.0.0-rc.287-ui.1`，AppID `wxdb9f2dc413484f2d`，包1,169,805字节。源码同后台提交，172文件上传前后完整性通过，候选清单SHA256为 `828c05c153198ca547fb9ea8e8168259bad97b5054a680216718088325d529c0`。官方CLI成功日志及大小回执作为上传证据，candidate校验仅证明本地完整性，不冒充平台签署的正式发布证明。未设置体验版、未提审/正式发布；真机转台提示、实际收退款、抵扣及物理打印仍需独立现场验收。

证据目录：`/Users/jingda/mbox/outputs/release-rc287-20261108`，包含main/tag/release-ci-final.json、deploy-dry-run.log、deploy.log、attempt1-before-activation、session-change-investigation.json、release-state.json、oss-backup-verification.json、production-deployment/deployment/deployment-manifest.json、postflight-comparison.json、a16-after-deploy.json、wechat-upload-record.json、wechat-upload.log、wechat-upload-info.json及verify-after-upload.json。实际镜像摘要 `sha256:c055b9985669618ea7d1ce67a6ed02351822b7e8aa505b41db2a67a271d6b2b5`，linux/amd64摘要 `sha256:677672f6e1c9df196190c0cc85ae8d1cd2eefe261b833ad9ed2dc972cd20b750`。

官方工具另生成临时预览码 `outputs/release-rc287-20261108/wechat-preview-qr.png`；预览后172文件完整性仍通过，证据为wechat-preview.log、wechat-preview-info.json及verify-after-preview.json。预览码受微信开发者权限及有效期限制，不等同于设置体验版。
