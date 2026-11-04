# 1.0.0-rc.280 通知权限与授权撤回

**2026-11-05 02:01:53 CST 已完成后台及员工Web生产部署**，提交`cca1f0ed3636a0e0312dea1fa9ddce072433a96f`，schema299。正式入口、真实浏览器和39项只读业务回查通过。小程序未上传/审核/发布，宣传网站保持原版本，现场桌台、订单和员工账号保持。

## 正式发布与验证

- 用户2026-11-05明确授权合并PR419并部署后台；[PR #419](https://github.com/jingda2008/mbox-ops-platform/pull/419)于01:24:45 CST合并，合并SHA与候选`b0f23c1cd580730252445284266cab0b4b400883`完整代码树一致。
- [候选CI41837844399](https://github.com/jingda2008/mbox-ops-platform/actions/runs/41837844399)、[主线CI41877337167](https://github.com/jingda2008/mbox-ops-platform/actions/runs/41877337167)、[标签CI41877355769](https://github.com/jingda2008/mbox-ops-platform/actions/runs/41877355769)、[Release41877355486](https://github.com/jingda2008/mbox-ops-platform/actions/runs/41877355486)全部成功。主线和标签各4149项数据库通过/零跳过，受限LOGIN前置各130通过；质量（含Linux发布系统）、浏览器、性能、verify通过，标签镜像完成验证。主线和标签并行核对同一主线可达提交，等待三项最终成功后才部署，没有用旧CI代替。
- [作者发布准备复核](https://github.com/jingda2008/mbox-ops-platform/pull/419#pullrequestreview-5769089346)完成，无未解决审查线程；不是独立外部批准。GitHub一度延迟显示任务状态，保留观察记录，未以局部日志绕过最终门禁。
- [v1.0.0-rc.280](https://github.com/jingda2008/mbox-ops-platform/releases/tag/v1.0.0-rc.280)发布包摘要`sha256:56ccf2266850e0dc0ecbc80caf041e0241433150e98002f92a14c2e3cf2047df`；平台镜像`sha256:fea300368dae948f5db4af87996b80ee28ef5623e39534b6735ecb23baa38284`。仅使用`deploy/aliyun/deploy-release.sh`，标准试运行及正式部署均退出0，最终release-state=completed。
- 部署前及激活前只读重核生产版本、营业状态、账号和配置；新备份`/opt/mbox/backups/mbox-20261104T175926Z-JuTogx.dump`已通过私有OSS核验。镜像、发布证据、部署清单和完成状态均已上传私有OSS并验证。
- 只新增迁移299，门店与菜单provision均replayed=true，版本与内容未变。没有重放现场初始化，没有改员工PIN、姓名、状态、角色或门店凭据。
- 正式`/`、`/guest?table=W01`、`/reserve`和`/staff/live`的HTTP、静态资源、构建身份和真实浏览器渲染通过；正式ready对应上述SHA/摘要、schema299，workers healthy、runtimeRole normal、writeEnabled true，集成工作进程原关闭状态保持。
- 02:03:12 CST完成39项只读回查：17个启用账号权限/导航、14类配置摘要、订单/明细/桌次/参与账号/付款/退款全记录摘要保持；29个开放桌次及35条历史转台并桌事实保持；预约授权触发器与299迁移源码一致，原所有者/调用者权限保持，转台并桌函数未变。
- 宣传站v25容器ID、镜像及启动时间从初始盘点到发布后均一致，公开站HTTP200，未重新发布或重启网站。未上传、审核、发布小程序，也未发布原生App；PR中的客户端原键恢复修复仍待小程序单独发布，不能算作手机端已生效。

当前回滚容器`mbox-app-rollback-cca1f0e-20261105-020151`，对应rc279提交`713e28feb27884f977aa1e2938ee3996d9f42d4c`，application_image模式；保留schema299，不回退经营事实。回滚会重新暴露本批授权缺口，应仅用于可用性恢复。

原始证据目录`outputs/release-rc280-20261105/`：merge/tree核对、ci-main/tag/release、数据库及浏览器日志、dry-run/deploy、production-deployment/deployment/deployment-manifest.json、remote-evidence、postdeploy-verification.json及网站前后身份。权限和业务摘要留在本地受限目录，不附客户或账号明细到PR。

工程发布不替代历史经营TC、真实通知送达、外部适配器幂等、撤回UI与真机验收。部分拆并桌问题02仍待业务明确，未修改。下列发布前准备内容作为历史保留。

## 发布前准备（历史记录）

**发布前准备，尚未合并、打标签或部署。** 用户2026-11-04授权完成最后准备；实际执行须另有合并部署授权，并重新通过执行时门禁。候选为[PR #419](https://github.com/jingda2008/mbox-ops-platform/pull/419)，后台及员工Web范围，schema299。

## 变更和证据

原7类管理权限修复及新增9类通知授权链路修复，分别见[管理端审计](notification-receipt-audit-20261104.md)和[订阅集中修复](notification-subscription-followup-20261104.md)。包括撤权后的旧回执、本人撤回与通道/历史配置解耦、顾客身份隔离、发送前资格重查、中断unknown恢复及原键重试。通用通知队列资格失效时不调用外部适配器。

业务提交`d51f2351c869d5f1fd004e094dfe9c1e0d496c05`的[完整CI41829572974](https://github.com/jingda2008/mbox-ops-platform/actions/runs/41829572974)成功：数据库4149通过/零跳过、受限LOGIN前置130通过，质量、浏览器、性能与verify通过。新增回归为原管理端30项及后续86项，两批分别计数。后续修复前反证数据库34失败、HTTP9失败、小程序33失败；最终完整本机数据库4148通过/1项容器恢复演练条件跳过，该项在CI通过。本机check2714通过/2247数据库条件跳过并完成构建。[作者代码复核](https://github.com/jingda2008/mbox-ops-platform/pull/419#pullrequestreview-5768265476)完成，不代表独立外部批准。

本次仅补发布元数据、TC登记和准备记录，不改业务代码。新提交的准确SHA、完整CI运行和发布准备复核以PR当前head及其验收评论为准；不把业务提交CI作为新提交证据。主线/标签CI、镜像与部署清单必须在实际执行后单独记录。

## 2026-11-04 21:20–21:22 CST 只读检查

- 正式入口ready返回生产提交`713e28feb27884f977aa1e2938ee3996d9f42d4c`、schema298、workers healthy、normal/writeEnabled；三次正式TLS预检通过。integrationWorkersEnabled=false、推送/打印集成关闭的现状不因本次发布擅自开启，健康状态不代表真实通知送达。
- 生产298条迁移文件名、顺序和SHA256均与候选一致。本次唯一新增`299_reservation_notification_withdrawal.sql`，事务内替换触发器函数及schema版本，lock_timeout=3s、statement_timeout=5s；无表重写或经营数据修复。预约结束后只允许已有本人授权的denied/revoked，新授权仍要求有效预约及演出，身份和顾客归属校验保留。
- 门店配置`2026.10.31-v29`摘要`af0028f96ef57a5457b06b1647f261b8dabf0f3a3e2c9b335d72262358c8a35b`；菜单`2026-07-27-v1`摘要`fb95f6621c186a753f621603393c935c8097a36844cefc78f686060df233f13d`。候选解析后的摘要与生产所有同版本应用回执匹配；不提升配置版本，不重新初始化现场配置或账号。
- 生产当前容器及rc279平台镜像仍在，本机磁盘可用约24.4GiB。公开宣传站v25容器身份和启动时间仅作只读基线，不重启或发布。
- 营业中，快照有14开放桌次、最近30分钟7笔成功收款；另有504条历史pending付款（本快照最近更新11月1日）、无creating/unknown渠道动作、无处理中的退款及其他活动数据库事务。历史pending不等于当前支付在途，也不能据此自动取消或补单。上述均为瞬时证据，不能作为稍后切换的通行证。

原始证据在本地受限目录`outputs/release-rc280-20261104/`：operating-before、ready-before、configuration-before、candidate-config-hashes、schema-before、compatibility-summary、public-preflight及host-preflight。凭据、客户明细不写入PR。

## 执行顺序和回滚

仅使用[Aliyun标准发布入口](../deploy/aliyun/README.md)及`deploy/aliyun/deploy-release.sh`。不使用旧Cloud Run流程，不绕过质量、备份或迁移门禁。

1. 取得合并部署授权后，重新检查PR准确head、审查/未解决线程和完整必需CI，确认没有新改动；合并后核对代码树与候选一致。
2. 等待准确主线CI，发布v1.0.0-rc.280标签，等待准确标签CI/image和Release成功。记录完整合并SHA、发布包SHA256、平台镜像摘要；不得从当前功能分支直接部署，也不得把rc279镜像当rc280候选。
3. 用同一发布包完成脱敏真实环境配置及外部TLS预检、只读迁移谱系检查；切换前再次检查当前生产身份、现场配置和账号摘要、营业/支付退款在途及长事务。条件不满足即停止，保持现场；不通过清台、改单或改账号消除阻塞。
4. 标准流程创建新数据库备份并验证私有OSS对象、哈希及可读性，不能用rc279历史备份替代。确认当前rc279镜像及证据可恢复，再迁移299并复用同配置回执，验证provision的replayed=true。
5. 零流量候选通过API、浏览器、固定桌码、预约及员工深路由后才切Caddy；正式入口再次核对SHA、摘要、schema299和健康，执行只读业务/账号/配置回查，上传发布清单、校验和与状态到私有OSS。

本次只读核实的应用回退目标是rc279提交`713e28feb27884f977aa1e2938ee3996d9f42d4c`，平台镜像`sha256:35d2410f2a7d488fa16e8261a3383caa743d1d16200326785e4afbc4a3500c05`，发布包摘要`sha256:01c8394ab5750b20454bd485490d29e01a07c5a20e65ca34993544c3ebe69f71`。ready中的releaseImageDigest是发布包身份，必须与Docker平台镜像摘要分别记录。镜像以load导入，RepoDigests为空不代表镜像不存在，以实际image ID及发布清单核对。

回退采用标准application_image模式，保留schema299，不倒回订单、付款或授权撤回事实。299保持原表结构和调用约定，旧应用仍可运行，但回退会重新暴露本批授权缺口及撤回限制，只能用于可用性恢复。实际发布前重新核对回退镜像和新备份；本轮未创建备份、执行迁移、创建候选容器或演练生产切换。

## 限制和验收边界

小程序源码修复包含在PR中，但后台部署不会更新用户手机上的小程序包。未上传开发版、提交审核或正式发布小程序；原生App及宣传网站也排除。历史小程序未决缓存缺身份时保留并要求核对，不静默换键；生日/旧版通知旧回执可能安全拒绝409，须读现状核对。

生日成功回执保留会增加存储；积分/预约每批最多5条，单收件人检查2秒、发送/预检5秒。unknown保持已消耗授权，不自动重发；已交给外部平台的请求无法靠本地撤回取消。平台适配器幂等、真实送达、撤回UI及真机仍独立待验，不发送真实通知测试。

TC登记保留213条经营基线及专项未完成状态；工程CI通过不等于商业验收通过，不伪填真实岗位、资金、设备或现场验收。本次不改部分拆并桌问题02规则，不改现场桌台、订单或员工账号。
