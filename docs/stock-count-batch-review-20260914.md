# 盘点批量复核优化

更新时间：2026-09-14 23:48 CST。工作树：`/Users/jingda/mbox/mbox-aftersales-fix-20260914`。基线main `6ca0adb`，目标rc.200。

用户反馈审核只能单个点击。现有盘点审批正确保留库存变化和独立复核限制，问题是缺少批量操作。本次优化减少重复操作，不将库存变化视为可绕过的错误。

## 操作

1. 默认不选中单据；逐项勾选或全选当前页有权复核的单据，显示已选数量。本人单据无选择入口。
2. “选中可通过”选择账面未变化的单据；“选中需重盘”选择已变化旧单。含已变化单据时禁用批量通过，仍可批量退回。
3. 批量通过一次确认所选单数/商品项数；批量退回填写统一原因并一次确认。原单笔按钮继续可用。
4. 每单独立事务处理，逐单展示已通过/已退回/未完成。中途冲突继续处理其他单据，不撤销已成功单据，也不冒充整批成功。
5. 网络丢回执保留原单幂等键，再次操作可恢复；汇总刷新失败不能改写已成功的审批结果。操作中禁止重复点击与改变所选范围。
6. 翻页、刷新、账号或列表变化后清空选择，只处理明确看过的当前页。不会全选后台未加载单据。

## 验证

- 类型检查及仓库oxlint通过；直接误用ESLint没有配置，已改用仓库指定lint命令，不记作业务测试失败。
- 新增三项隔离浏览器场景通过：自审/旧单选择保护、提交时库存变化冲突与其他单成功；统一原因退回、未确认恢复相同请求键；分页刷新选择清空。手机375px页面无横向溢出。
- 原有单项通过/退回/重新盘点与独立复核完整浏览器回归1/1通过（7.8秒）；最终npm run check退出0。
- 后端审批协议、数据库守卫和生产库存数据不作更改。真实岗位批量复核仍需门店执行，不能以模拟或CI代替。

## 交付状态

已提交、合并并上线rc.200，生产完成时间为2026-09-15 00:08:49 CST。

- [PR237](https://github.com/jingda2008/mbox-ops-platform/pull/237)于2026-09-14 23:49:46合并，提交`b4d34ed73c64016e1d5773f90057973b1151f0fa`，标签`v1.0.0-rc.200`。
- [精确标签CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/34864805069)全部通过：质量、数据库/HTTP、完整浏览器、性能、镜像及verify；[发布工作流](https://github.com/jingda2008/mbox-ops-platform/actions/runs/34864804881)成功。本地完整check为1799通过/710条件跳过。
- 独立发布目录`/Users/jingda/mbox/mbox-stock-count-batch-release-20260914`，保留此前release与原工作树；唯一执行入口`./deploy/aliyun/deploy-release.sh`，预检dry_run=verified，最终deployment=complete、退出码0。
- 生产readiness为ready、workers healthy、production、schema203，SHA与标签相同；无新增迁移。镜像摘要`sha256:f3822f0da3466dba2205d58d9667bba101a51a1f27c058d6a51952d02620eeb3`，平台摘要`sha256:30ec056d688ad44378dee53ae14bee99901200d12c5f24f77468a0914210b020`。
- 候选服务健康/深链检查后切换；公网`/`、`/guest?table=W01`、`/reserve`、`/staff/live`的HTTP和浏览器校验全部通过。备份、部署及完成OSS证据均verified=true且EcsRamRole回读一致，release-state为completed。上版rc.199保留回滚容器。
- 数量售后在canonical、release、活动配置、容器环境和runtime解析中均true；支付与服务号配置SHA256指纹前后相同。worker能力保持postar支付/退款。只使用本命令验证过的Node24及保留TLS的公共源站映射，没有改系统DNS或代理。
- 本地专项日志在开发工作树`artifacts/stock-count-batch-20260914/`；生产证据在发布工作树`artifacts/stock-count-batch-release-20260914/`，包含preflight/deploy日志、ready/config回读、OSS验证摘要及完整发布状态。标准清单位于`.runtime/deploy/v1.0.0-rc.200/deployment/deployment-manifest.json`。

使用方式：刷新员工网页，由另一名有盘点审批权限的同事进入“库存 → 盘点复核”，勾选或全选当前页，点击批量通过/批量退回。已变化旧单只能退回；本人单据不可自审。没有代替门店批准、退回或重盘任何真实生产单据，实际两名岗位批量操作仍待现场验收。
