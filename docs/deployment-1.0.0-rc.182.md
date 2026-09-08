# rc.182 全系统审计整改发布记录

## 代码与构建

- 用户授权：全部修复、提交合并、部署、微信体验版上传。Android独立App不在范围内。
- 工作树：`/Users/jingda/mbox/mbox-cashier-terminal-history-fix-20260908`；起点`bc515baa7dd880ca0f8b7913193631b7ec90f469`当时与远端main一致。
- 整改追溯：[需求总纲](MBOX_AUDIT_REMEDIATION_REQUIREMENTS_20260908.md)、[实施矩阵](MBOX_AUDIT_REMEDIATION_IMPLEMENTATION_20260908.md)。SYS-088—108及新增SYS-109、相关R01—18/V01—09已实施，外部验收风险不整体关闭。
- [PR #195](https://github.com/jingda2008/mbox-ops-platform/pull/195)于2026-09-08 22:57 CST合并；发布提交`2c40d87f5ab9e1fbaeb204c00be3812c0c856729`。
- 标签及[Release](https://github.com/jingda2008/mbox-ops-platform/releases/tag/v1.0.0-rc.182)：`v1.0.0-rc.182`；schema仍为162，无新增迁移。
- 最终PR CI：[34240524439](https://github.com/jingda2008/mbox-ops-platform/actions/runs/34240524439)通过。
- 标签CI：[34241824050](https://github.com/jingda2008/mbox-ops-platform/actions/runs/34241824050)通过；发布流水线[34241824120](https://github.com/jingda2008/mbox-ops-platform/actions/runs/34241824120)通过。
- 镜像摘要：`sha256:1c90d59c2f469998cdbdf7b82280c62bfbae68d44be1bf3b8fb464213071e241`；平台镜像摘要：`sha256:b448bf1f0b0550e1dbb9c07ff895c577fc5a96bc23b4efb22c5d4de332770dc2`。

## 验证边界

本地独立PostgreSQL回归1405通过/1既有跳过，浏览器39通过，微信发布专项103通过，支付宝13项平台测试通过；最终提交及合并提交分别通过远端完整CI。

原生21路由、非空会员/权益/积分、长标题套餐、多份选择与逐份编辑、加购收起介绍且确认区可见、取消不增购物车、服务201响应离页晚回恢复、优惠券断网错误与恢复均已获取截图和读回。129个受保护文件源副本哈希一致。选择长标题时读取官方工具输出曾被截断，保留失败记录；随后读取已应用状态继续同一场景通过，未重复业务提交。

证据在忽略目录`artifacts/audit-remediation-native/`；测试数据与凭据不提交Git。以上不替代真实iPhone/Android、订阅送达、真实支付退款、实物打印和营业岗位签字。

## 生产部署

23:11 CST预检通过，随后发布证据24对象、镜像4对象、备份4对象、部署8对象和完成3对象均经OSS上传与读回校验。备份`/opt/mbox/backups/mbox-20260908T151326Z-YsGsvy.dump`，保留原rc.181容器。

23:15 CST左右已切到rc.182，公网readiness的提交/摘要一致、schema162、可写、worker healthy。部署脚本最终外部smoke因`/staff/live`超时退出1；随后不改超时门限重跑同一`release:verify`，四路由HTTP与浏览器均通过。期间另一次curl出现SSL_ERROR_SYSCALL，说明存在访问链路瞬时失败；不能单凭此定为业务代码缺陷。

本次回退门禁暴露SYS-110：部署清单`previousIdentityComplete:1`与回退脚本只接受true/false不兼容，脚本在任何容器/流量变更前退出；新版本仍在服务，未虚报回退成功。实测旧脚本配数字清单测试失败，补兼容后真实脚本mock基础设施回退流程及34项发布测试通过。rc.183将发布此保护修复，不原地修改rc.182不可变文件。rc.182运行与验证已恢复，但整次部署命令退出1的原始事实保留，最终交付以rc.183的新完整发布回执为准。

## 微信上传

- 正式候选：`/private/tmp/mbox-rc182-upload.6H7W94/candidate/miniprogram`，来源为上述合并提交。
- AppID `wxdb9f2dc413484f2d`，API `https://mbox.shmbox.com`；正式身份、域名校验开启，无默认桌码/开发身份/开发数据兜底。
- 清单SHA256 `5690b141f5ec9cd11e636cfbd38a59c711c9e7d40469b461dbf040e45a0529cc`；candidate阶段校验ready，仅证明本地包完整性。
- 已通过官方开发者工具发起上传`1.0.0-rc.182`。回执为`pending`、等待用户确认，任务`confirmation_upload_4004538e-a515-4bd4-ad83-f7ec29438a96`。用户继续前不轮询、不重复上传。
- 尚未确认上传完成或设为体验版。公众平台页面被浏览器安全策略阻止，不绕过；体验版选择需用户在公众平台完成或提供允许的正式操作通道。未提交微信审核或正式发布。
