# rc.235 生产发布及继续发现的授权阻塞

2026-09-25 00:36:36 CST，标准deploy-release.sh退出0，线上SHA为`3bda0487014d678cdd52e61fdca154944ba2c8cf`，镜像摘要`sha256:44ffd1e2afb7f9fd861a5edff3612730bc7e1403d1545d4c49959a7fc20f7dd1`。schema247无迁移，ready、worker healthy、writeEnabled=true、runtimeRole=normal。备份和OSS上传回读、候选/deep links、公开HTTP及Chromium检查通过。PR302、CI36023910551、标签CI36026038735、发布36026038876成功。

回退为rc.234容器`mbox-app-rollback-3bda048-20260925-003608`，备份`/opt/mbox/backups/mbox-20260924T163419Z-YPm0d1.dump`。只读生产W01队列已返回新的浏览器整页刷新提示，份数及批次未改。

现场尚未恢复确认。00:37—00:39发现后厨login_valid=true、device_valid=true，绑定口令credential_revoked_at=00:35:50.191726，恰为发布provisioned阶段；原口令并未过期。该已签发会话在普通认证与KDS检查中规则冲突，需继续SYS-384/rc.236。旧页面未自动加载新程序的现场步骤仍开放。未冒用会话心跳或代操作制作取餐。

证据：`/Users/jingda/mbox/outputs/kitchen-live-followup-20260924/`，含deploy.log、after-ready.json、release-state.json、after-board-and-entry.json及session-status.json。
