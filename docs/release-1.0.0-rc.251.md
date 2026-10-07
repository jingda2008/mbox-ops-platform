# M-BOX 1.0.0-rc.251 发布记录

## 实际部署

北京时间 2026-10-08 00:04:58 完成生产切流，标准入口 `deploy/aliyun/deploy-release.sh` 随后完成公网 HTTP、真实 Chromium 和 OSS 完成证据回读，以 `deployment=complete`、退出码 0 结束。经既有 SSH 代理接入应用主机，未把中转机当应用服务器。

- 标签：`v1.0.0-rc.251`；完整 SHA：`c142d7cd2a44fbf13b692414fa46da8f27accb98`。
- 镜像 digest：`sha256:f5ff66f3e11fb43525e5bc98f3c807544ee0f73219a263c60830d9472bbbcb31`。
- 运行平台镜像：`sha256:e032cf0cbb4b17cc9f503c68edc131b8a07d747f8b351b9e383305d7a58de0c0`。
- schema：264 → 265；最终 `/api/ready` 为 ready、production、schema265，SHA/digest 一致，workers healthy。
- 备份：`/opt/mbox/backups/mbox-20261007T160019Z-lA9L5m.dump`，OSS 上传和回读通过。
- 前版本：rc250／`a3ccec909243378460e9fc577a324fe5738cb38e`；保留回滚容器 `mbox-app-rollback-c142d7c-20261008-000456`。应用镜像回滚与数据库恢复是不同操作，不假定自动降级 schema。

## 变更与准确提交验证

承接 PR349/350，增加 Android/getui 绑定、加密 CID、通知发送与未知结果恢复，沿用员工/会话、安装修订及撤销隔离。迁移265扩展平台/provider约束及不可变身份守卫。依赖告警修补包括 sharp0.35.5、source-map-js1.2.2、shell-quote1.11.0及既有Capacitor iOS依赖8.4.3；最后一项仅依赖安全修补，不恢复iOS业务开发。

[PR351](https://github.com/jingda2008/mbox-ops-platform/pull/351) 准确头 `2236a32dfdef7443d02994917189c60a05dde67c` 通过 [完整CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37642119968) 和 [Android双构建CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37642119897) 后合并。完整CI的隔离PG为353文件／3239测试通过，浏览器业务回归136通过、三屏18通过、会员8通过；这些是隔离环境业务证据，不等同生产真实交易。

标签对应的 [CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37643679398) 和 [发布流水线](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37643679303) 均 success；26项发布资产、部署包内16项脚本/配置摘要核验通过。标准入口的配置与外部依赖预检、OSS证据、备份、迁移、零流量候选和切流均通过。

## 生产回读与网页边界

公网 `/`、`/guest?table=W01`、`/reserve`、`/staff/live` 的 HTTP 与真实浏览器加载通过；未以真实员工账号在生产制造开台、下单、收退款或库存测试数据。网页登录后的营业闭环证据来自隔离CI，本次生产检查不冒称完整真实交易验收。

个推继续关闭。规范配置、归一化发布配置、运行容器及实际配置解析结果均核实 `MBOX_GETUI_ENABLED=false`；预约新增开关仍关闭。生产应用角色只读事务检查迁移265约束、forced RLS、不可变函数摘要及 BEFORE UPDATE 触发器通过，事务回滚，不读取业务行、不写营业数据。

发布前 Mac Chromium 在旧rc250上多次出现 `ERR_NETWORK_CHANGED` 等网络失败，原因尚未确定；原始失败日志保留。改用本地隔离 Linux Playwright1.61.1 实际浏览器运行原校验脚本，预检及发布后检查通过。未改系统DNS/代理、未禁用TLS、未放宽断言或修改标准部署脚本；此结果不代表 Mac 网络问题已修复。

本地证据根目录：`/Users/jingda/mbox/outputs/release-rc251-20261007`，包括 `deploy.log`、`production-final-ready.json`、`postdeploy-push-readback.json`、`remote-final/`、`bundle/deployment/` 及准确提交CI记录。

## 安卓交付与未完成验收

[Android build12正式候选验证](android-build12-20261008.md) 已完成：0.4.0-rc.7／build12，原签名、生产登录、无演练、未纳入未配置的个推SDK；build9覆盖升级及4KB/16KB模拟器验证通过。

APK仅本地交付，未上传或切换stable。部署前后线上stable逐字节一致，仍为0.4.0-rc.4／build9，摘要 `a244d1b6067e0e351acbe4755e21c68f0bd93d0a8d58445fa2b40332f548c4da`。不触发员工自动升级，build10/11原候选保留。

本轮不包含微信/支付宝小程序上传；供应商采购退货和iOS功能仍排除。真实手机多品牌兼容、相机扫码、锁屏省电、平台推送配置/送达、SDK安全真机验证及真实资金/纸票/整班营业仍独立待验，不据此宣称全部商业验收完成。
