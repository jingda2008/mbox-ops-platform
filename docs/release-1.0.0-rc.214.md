# 1.0.0-rc.214 四平台团购券核销（tsc 修复后候选）

版本：`1.0.0-rc.214`。本版在 rc.213 同一功能上重建可编译的正式候选：员工可在「收银与退款」查询并核销**大众点评、美团、抖音、快手**券码。先按券码或扫码查询，确认后再向平台消耗，本地留下核销记录与尝试流水。不改支付宝/微信支付，也不扩展其它 OTA。

`v1.0.0-rc.213` 标签 CI 因 `server/normalized/commercial-ops-api.ts` 未使用的 `providerVerifyId` 触发 TS6133，`build:normalized` 以 exit 2 失败，浏览器 webServer 无法启动，GitHub Release 未形成不可变包。PR #267 删除该死变量；核销成功后仍将平台 `verifyId` 写入 `input.providerVerifyId`。凭证只从受保护环境变量读取。本候选**不部署生产、不设置 `MBOX_VOUCHER_MODE=production`、不写入真实密钥**。

## 数据与门店配置

- 规范化迁移 `222_group_voucher_platform_verification.sql`，目标 schema **222**。
- 门店配置账本 `2026.09.20-v25`。账本校验随发布元数据门禁执行。
- 应用回退仍保留 rc.212 镜像与数据备份。

## 验证口径（诚实状态）

- PR #267 CI 在合并前：classify / quality / normalized_database / normalized_browser / performance / verify 成功。这证明服务端可以编译、浏览器 webServer 能启动并跑通既有 e2e，不证明四平台真实券码或门店岗位验收。
- 213 条经营 TC 与发布阻断表按 rc.213 模式重新生成，**当前候选状态均为未执行或既有阻塞**。
- SYS-268 保持开放。不以可见页面、模拟核销、编译修复或本候选标签关闭。

## 生产部署入口

若后续获授权上线，生产部署使用 `deploy/aliyun/deploy-release.sh`。本文件只准备发布候选，不执行该脚本。
