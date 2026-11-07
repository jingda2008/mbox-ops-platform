# M-BOX 1.0.0-rc.283 跨营业日补收发布候选（未部署，由rc284替代）

用户已授权代码审查、PR、完整CI、合并和部署，允许必要schema及权限变更；禁止改写既有订单、付款、退款、日结或历史欠款。

## 审查重点与证据

普通订单继续委托迁移前的应收计算；现有退款重收义务与授权保持。新欠款仅在未来有明确门店作用域的关桌事务中记录，不补建历史事实。退款投影使用独立退款凭据，不依赖原收银员继续拥有补收权限。原营业日消费金额与实际收款日分开，补收不重复出品、库存或积分。

本地完整check、4392项数据库及独立Docker恢复1项、161项基础浏览器及46项条件场景、2400个HTTP请求均通过。详见[cross-day本地报告](cross-day-debt-local-20261107.md)。这些是本地结果，不替代准确PR/主线/标签CI及真实支付验收。

## 部署与数据边界

schema300新表、函数、触发器、RLS以及权限定义/分配属于本次必要结构配置变更，门店配置升级v30。迁移没有订单/付款/退款/日结回填，历史477条核对候选继续只读。不得以关闭现场桌次、作废付款或修改业务事实来通过发布门禁。

旧应用不保证兼容新欠款事实；必须核验标准迁移兼容门禁，必要时通过标准维护流程停旧写入方后升级。不得以旧rc282镜像盲目回退，不能删除资金流水或用旧备份覆盖营业数据。

发布仅使用deploy/aliyun/deploy-release.sh及准确主线提交的不可变镜像；备份、OSS、迁移预检、候选与正式入口、前后只读业务摘要均需本次证据。当前PR/CI/合并/部署尚未完成；结果取得后追加，不预先宣称上线。

## 合并与准确 PR 验证

[PR431](https://github.com/jingda2008/mbox-ops-platform/pull/431) 的准确 head `d3560b73e514325b0eca3687b0e7e914490030a2` 已通过[完整 CI42369331616](https://github.com/jingda2008/mbox-ops-platform/actions/runs/42369331616)：4393 项 PostgreSQL 测试零跳过，161 项基础浏览器及46项条件场景全部补齐，另7项扩展，quality（含 Linux 发布锁/状态检查）、HTTP、performance 与 verify 全部通过。作者 [COMMENT 复核](https://github.com/jingda2008/mbox-ops-platform/pull/431#pullrequestreview-5812003829) 已完成，不代表独立外部批准；无未解决审查线程。

北京时间20:09:28合并为 `59af378be398b54c0f1840d4dfd1996f791dfea0`，合并树与已测试 head 完全一致。标签 `v1.0.0-rc.283` 锁定同一提交；主线 CI42371223494、标签 CI42371240631 及 Release42371240648 继续验证，当前尚未部署。

rc283 最终本地完整 check 串行复验退出0，保留此前短时 mock 吞吐断言失败日志，未放宽门禁。macOS 缺少 flock 的发布锁测试由本次 Linux CI 通过。生产只读配置对照310项无差异；已保存77个已关闭营业日汇总和3992张历史订单应收摘要，部署前仍须重新取样。查询时存在3个开放桌次；不得关桌或更改经营事实来满足部署条件。

### 标签首轮超时与有限重验

主线 CI42371223494 首轮完整成功。标签 CI42371240631 首轮数据库4393项全部通过，但整项任务耗时达到25分钟，后续HTTP验收尚未完成即被平台取消；最终verify失败、镜像构建跳过，不能视为标签通过。GitHub annotation明确为 `The job has exceeded the maximum execution time of 25m0s`。同一套数据库测试在PR、主线、标签轮分别耗时783.78、1032.23、1237.45秒，变换/导入及专项耗时也同比增长；这是执行速度差异的证据，不能据此确定基础设施根因。

保留首轮日志、annotations和CI快照，对原标签同SHA的受影响数据库任务及依赖门禁发起一次重验；不改测试、阈值或timeout，不以主线成功代替标签HTTP结果。发布仍等待完整标签成功。证据：`/Users/jingda/mbox/outputs/release-rc283-20261107/tag-ci-attempt1.json`、`tag-database-attempt1-annotations.json`、`tag-database.log`。

## 最终候选结局

标签第二次数据库4393项仍全部通过（套件1223.14秒），后续HTTP再次被25分钟总上限取消，GitHub annotations与首轮相同。没有第三次盲重跑；已停止rc283 Release等待，保留标签及两轮失败证据。rc283未部署，生产仍rc282/schema299。

时间预算修正进入[PR432](https://github.com/jingda2008/mbox-ops-platform/pull/432)，准确head cbf0ac0126fe9f5aeb5daa01d5a3a860d4a46189完整CI42375149160成功，于北京时间21:34:02合并25e4d94a83d7edde5a1886ce7a01f83e7942a7ae。后续发布使用[rc284](release-1.0.0-rc.284.md)，不覆盖rc283标签。用户已明确部署时间为2026-11-08 00:30 Asia/Shanghai，此前仅准备。
