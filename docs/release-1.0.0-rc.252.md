# M-BOX 1.0.0-rc.252 微信购物车冲突恢复

微信小程序收到购物车版本冲突后，原流程在提交锁仍开启时调用刷新，刷新立即返回却提示已更新，导致已提交商品或旧版本继续留在页面。现在先解除服务端明确拒绝的请求锁，再读取当前购物车；刷新失败时阻止继续提交并提供重试，换桌后忽略旧结果，并重新开启购物车轮询。未知提交结果仍保留原幂等键，不自动新建或重付订单。

本地新增3项回归修前失败、修后通过：更新到已提交后的空车；刷新失败禁止旧车再次提交；换桌后的迟到响应不覆盖新桌。小程序391项回归、167文件静态和商业清单检查通过。PR #353、最终标签CI及Release全部通过；后台部署与微信开发版上传完成，手机现场恢复仍待验。

2026-10-10用户明确授权提交、合并、部署、上传微信小程序。本次不包含微信正式审核/发布或体验版切换。后台无新增迁移、schema265不变，Android稳定包及已有配置保持原值；微信候选必须绑定最终合并SHA。

W20线上只读记录显示21:02的316元扫码单已取消、付款尝试closed，21:04的同金额代客单在系统记paid。订单后存在取消请求，同一时段出现多条提交409，但未取得每次响应码/桌次映射及手机按钮状态。因此本地缺陷是可复现的相关问题，仍不宣称是W20唯一根因；未执行生产测试订单或资金动作。

## 交付证据（2026-10-10 23:37 CST）

- [PR #353](https://github.com/jingda2008/mbox-ops-platform/pull/353) 已合并；固定标签 `v1.0.0-rc.252` 对应 `cf4fd13780a862cddaae9b8212dadc18fb0361d0`。后续文档提交不移动标签或替换上传源码。
- [PR CI 38060142630](https://github.com/jingda2008/mbox-ops-platform/actions/runs/38060142630)、[标签 CI 38061423766](https://github.com/jingda2008/mbox-ops-platform/actions/runs/38061423766) 与 [Release 38061423695](https://github.com/jingda2008/mbox-ops-platform/actions/runs/38061423695) 均成功。标签验证包含小程序391项、移动浏览器136项、三屏18项、会员8项及数据库/接口检查；重复运行的测试不重复累计。
- 使用标准 `deploy/aliyun/deploy-release.sh`，退出码0，输出 `deployment=complete`。部署清单时间为北京时间23:31:08；最终完成、公网和浏览器校验均在随后通过。镜像摘要 `sha256:0312399721515a278c669b5fd540d326bdadf723cd6cd5bd4f1cb878a8714f80`；平台镜像摘要 `sha256:d04f700b2255973f9ee82e5af1b390393fdb984e36cd2a7e95f802d2630b9d8c`。
- `/api/ready` 独立回读为上述完整SHA/镜像、`production`、schema265、workers healthy；`/`、`/guest?table=W01`、`/reserve`、`/staff/live` 的公网及实际Chromium检查均通过。迁移未变化，微信AppID/门店/`wechat_jsapi`保持原值，Getui仍为false。
- 部署前备份 `/opt/mbox/backups/mbox-20261010T152340Z-PHoQea.dump`，备份、镜像、部署和完成记录均完成OSS上传及回读验证。回滚容器 `mbox-app-rollback-cf4fd13-20261010-233106`，原rc251完整SHA `c142d7cd2a44fbf13b692414fa46da8f27accb98`，保留应用镜像回滚路径。
- 微信官方开发者工具CLI上传 `1.0.0-rc.252` 成功，退出码0，AppID `wxdb9f2dc413484f2d`，包大小1,035,499字节。165个候选文件中163个与最终合并源码逐字节一致，另2个为已核对的项目/生产配置覆盖。候选清单SHA256为 `e3811c60188dbded5f019bea313ba6c3944bcf660d5624ef7244c210e096fc34`，上传前后完整性验证均通过。官方回执仅返回包大小，没有独立上传编号；不编造平台收据。未切体验版、未提审、未正式发布、未真机验收，普通顾客端不能据此视为已获得修复。

本地交付证据位于 `outputs/w20-checkout-20261010/`：`deploy-rc252.log`、`bundle/deployment/deployment-manifest.json`、`postdeploy-ready.json`、`postdeploy-config.json`、`tag-ci-final.json`、`release-ci-final.json`、`wechat-rc252/upload-result.json`、`wechat-rc252/upload-info.json`、上传前后候选校验与源码核对记录。OSS证据前缀为 `mbox/evidence/rc/v1.0.0-rc.252/cf4fd13780a862cddaae9b8212dadc18fb0361d0`。

## 部署时发现的独立运维问题

`OPS-SLS-20261010-01`：原日志采集从10月9日09:24:47起停在 `docker exec ... filter-sls-events.mjs`，持有审计队列锁，阻塞本次激活。先保存队列/游标到服务器发布目录的 `collector-recovery/`，暂时停止采集timer/service，标准部署恢复并完成；之后恢复timer及启动采集。复查不再持锁，游标推进且发布事件合并入待发送队列，但发送器报 `value of Value is not a string (type: float64)`，云端投递尚未恢复。队列保留，未清空或丢弃；不能把恢复定时器称为日志投递修复。该问题需后续修复字段转换、采集超时及积压投递验证。本次不变更不可变发布脚本，不影响已完成的OSS发布证据校验。
