# rc.211 后厨稳定性及微信会员码交付

本次交付整合后厨与侧会话微信会员中心代码，原工作树和未提交修改完整保留。支付宝源文件未修改。后厨具体修复见[修复记录](kitchen-queue-fixes-20260919.md)，现场每次异常仍不能在缺少时间、桌号和设备证据时作单一归因。

## 源码及验证

- [PR #255](https://github.com/jingda2008/mbox-ops-platform/pull/255) 于 2026-09-19 19:54:33 CST 合并。
- 合并提交：`69cacece38e7f542c81e27b5b46433ed5db3d8c0`；不可变标签 `v1.0.0-rc.211`；无数据库迁移，schema 221。
- [PR CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35440822091) 成功，数据库 2,304 项、浏览器 89 项通过，质量、真实 HTTP 和性能门禁全部通过；测试数据库数据不代表真实门店验收。
- 标签 [CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35441427846)、[Release](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35441427817) 均成功，headSha 与合并提交一致；标签数据库 2,304 项、浏览器 89 项通过。
- 发布工作树 `/Users/jingda/mbox/mbox-release-rc211-20260919` 已按合并提交完成 `npm ci`，本机 Playwright 前置检查与真实 Chromium 公开页面预检通过。
- 微信三个页面文件逐一 SHA256 比对侧会话工作树一致；SYS-253 过时页数断言修正后 11 项布局回归通过。会员码模板/样式使用现有差异清单固定审核哈希，支付宝其余校验保留。

## 微信开发版本

开发者工具 CLI 已成功上传 `1.0.0-rc.211`，AppID `wxdb9f2dc413484f2d`，包大小 1,020,128 字节。候选绑定上述合并提交、生产 API 与身份租户/门店；运行配置与生产解析值一致。上传前后 candidate 完整性门禁通过，清单 SHA256：`f972f7acd3dc08f4b39517c14b561f64d8c3df0097633ff7915824266445e3d7`。

这是微信开发版本上传成功，不代表体验版切换、平台审核、正式发布或 iOS/Android 真机验收。支付宝未上传。会员码支持点开放大、遮罩/按钮关闭、内容点击保持、离页/重载关闭、缺码与加载失败保护。

## 生产发布

正式入口 `./deploy/aliyun/deploy-release.sh` 退出 0；2026-09-19 20:13:59 CST 完成切换核验，20:14:20 CST 状态机进入 completed，随后本机公开 HTTP 与真实 Chromium 验证均通过。

| 核对项 | 结果 |
|---|---|
| 线上提交及 schema | `69cacece38e7f542c81e27b5b46433ed5db3d8c0` / `221`，无迁移变化 |
| releaseImageDigest | `sha256:154e256037a66f73614ce8f3df9f12e6063a12a9b5a9f066bf453e9f5d2f8207` |
| 容器镜像 | `sha256:1b4df5611d2889e8c6d45a2ff5632644f9c2a5bb5919746481bdc3c45d5bf771`，healthy，重启 0，源码层无热改 |
| readiness | ready / production / normal / writeEnabled=true / workers healthy，failures=[] |
| 公开入口 | `/`、`/guest?table=W01`、`/reserve`、`/staff/live` 的构建身份、资源与浏览器渲染通过 |
| 备份 | `/opt/mbox/backups/mbox-20260919T121224Z-XCXaXp.dump`；4 对象 OSS 上传及读回 verified |
| 部署及完成证据 | 分别 8、3 对象 OSS verified，状态机 completed |
| 回退版本 | `mbox-app-rollback-69cacec-20260919-201357` 保留 rc.210 / `de4b877`，正常停止 |
| 配置保留 | canonical/release/container 三层与发布前一致；解析配置确认数量售后、微信、worker 启用，严格库存和微信支付模式保留；服务号回调/订阅 AppID 一致 |

首次尝试在连接应用服务器时退出 255，尚未进入远端部署或切流：连接参数直接使用内网 IP，未使用带 ProxyCommand 的 SSH 别名。核对原 rc.210 仍健康后，改用已有 `mbox.shmbox.com` 别名和中转配置，从同一正式入口重试成功；未修改发布脚本或绕过门禁，首次失败日志独立保留。短窗口健康核对不等于门店长期稳定性验收。

## 保留的现场事项

SYS-254—261 软件修复已提交，现场关闭条件继续保留：真实弱网、混合高峰、多员工连续操作、跨营业日历史、配送实际批次及票据。SYS-202 长期稳定性和既有 Windows PrintBridge 实物票据验收没有被本次结果替代。

旧设备 `current-session` 待确认记录缺少员工归属，继续保留并防止误重发；需核对原任务、原命令编号、审计及实际制作/交付后逐设备处置。本次未清理门店浏览器存储，也未改写生产订单、库存、财务或历史制作记录。

发布本地证据：发布工作树 `artifacts/rc211-release/`；正式发布包及清单：`.runtime/deploy/v1.0.0-rc.211/`。
