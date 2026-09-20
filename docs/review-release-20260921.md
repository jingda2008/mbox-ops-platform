# 2026-09-21 代码审查与rc.216交付

授权范围：检查代码、提交、合并、部署。来源：`mbox-kitchen-batch-board-20260920`，基线 `5c4bde7de5ed154ab3dd9227a64751dcc65293eb`。139个改动文件经过SHA-256核对后复制到独立 `mbox-review-release-20260921`，不覆盖原工作区。

## 审查发现

**SYS-307 / P1：直接备齐误选旧流程在制份数。** 同一个原品项5份中，旧流程已开做2份，新工作台选择另外2份直接备齐，通用完成逻辑优先选择已开做份数，导致旧2份变为备齐，新选择的库存未被正确消耗。

修复在已取得原订单锁的事务内明确选择未制作、未暂停、未停止、未重做、未绑定其他批次的原份数，再调用既有精确完成接口。新增真实PostgreSQL用例先失败（旧份数变为ready），修后要求旧2份仍started、新2份ready、最后1份unmade，库存从10减至6且重放不再扣减。

## 验证记录

- 来源候选的完整常规检查在本轮再次通过；最终修复和版本元数据的检查另行补记。
- 新增回归修复前：后厨专项8通过、1失败，失败与上述错误一致。
- 最终数据库、浏览器、PR及标签CI、部署结果以本记录后续交付条目为准。
- 本地原始日志保存在 `/Users/jingda/mbox/outputs/review-release-20260921`；不将隔离数据与实际门店交易混写。

未完成真实平板触摸、设备产能、实物交接、渠道资金或实体票据的本轮验收。原清单负责人和完成条件保留。


## 2026-09-21 01:02 CST 最终本地验证

| 层次 | 结果 | 边界 |
|---|---|---|
| npm run check | 1967通过、767条件跳过；类型、lint、构建、架构、双端小程序契约和元数据通过 | 数据库场景另跑；保持既有构建体积警告 |
| 完整隔离PostgreSQL | 2330通过、1条件跳过，275文件通过 | 包含9项后厨事务用例及SYS-307先失败后通过；备份恢复容器专项仍按原条件跳过 |
| 相关浏览器 | 17通过；初轮2项缺专用数据跳过，开启专用数据后2项通过，共19种场景 | 取送刷新10项、后厨3项、打印2项、叠加2项、存酒弹窗2项；隔离数据库 |
| 配置与发布 | 32项配置解析、1项模板生成、配置保留、发布状态及16项发布策略通过 | macOS缺少flock，Linux发布锁专项另在postgres:16容器验证 |
| 发布操作机浏览器 | 当前rc.214的4个公开路由全部通过 | 已安装本工作区依赖，并核对旧版本完整SHA |
| 文档证据检查 | 文本未检出敏感内容；3张图片逐张查看为隔离测试截图 | 图片不适用文本证据扫描；不是生产用户数据 |

提交、PR及标签CI和生产发布将在通过各阶段后另记，不以本地通过代替。


## 2026-09-21 01:19 CST PR完整浏览器暴露的第二项缺陷

CI `35524662266` 的质量、数据库/HTTP和性能通过，浏览器90通过、16条件跳过、4失败，均对应盘点复核出现两个同名面板。本地3项批量盘点也复现失败。根因为新损耗复核面板和盘点复核面板是同级节点却使用同一个员工ID作为React key，刷新后产生重复组件。

SYS-308修复为不同业务前缀的员工key，并在既有批量流程加入进入/刷新后面板数量恰好为1的断言。保留不自批、过期盘点拒绝、部分失败继续、重试原凭据与跨页清除选择的全部断言；不使用first定位或增加超时。修后复测和新提交完整CI结果后补。源码和SQL未因该修复修改库存审核权限。

2026-09-21 01:20 CST：修后原4项浏览器用例全部通过，进入和刷新后面板唯一；网页类型、专项lint和清单检查通过。仅修改前端组件标识和浏览器断言，后端与SQL不变。提交后重新执行完整PR检查。

## 2026-09-21 01:36 CST 合并与正式发布准备

- [PR270](https://github.com/jingda2008/mbox-ops-platform/pull/270) 已合并，最后分支提交 `99222de26e179d22615fc8c4245af4fcd606acf0`，主线合并提交 `462577dc32e0b5fd4aa7647f28b024c94c0555bc`；两者文件树比较无差异。
- [最终PR检查35525589287](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35525589287) 全部必需检查通过。Linux数据库为2331项通过（包含本地按条件跳过的专项），浏览器94通过、16条件跳过；质量、HTTP及持续5 RPS性能检查通过。该负载不等同于真实门店混合峰值验收。
- 标签 `v1.0.0-rc.215` 指向完整合并提交，正式发布工作区 `mbox-release-rc215-20260921` 为该提交的干净detached worktree；`npm ci`和发布元数据检查通过，依赖审计未发现漏洞。
- 正式发布工作区的Chromium依赖检查通过，对当时线上rc.214完整SHA的 `/`、`/guest?table=W01`、`/reserve`、`/staff/live` 浏览器预检通过。
- [标签CI35526277171](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35526277171) 与 [发布工作流35526277213](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35526277213) 的结果、不可变镜像身份及实际生产验证另记于下文。

## 2026-09-21 01:42 CST rc.215标签失败及rc.216修复

标签数据库检查在 `kitchen-production.test.ts:40` 的会话数据初始化失败，约束名 `staff_sessions_check`。迁移009要求 `expires_at = issued_at + interval '6 hours'`，但测试对两者分别调用 `clock_timestamp()`，微秒差会导致失败。该次2322项通过、后厨9项因初始化失败跳过；预期的备份恢复反例日志并非本次失败根因。

SYS-309改用 `statement_timestamp()`，在同一语句中保持时间一致，不放宽约束、不删除测试或重跑掩盖原始失败。生产 `StaffSessionRepository.createSession` 使用传入的时间参数，此次不修改生产代码和SQL。rc.215发布流程取消，标签保留且未部署；重新准备rc.216元数据与完整检查。原始失败日志保存在本轮输出目录的 `tag-ci-database-attempt1.log`。

2026-09-21 01:44 CST：rc.216修后新建隔离数据库的9项后厨真实事务全部通过（4.37秒），元数据、清单、专项lint和diff检查通过。完整PR与新标签检查继续执行。

## 2026-09-21 01:59 CST rc.216合并与发布准备

[PR271](https://github.com/jingda2008/mbox-ops-platform/pull/271) 已合并为 `5b9d929499b1d8cb0eb3a0c0668604e9a398f1fe`，与最后分支提交 `a654888ead3c2189dce1b4d44a511f81f0f40bd6` 文件树一致。[PR完整检查35526838367](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35526838367) 全部必需门禁通过，数据库2331项通过，浏览器94项通过、16条件跳过，HTTP、质量及性能检查通过。

`v1.0.0-rc.216` 标签已指向最终合并提交；新建干净的正式发布工作区 `mbox-release-rc216-20260921`，重新执行npm ci、浏览器依赖、版本元数据及当时线上rc.214完整SHA的4路由浏览器预检，全部通过。[标签CI35527526985](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35527526985) 与 [发布工作流35527526954](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35527526954) 正在运行；此时生产尚未切换。

## 2026-09-21 02:19 CST rc.216生产交付完成

[最终标签CI35527526985](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35527526985) 和 [发布工作流35527526954](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35527526954) 均成功。标签数据库2331项通过，浏览器94项通过、16条件跳过，质量、HTTP和持续5 RPS性能检查通过。[发布版本](https://github.com/jingda2008/mbox-ops-platform/releases/tag/v1.0.0-rc.216) 为已发布RC。

| 核验项 | 实际结果 |
|---|---|
| 最终提交 | `5b9d929499b1d8cb0eb3a0c0668604e9a398f1fe` |
| 生产切换时间 | 2026-09-21 02:16:04 CST |
| 镜像 | `mbox-normalized:1.0.0-rc.216-5b9d929` |
| 镜像摘要 | `sha256:66c0cbce9543dca4f25487058af16fc2274ec80485c3c2270e8c4e5ee8e050ad` |
| 平台镜像ID | `sha256:7c7826a20f38069786fea6a71a847e785760b7a62005cabdd68b30a176b733ec` |
| 数据库与环境 | schema 224、production、严格库存、normal可写 |
| 当前健康 | readiness ready；容器healthy、0重启；后台任务healthy、失败列表为空 |
| 浏览器 | /、/guest?table=W01、/reserve、/staff/live全部通过 |
| 后厨开关 | canonical配置、发布配置、容器环境、解析后运行时均为true；原数量售后开关仍为true |
| 认证边界 | 未登录GET后厨工作台返回401 AUTH_REQUIRED，无生产业务写入 |
| 发布状态 | completed；包含备份验证、迁移、候选健康、切换验证、evidence_archived完整状态历史 |
| OSS回读 | 上线前证据24对象、镜像4、备份4、部署8、完成3全部verified |
| 数据库备份 | `/opt/mbox/backups/mbox-20260920T181427Z-zrewTr.dump` |
| 回退 | `mbox-app-rollback-5b9d929-20260921-021602`，旧SHA `887461043e521463f73b9bd17efa381e4eeea6ad`及平台镜像ID均匹配 |
| 原工作区 | 139文件重新逐一SHA-256核对，无改动 |

部署仅使用最终合并提交的 `deploy/aliyun/deploy-release.sh`。配置变更前已在服务器以受限权限备份，只新增后厨开关，其余配置内容哈希一致；发布成功后再次核对所有配置层。源码标签工作区保持干净。

精选证据见 [发布身份](quality/evidence/rc216-production-20260921/release-identity.json)、[线上健康](quality/evidence/rc216-production-20260921/public-ready.json)、[运行时与OSS](quality/evidence/rc216-production-20260921/runtime-and-oss-verification.txt)、[CI结果](quality/evidence/rc216-production-20260921/ci-results.json)、[浏览器结果](quality/evidence/rc216-production-20260921/public-browser-verification.json)。原始操作日志保存在本轮本地输出目录，不把含员工配置明细的原始部署日志复制入代码库。

SYS-307和SYS-308已修复并部署，门店混合流程和库存岗位验收仍开放；SYS-309已通过最终完整标签检查。未执行真实收退款、库存损耗、制作或消息发送作为验证；未上传小程序或安装Windows PrintBridge。真实平板、设备产能、实物交接、渠道资金及实体票据仍需按原清单验收。
