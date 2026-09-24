# rc.236 后厨及取餐口令轮换修复发布记录

## 修复与证据

- PR #303，合并 SHA `1b6f344e1f78991cef55ea4d92e2614b341ee3dd`，标签 `v1.0.0-rc.236`。
- PR CI `36030618137` 全部通过：2745 项 PostgreSQL 测试；106 项主流程浏览器通过、27 项按配置跳过；16 项三屏专项通过；质量、持续负载和 HTTP 验收通过。
- 首轮 CI `36030187740` 发现迁移链测试漏登记248，修正显式名单后重新完成上述完整CI；失败证据保留。
- 局部故障复现与68项授权/制作/取餐测试使用全新隔离数据库。生产只读证据确认：rc.235发布的配置同步撤销了后厨原设备绑定的门店口令，而员工会话与设备本身未失效。普通认证遵循六小时独立会话规则，旧KDS/取餐SQL重复校验口令而拒绝操作。
- schema248只替换取餐触发函数；服务端KDS去除同类多余检查，保留员工、会话、设备、有效期、在线租约、岗位和取餐设备绑定。未改账、未重建订单、未代替员工制作或取走。

## 发布状态

2026-09-25 01:35:55 CST完成切换验证，01:36:20 CST状态为completed。标准入口 `deploy/aliyun/deploy-release.sh` 成功退出；正式CI `36032665723` 及release `36032665712` 均成功。

- 线上SHA `1b6f344e1f78991cef55ea4d92e2614b341ee3dd`，schema248，production，ready；runtimeRole=normal、writeEnabled=true、workers=healthy。
- 镜像 `mbox-normalized:1.0.0-rc.236-1b6f344`，digest `sha256:49ed268966412f9fe796b847916605033e5102558475e44a2d5b431e16e767ca`。
- TLS及HTTP/Chromium入口 `/`、`/guest?table=W01`、`/reserve`、`/staff/live` 全通过；部署完成证据及OSS上传读回通过。
- 数据库备份 `/opt/mbox/backups/mbox-20260924T173401Z-Zmxcop.dump`，已验证OSS读回；上一版本目录 `/opt/mbox/releases/3bda048`，回退容器 `mbox-app-rollback-1b6f344-20260925-013546` 保留。
- 01:36:38 CST只读检查实际部署代码和数据库函数：两处均不再重复验证门店口令，但会话、设备撤销/到期、在线、员工、取餐设备及岗位检查仍在。
- 01:36:56 CST后厨原员工现有会话login_valid=true、online=true、device_valid=true；其旧口令依旧revoked。读取实际后厨板返回actionSessionValid=true、canPrepare=true、canStart=true。未伪造心跳、续租或执行制作/取走，证据证明原授权阻塞已解除，不能代替实际出品动作验收。
- 私有本地证据：`outputs/kitchen-live-followup-20260924/rc236-after-ready.json`、`rc236-after-policy.json`、`rc236-after-session.json`、`rc236-after-board.json`、`rc236-release-state.json`；部署manifest位于独立发布工作树 `.runtime/deploy/v1.0.0-rc.236/deployment/`。

## 现场边界

旧平板仍可能运行内存中的旧JavaScript，需整页刷新加载已部署的新版；不以页面内旧队列刷新代替浏览器刷新。员工会话硬过期须正常重新登录，未替员工续租或延长会话。实际后厨制作完成、取餐及撤回、休眠唤醒和手机同步仍以门店实机证据验收，SYS-384不得据服务器健康关闭。
