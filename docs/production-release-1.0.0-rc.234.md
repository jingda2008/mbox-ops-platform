# rc.234 三屏修复生产发布记录

2026-09-24 22:46 CST。用户明确授权提交、合并、部署；本次已完成。

| 项目 | 证据 |
| --- | --- |
| 代码合并 | [PR #300](https://github.com/jingda2008/mbox-ops-platform/pull/300)，合并提交 `253c7d9d84ce3c23c863d48a48ae3085d46c8be6` |
| 标签 | `v1.0.0-rc.234`，与合并提交一致；发布工作树与该标签源码干净一致 |
| CI | PR检查 `36010341202`、标签检查 `36012393936`、发布流程 `36012393847` 均成功 |
| 浏览器回归 | 常规106通过/26按功能环境跳过；独立三屏环境16项全部通过，覆盖入口、最小权限、横竖旋转、部分完成、可见视口与恢复 |
| 镜像摘要 | `sha256:0a399c5b0407adac0004d1206bbae4b326e2d9a3c0bb2b8224ee9fa155f41ade` |
| 平台镜像 | `sha256:62240bb432988b2d5890f4549f9fdb9d5460d792fa01d423ac4f4fe58794fea2` |
| 数据库 | schema247；`migrationChanged=false`，本次没有新增迁移 |
| 标准入口 | `deploy/aliyun/deploy-release.sh` 退出0、`deployment=complete` |
| 切换 | 22:44:58开始，22:45:30验证通过；22:45:55服务器状态completed |
| 上线核验 | ready、新SHA/摘要/production一致，workers healthy、writeEnabled=true；容器running、重启0 |
| 功能开关 | 后厨批次、三屏流程、按份售后均true，发布前后相同 |
| 公开页面 | `/`、`/guest?table=W01`、`/reserve`、`/staff/live` HTTP与真实Chromium渲染均通过 |
| 备份与OSS | 备份、镜像、发布前证据、部署及完成证据上传回读通过 |
| 回退保留 | rc.233，容器 `mbox-app-rollback-253c7d9-20260924-224458`；同schema应用镜像回退 |

操作机先npm ci并执行浏览器启动预检。直接公网短TLS探测不稳定，沿用既有临时SSH转发到已复核公网地址的发布路径；HTTPS仍使用正式域名、验证证书，不改变服务响应、不绕过门禁、不修改系统DNS或生产路由。远端命令沿用已安装的Bash5.2。初始HTTP手工探测遗漏期望镜像参数，修正后重新验证通过，保留失败日志。

本地证据：`/Users/jingda/mbox/outputs/three-screen-release-20260924/`，包括部署日志、切换前后ready、容器状态与状态机。发布清单：`/Users/jingda/mbox/mbox-release-rc234-20260924/.runtime/deploy/v1.0.0-rc.234/deployment/`。

SYS-379/380/381/382的代码修复已上线；真实Android软键盘/休眠、qucan当前物理设备绑定、实物制作与领取验收继续开放。发布成功不等于工作人员已刷新三屏或已完成现场验收。没有代员工确认制作完成、取走、收退款，没有更改账号/PIN或设备绑定；不涉及微信小程序上传或PrintBridge安装。
