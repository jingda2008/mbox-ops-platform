# rc259 桌次主服务员与全员服务历史生产发布记录

状态：2026-10-18 20:43 CST标准后台发布完成，20:46 CST公网业务验收通过。范围为后台、员工 Web、schema270；原生安装包、小程序发布、真实现场服务及共享取餐屏登录另验。

## 版本、复审与门禁

| 项目 | 核实结果 |
|---|---|
| 不可变标签 / 提交 | `v1.0.0-rc.259` / `ea948926f18b293c4146fc93c8e5a8fd2e3c7c72` |
| 镜像摘要 | `sha256:6e5fc41b6a1c4c498b63b7c2f5b4a75290f4a80fff1a705848f1009aa4102774` |
| 平台镜像摘要 | `sha256:22e73c06b7d2123431561b4d599a84be38c65d265853cf6f3b9081cc3adc6199` |
| 功能与修复 | [PR371](https://github.com/jingda2008/mbox-ops-platform/pull/371)、[PR372](https://github.com/jingda2008/mbox-ops-platform/pull/372)已合并；rc258未部署且未移动标签 |
| PR372 CI | [39124518900](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39124518900)，通过 |
| 最终主线 CI | [39125825025](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39125825025)，第二次通过；首次失败原因见下文 |
| 标签 CI / Release | [39125861596](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39125861596) / [39125861569](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39125861569)，均通过 |
| 数据库 | schema269→270，`migrationChanged=true` |
| 备份 | `/opt/mbox/backups/mbox-20261018T124004Z-oIOQa6.dump`，OSS上传并读回验证 |
| 回滚保留 | rc257，`mbox-app-rollback-ea94892-20261018-204210`，application_image模式 |

复审确实发现遗漏，均有修前失败和修后证据：旧浏览器与压力脚本未指定负责人、手机账号按钮被挤到35px、权限提示遮住通用入口、首次加载工作台导致服务弹窗关闭。最后一项由PR371重试日志发现，因此阻断rc258，改为会话层持有弹窗并新增受控慢加载回归，不用重试掩盖产品问题。

最终发布数据库3321项通过；主要浏览器138项通过/42条件跳过，三屏18、会员10、服务历史4项通过，服务历史均首次通过。常规检查2559项通过/1515环境跳过，数据库用例另由独立全库门禁覆盖。此前压力四段各60秒/5RPS共2400次请求成功。各组有交叉，不相加为独立用例总数。

主线第一次数据库任务3320通过/1失败，是旧扫码测试依赖前序计数仍处于同一分钟窗口；受控到期可稳定复现，生产到期重置符合原合同。原发布提交再次全量通过。只修改测试的[PR373](https://github.com/jingda2008/mbox-ops-platform/pull/373)已合并为`4855f9cae76034cecb85d2e485ba9652a7cd9559`，[独立CI39127232426](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39127232426)通过；测试明确建立窗口、10次允许、第11次拒绝和到期双计数器重置。没有修改生产限流策略或移动发布标签。保留首次失败、受控复现、夹具约束失败及最终成功日志。

## 标准发布与保全

- 唯一入口`deploy/aliyun/deploy-release.sh`退出0，`deployment=complete`；操作工作树重新安装依赖并在切换前通过真实浏览器预检。
- 发布包、镜像、数据库备份、部署和完成证据均OSS上传并读回验证；发布状态`completed`，完成时间20:43:05 CST。候选健康、深层入口、切换前后身份与配置门禁均通过。
- 公网`/api/ready`为ready、production、schema270，SHA及镜像摘要与上表一致；容器healthy，worker健康且无失败。原有integrationWorkersEnabled=false及不可用适配器列表与发布前一致，不把本轮验收当作打印、推送或资金设备验收。
- `/`、`/guest?table=W01`、`/reserve`、`/staff/live`的HTTP及真实Chromium浏览器检查均通过，TLS验证保持启用。
- 15项关键表指纹与紧邻部署前快照完全相同，涵盖商品、套餐、预约、角色权限、会员规则与积分数据；Caddy完整配置SHA256仍为`44bcf655dbe8b772c7aa7ddea03cb455ee7f9d34d7c4b9c8d64f7ad75d7368b4`，公共官网路由保留。

## 逐项公网业务验收

使用明确标记为非营业的QA259，主服务员Tom、店长李艳操作开台，然后交接Jerry；创建并完成一条标记验收用途的服务任务。没有创建消费订单或实际收退款。

| 场景 | 真实验证结果 |
|---|---|
| 开台缺少负责人 | 页面按钮禁用；后台409；没有生成桌次或负责人历史 |
| 明确负责人开台 | 页面选Tom、201成功；开台人李艳与主服务员Tom独立显示 |
| 交接与重复请求 | 页面交给Jerry并保存原因；原幂等键/原请求重放`replayed=true`；版本1、合计2条负责人记录，无重复交接 |
| 实际服务 | 创建并完成服务任务；事件显示真实执行账号，页面和接口均可见 |
| 全体可登录个人账号 | 下列14账号全部真实登录200、会话200，并在手机宽度浏览器查看当前Jerry、交接原因和服务完成记录 |
| 读取与修改分权 | 无交接权限账号不显示确认按钮，实际修改请求403；未登录读取401 |
| 结台后历史 | 结台后14账号再次逐个在页面和接口查看最后主服务员Jerry、2条负责人变化和实际服务；已结台交接409 |
| 清理 | QA259已closed并retired；数据库只读复核订单数0、服务变化2；无cleanupError或logoutError，验收会话均退出，临时私有会话文件删除 |

14账号：ajin、chenfangyu、fengtaofeng、fuchunyu、hugu、jerry、lengyanzhi、liyan、sanmu、shenliangliang、tata、tom、tyke、wuya。操作人使用账号身份完成测试，不据此认定14名本人均在现场操作。

测试桌次`f97dbb81-2ded-4639-a1a5-99bf385f0b7f`；服务任务`4555d95e-e5ee-4c86-9c8d-daaecd032d6b`。浏览器与接口均以该原始桌次验收，没有失败后另造重复桌次。

## 营业桌与保留项

用户明确确认后，通过正常授权交接接口并校验原桌次、当前状态和版本：G1、W2现在确认为李艳，C7现在确认为Jerry。记录来源和本次确认时间，原负责人空缺仍标明此前未知，未倒填开台时的负责人，也未改订单或全局责任排班。

| 桌台 | 原桌次ID | 本轮处理 |
|---|---|---|
| G1 | `8f923b4f-51bd-439e-999d-5ae48502df83` | 当前李艳，已回读 |
| W2 | `086be0f0-4ae0-4a3e-9352-3556d81ac38b` | 当前李艳，已回读 |
| C7 | `26302aa9-6486-41e7-baa4-02d11184ebaa` | 当前Jerry，已回读 |

发布等待期间旧版又开了G2、B3、A9、VIP5，分别由三沐、李艳、Jerry、Jerry开台；旧版未保存主服务员。已单独向用户请求这四桌当前人员确认，未将针对W2/C7的回复推断为所有桌台的历史事实。确认前页面保留待确认，未擅自补填。新增开台已执行负责人必填约束。

qucan用户不记得PIN，真实登录/浏览器验收未完成。生产有效角色仍PICKUP_SCREEN、操作权限仅kds.deliver、启用取餐设备1；没有重置PIN或扩权。通过受限门店只读事务验证其服务目录、已结台QA259、2条负责人变化和2条实际服务事件可读取，这一层不能冒充账号真实登录。共享设备只证明授权账号，不能确认现场具体取餐者。

旧客户端未传负责人时，仅使用唯一有效主责任安排，否则拒绝开台；应使用新版员工Web显式选人或先完成有效主责任安排。现场人员操作、旧原生包界面、小程序及真实取送/打印/资金流程仍保留各自验收边界。

## 原始证据

私有证据目录：`/Users/jingda/mbox/outputs/rc258-service-history-20261018/`。沿用前候选目录名，最终版本以SHA和manifest为准。

- `deploy-rc259.log`、`production-deployment/`、`ready-after.json`、`container-after.txt`。
- `production-business-verification.json`、`production-auth-capture-summary.json`、`qa-final-readback.json`、`production-manager-handover.png`和`production-reader-*.png`。
- `qucan-access-before.json`、`qucan-access-after.json`、`unconfirmed-after-deployment.json`。
- `fingerprints-pre-activate.json`、`fingerprints-after.json`、`caddy-config-pre-activate.sha256`、`caddy-config-after.sha256`。
- `main259-database-first.log`、`main259-ci-complete.log`、`tag259-browser-ci.log`、`pr373-ci-complete.log`、`scan-window-expiry-repro-targeted.log`、`scan-window-fixed.log`。

凭据与会话令牌不进入文档或Git；原失败记录保留。此记录说明本轮软件发布及限定线上验收结果，不宣称所有商业清单或现场验收全部关闭。


## 2026-10-18 21:01 CST 四桌当前主服务员确认完成

用户随后明确回复“四桌都按开台账号确认”。通过正常生产登录和授权交接接口操作，先读取原桌次、确认仍open且负责人空缺、核对开台账号及当前版本，再逐桌补确认并回读。四桌均成功，无并发覆盖：

| 桌台 | 本次确认的当前主服务员 | 原桌次 | 回读结果 |
|---|---|---|---|
| G2 | 三沐（sanmu） | `8aad0d67-e5d6-46b6-9ad3-a728da167628` | open、revision1，确认原因与原请求一致 |
| B3 | 李艳（liyan） | `5c19e86e-fc04-4270-bf72-b2e17caf02c0` | open、revision1，确认原因与原请求一致 |
| A9 | Jerry（jerry） | `801514cf-f677-40b3-9105-5f2ded639580` | open、revision1，确认原因与原请求一致 |
| VIP5 | Jerry（jerry） | `38e6e4b1-d47a-4c89-8876-0e2a193e6fc0` | open、revision1，确认原因与原请求一致 |

核验时间2026-10-18 21:00:51 CST，门店当前活动桌次缺少主服务员为0。每条记录保留此前未知、用户本次明确确认的来源、实际写入时间及操作账号；没有倒填开台时历史，没有更改消费订单或全局排班。操作会话已退出204。原始回执为`outputs/rc258-service-history-20261018/four-current-primary-confirmation.jsonl`，不含PIN或会话令牌。

本节关闭上文四桌负责人待确认项；qucan因PIN未知的真实登录及现场服务验收边界保持。已部署版本仍rc259/ea948926/schema270，本次没有再次发布软件。
