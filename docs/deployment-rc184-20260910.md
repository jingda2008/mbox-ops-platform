# rc.184 部署与微信上传记录

记录时间：2026-09-10 16:03 CST。

## Git 与验证

- 所有仍存在的 Git 工作树在提交前均无未提交文件；近期其他分支的修改已在主线，不重复混入旧分支。
- PR #198 已于 2026-09-10 15:44:44 CST 合并，主线 SHA：`9b170f71cd0629afa8f8cc194c8e20c4569d53f6`。
- 不可变标签：`v1.0.0-rc.184`。PR CI `34450657323`、标签 CI `34451570263`、release `34451570318` 均成功。
- 新版本本地完整检查通过：`/tmp/mbox-rc184-final-check.log`。

## 生产部署

- 唯一正式部署脚本 `deploy/aliyun/deploy-release.sh` 成功退出，日志末尾 `deployment=complete`。
- 正式地址：`https://mbox.shmbox.com`；SSH 沿本机既有该主机配置进入 `10.100.80.223`，通过支付中继连接，没有修改 SSH 配置。
- 只读 `/api/ready` 确认 `ready`、上述 SHA、schema `186`、tier `production`；此前为 rc.183/schema162。
- 镜像：`sha256:ee4b0061ab0c8009c72921e6b4a30e8943820fd21f188563a00dd2decd23f488`。
- 备份：`/opt/mbox/backups/mbox-20260910T075813Z-B19Pn9.dump`；部署前 OSS 证据和备份上传已校验，配置/迁移检查及候选切换通过。
- 正式 API 与浏览器检查通过：`/`、`/guest?table=W01`、`/reserve`、`/staff/live`。
- 本地证据：`/tmp/mbox-rc184-deploy-20260910.log`；`.runtime/deploy/v1.0.0-rc.184/deployment/deployment-manifest.json`。日志/密钥/真实业务数据未提交 Git。

## 微信开发者工具

- 工程：本工作树 `.runtime/wechat-rc184-9b170f7/miniprogram`，正式 AppID `wxdb9f2dc413484f2d`，正式 API 地址，关闭开发兜底、默认桌码和开发身份。
- 版本 `1.0.0-rc.184`，开发者工具 CLI 返回 `✔ upload`，退出码 0，大小 935470 字节。
- 对应候选清单绑定上述主线 SHA，上传后 147 个清单文件逐一 SHA256 比较无变化。合并前同内容候选已通过官方预览编译。
- 上传日志 `/tmp/mbox-rc184-wechat-upload-20260910.log`；上传信息 `.runtime/wechat-rc184-9b170f7/upload-info.json`。后者仅含包大小，不能冒称含平台审核编号。
- **体验版选择未核实**：浏览器安全策略阻止访问微信管理后台，未绕过。用户需在后台版本管理确认并将该版本设为体验版；未提交微信正式审核/发布，未上传支付宝。

## 保留边界

仅按系统既定时点自动切日，禁止人工提前结束。未结账、退款和履约继续追踪。此次部署不代表 GROW-01—05 余项开发完成，也不代表真实资金、实体打印、营销渠道或 iOS/Android 真机验收全部通过；264 条商业验收记录缺口继续保留，不伪造通过，不等同 264 个新缺陷。
