# rc260 积分结清与退款票据生产发布记录

状态：2026-10-19 17:57:47 CST标准生产发布完成；17:58:24 CST积分与设备只读回查通过。用户明确授权“CI通过后部署”。范围为后台/员工Web，schema270；正式小程序、真机、真实支付退款与出纸仍待现场验收。

## 不可变版本与门禁

| 项目 | 实际结果 |
|---|---|
| 标签 / 提交 | `v1.0.0-rc.260` / `f350f60dcbba91dd7600b3ab37b5f287f9d2c109` |
| 镜像摘要 | `sha256:f8199fc00127a376360b576204226f0f06a44583503c2fd19e98b1db62f1b648` |
| 平台镜像摘要 | `sha256:f428d47eddca55c6bd5164f59c20b0fe6a2102953a9dae2dbf7966f8e990d0b8` |
| 修复PR | [PR376](https://github.com/jingda2008/mbox-ops-platform/pull/376)，17:28:33 CST合并 |
| 最终PR CI | [39228224194](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39228224194)，通过 |
| 主线CI | [39230340235](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39230340235)，通过 |
| 标签CI / Release | [39230491165](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39230491165) / [39230491162](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39230491162)，均通过 |
| 数据库 | schema270，`migrationChanged=false` |
| 备份 | `/opt/mbox/backups/mbox-20261019T095435Z-ONpumZ.dump`，OSS上传/读回验证通过 |
| 回滚保留 | rc259 / `mbox-app-rollback-f350f60-20261019-175719`，application_image模式 |

首轮PR CI39225923058失败必须保留：数据库3320通过、1项包含真实数据库时钟过期等待的集成测试超过默认5秒；无业务断言失败。只为该五场景集成用例设置30秒时限，并将到期夹具由3秒改为10秒给扣分前准备留余量；全局时限、生产代码与业务断言不变。修后定向12组89项通过，最终PR及标签数据库360文件3321项全部通过。没有以重跑删除原失败记录。

主线与标签浏览器均为主流程138通过/42条件跳过、三屏18、会员10、服务记录4通过，日志未发现重试或flaky。小程序539项、6张58/80mm样张和完整本地检查见[逐条积分报告](points-acceptance-2026-10-19.md)；不同层结果有重叠，不累计为独立用例总数。

## 标准部署与回查

- 唯一入口`deploy/aliyun/deploy-release.sh`，dry-run通过，正式运行退出0并返回`deployment=complete`。
- 配置、外部入口及迁移兼容预检、私有OSS备份、零流量候选健康与深层入口、切换后验证、部署证据和完成证据回读全部通过。状态历史最终为`completed`，17:57:47 CST。
- 公网`/api/ready`返回production、ready、schema270、当前SHA/镜像摘要；容器healthy、worker无失败。原有integrationWorkersEnabled=false及适配器状态保持，不能将此健康回执称为真实打印验收。
- `/`、`/guest?table=W01`、`/reserve`、`/staff/live`的接口与Chromium检查通过，TLS验证启用。
- 部署前后15项关键表指纹完全一致，涵盖商品、套餐、预约、权限、会员规则、积分账户/批次/控制；Caddy完整配置SHA256仍为`44bcf655dbe8b772c7aa7ddea03cb455ee7f9d34d7c4b9c8d64f7ad75d7368b4`。
- BASE v1保持published且cash_redemption_enabled=true：每笔实付满10元积1积分，零头不跨单累计；每实付1元积1成长值；新积分有效期12个月。没有修改规则或回补历史积分。
- 254个账户可用积分和成长值合计仍均0；积分占用/返还及启用以来打印任务均0。后厨和吧台最后心跳17:58:20 CST，连接在线仅证明链路，不证明已出纸。

## 已发布修复及保留项

1. 全积分订单由权威结清事实识别为结账单，现金实收保持0，普通无结清依据的零元单仍为预结账单。
2. 整桌/归档/退款票据显示原抵扣和累计返还，返还积分与现金分列；原票据补打保留快照。
3. 顾客账单区分已返还积分、恢复可用和原批次过期数量，解释余额未恢复的原因。

POINTS-ACCEPT-20261019-01的后端修复已上线，现场项继续开放。没有创建生产测试支付、退款、补分或打印任务。缺少正式微信版本证明及指定测试会员/桌台/商品/资金上限、现场出纸确认；下一步按逐条报告的现场顺序执行。三位人员独立审批不能由代理切换三个账号替代。

## 原始证据

本轮证据目录：`/Users/jingda/mbox/outputs/rc260-points-20261019/`。包含`dry-run.log`、`deploy.log`、`deployment-manifest.json`、`release-manifest.json`、`production-deployment/`、`ready-before.json`与`ready-after.json`、`points-before.json`与`points-after.json`、`fingerprints-before.json`与`fingerprints-after.json`、`caddy-before.sha256`与`runtime-after.txt`、各CI日志及首轮失败记录。
