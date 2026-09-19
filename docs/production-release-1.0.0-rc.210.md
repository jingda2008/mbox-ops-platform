# rc.210 审计修复交付记录

用户已授权修复、提交、合并、部署；逐项修复见 [核对表](system-audit-fixes-20260919.md)。

## 源码与流水线

- [PR #253](https://github.com/jingda2008/mbox-ops-platform/pull/253) 已于 2026-09-19 17:47 CST 合并。
- 合并提交：`de4b8779a13f8eabd0b5794a2765b6fb9265c346`；不可变标签 `v1.0.0-rc.210`；目标 schema 221。
- [PR CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35435123946) 全部必需检查通过，包含数据库/RLS、真实 HTTP、浏览器和性能。
- [标签 CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35435671521)、[Release](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35435671567) 均已成功，且 headSha 与合并提交一致。
- 独立发布工作树 `/Users/jingda/mbox/mbox-release-rc210-20260919` 已完成 `npm ci` 及真实 Chromium 前置预检。

## 微信与支付宝

微信开发者工具 CLI 已成功上传 `1.0.0-rc.210`，AppID `wxdb9f2dc413484f2d`，包大小 1,017,792 字节。候选包绑定上述合并提交及生产 API；身份租户/门店/AppID 已与生产解析配置核对。上传前后 candidate 门禁均通过，清单 SHA256 为 `f9a08703bab31cac3b27f68111e5814e6bffbe7da0745d947915ffa5caf875be`。

本次证据是 CLI 开发版本上传成功；没有据此宣布体验版切换、微信审核、正式发布或真机通过。`upload/release` 综合平台证据门禁也没有被标记通过。支付宝共享推荐逻辑已修复、静态校验及官方编译 23 页面通过，本次未提交支付宝平台上传，既有平台能力关闭边界保留。

## 生产基线与发布后核对

生产基线为 rc.209 / `6c076ddef187149f4081b57c5859e5dd7b8ea2bf` / schema 220。发布前源码层无热改；原镜像、挂载与只读业务基线已归档。canonical、release、container 三层数量售后、微信、服务号、worker、严格库存及支付配置一致；服务号回调、订阅配置及唯一启用数据库账号 AppID 均为 `wx4e1833528fe0dd15`。

正式入口 `./deploy/aliyun/deploy-release.sh` 退出 0，18:04:28 CST 完成切换，18:04:48 状态机进入 completed，18:05 完成本机公开 HTTP 和渲染浏览器复验。

| 发布证据 | 实际结果 |
|---|---|
| releaseImageDigest | `sha256:38e2acd7c0c0ee90006e97515b3f2186e982f514b9a27b2e728639dd5cbd623b` |
| 容器镜像 | `sha256:d4c4628b915aa06570541bfd589c3d7e89dc55be1f590b67285c376c0abffb37`，重启 0，源码层无热改 |
| readiness | `ready`、`de4b877`、schema `221`、production、normal、writeEnabled=true、workers healthy |
| 公开入口 | `/`、`/guest?table=W01`、`/reserve`、`/staff/live` 的构建身份、资源和实际渲染通过 |
| 备份 | `/opt/mbox/backups/mbox-20260919T100253Z-XkFRW7.dump`，4 对象 OSS 上传/读回 verified |
| 部署与完成证据 | OSS 分别 8、3 对象 verified，均有 `_COMPLETE.json`，发布状态 completed |
| 回退 | `mbox-app-rollback-de4b877-20260919-180425` 保留旧 rc.209 镜像，正常停止，未删除 |
| 配置 | canonical/release/container 与发布前一致；parsed runtime 确认数量售后、微信、服务号、worker 启用 |

## 已知故障上线核对

- 四类通知授权/提示 GET 均恢复为 401 / AUTHENTICATION_REQUIRED；旧示例发送 POST 为 410，缺少授权身份 POST 为 400。六项公网探测通过，无真实消息发送。
- 两笔被超长幂等键阻挡的支付均恢复为 `failed`，自动追踪停止，原因为 provider_terminal_result。native_qr 一笔由新 worker 于 18:07:40 自动应用；auth_code 一笔仍在旧退避至 18:59，18:07:47 经一次真实渠道查询及当前验证命令恢复。只允许渠道新确认的失败/关闭结果，无新收款、退款或渠道关闭动作。
- 两笔各消费 1 条新验证观察，账本条目始终 0；原有 495 条未消费历史失败观察完整保留。原始恢复回执中的 `applied:false` 是辅助函数返回“是否支付成功”的布尔值，失败终态返回 false 属于预期；数据库终态和观察消费构成应用证据，另有释义报告，原始回执未改写。
- 18:04:28—18:09:10 新容器短窗口未见支付同步 TypeError；workers healthy、failures=[]。发布前最近 30 分钟同类错误 6 次。时间窗口不同，不能比较错误率或宣称长时稳定性验收完成。
- 已成功收款无缺失/重复收款账本，金额不匹配 0、超额退款 0；库存负数/超预留/余额流水差异均 0。历史待核资金、成本和盘点事项仍保留，已处理 20 元退款不重开。

## 未替代的外部与现场证据

SYS-239 的真实微信事件、授权、收码和提醒仍需真实账号/设备留证；微信体验版/正式版、支付宝上传/平台能力验收分别记录。SYS-241 现场桥仍回报 1.0.9，1.0.10 Windows 安装和实物票待验；SYS-202 混合高峰、弱网和长期稳定性仍需门店证据。本次软件修复和生产发布完成，不将这些事项标为完成。

本地证据在发布工作树 `artifacts/rc210-release/` 和审计工作树 `artifacts/system-audit-fixes-20260919/`，原始只读审计证据单独保留。
