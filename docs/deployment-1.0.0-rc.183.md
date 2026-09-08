# rc.183 发布保护补修与本轮最终交付

## 关联版本

业务整改见[rc.182记录](deployment-1.0.0-rc.182.md)及[统一实施矩阵](MBOX_AUDIT_REMEDIATION_IMPLEMENTATION_20260908.md)。本版本仅修复SYS-110发布清单类型兼容，不新增业务、数据库或小程序变更；schema保持162。

[PR #196](https://github.com/jingda2008/mbox-ops-platform/pull/196)已于2026-09-08 23:32 CST合并。提交`eb6cb6ebbbb1776ca3e0a45a6c88556000d214b3`，标签`v1.0.0-rc.183`。

PR CI [34244283538](https://github.com/jingda2008/mbox-ops-platform/actions/runs/34244283538)全项通过。标签CI [34245540199](https://github.com/jingda2008/mbox-ops-platform/actions/runs/34245540199)与发布流水线[34245540228](https://github.com/jingda2008/mbox-ops-platform/actions/runs/34245540228)均成功，[正式预发布包](https://github.com/jingda2008/mbox-ops-platform/releases/tag/v1.0.0-rc.183)已生成。

## SYS-110验证

- 原部署清单实际字段为数字1；旧真实回退脚本在对应mock基础设施测试退出1，修复后退出0。
- 明确接受旧0/1及true/false，拒绝其他值。新部署清单写标准JSON布尔，旧清单不篡改。
- 真实回退脚本测试仍验证先启动并核对旧版本、再切流、最后停止新版本；切换异常时恢复原运行服务。
- 相关34项发布链路测试通过；将实际生产清单中的数字字段送入本地修复校验亦通过。没有进行生产回退演练。

## 部署回执

2026-09-08 23:50 CST：不可变发布脚本退出0并返回`deployment=complete`。未修改超时门限，四路由HTTP与浏览器验证本次均通过：`/`、`/guest?table=W01`、`/reserve`、`/staff/live`。

- 公网`https://mbox.shmbox.com/api/ready`：ready，提交`eb6cb6ebbbb1776ca3e0a45a6c88556000d214b3`，production，可写，严格库存，worker healthy，schema162。
- 镜像摘要`sha256:024d4662f22c7fe848230da9ba6dea8b711354e28c3fb76f031ee731649c5505`；平台镜像摘要`sha256:5debb7c3375ffe07f3fff4ba67af1812d9e4426b152f35801094561de57fbc27`。
- 新部署清单读回`previousIdentityComplete: true`且JSON类型为boolean；上版提交为rc.182的`2c40d87f5ab9e1fbaeb204c00be3812c0c856729`，回退容器`mbox-app-rollback-eb6cb6e-20260908-234941`保留。
- 数据库备份`/opt/mbox/backups/mbox-20260908T154807Z-RRwAXL.dump`，备份4对象、发布证据24对象、镜像4对象、部署8对象、完成3对象均经OSS上传读回验证；不删除财务历史。
- 部署回执`.runtime/deploy/v1.0.0-rc.183/deployment/deployment-manifest.json`已取回本地；正式证据前缀`mbox/evidence/rc/v1.0.0-rc.183/eb6cb6ebbbb1776ca3e0a45a6c88556000d214b3`。包含运行配置的原始文件不提交Git。

SYS-110代码/兼容测试/不可变发布/新清单读回已完成；不声称已实测生产回退切流。原rc.182失败记录保留，不能抹去后改称首次部署通过。

## 微信交付边界

两标签之间`miniprogram`和`alipay-miniprogram`源文件无差异。保留已发起的rc.182正式候选，不重复上传。上传任务仍为`confirmation_upload_4004538e-a515-4bd4-ad83-f7ec29438a96`，等待用户在开发者工具确认后继续读取；未确认上传成功、设为体验版或正式发布。公众平台入口受浏览器安全策略限制，不绕过。

真实手机、微信订阅送达、真实收退款、打印与岗位营业验收仍按商业化清单保留；自动化和发布成功不等于全部外部验收。
