# M-BOX 1.0.0-rc.253 小程序点单与付款恢复

顾客确认下单后购物车发生变化、离开页面再返回或切换桌台时，旧异步结果可能覆盖新购物车、保留按钮锁或清理另一笔订单的恢复记录。本版逐条修复MINI-AUDIT-20261010-01—08：固定最终确认草稿；按操作归属释放锁；只接纳单调购物车版本；准确处理冲突回读失败；限定旧订单恢复清理；换桌重置账单显示锁；空车继续恢复原未知提交；原生支付回调只作用于原付款。

微信与支付宝同结构修复同步，支付宝线上支付开关保持关闭。本次用户授权提交、合并、标准后台部署和微信开发版上传，不包含微信审核/正式发布、支付宝上传或真机/现场资金验收。无后端运行逻辑或迁移变更，schema265及已有Android/Getui配置不变。W20历史唯一根因仍未取得设备证据，不把可复现的本地问题当作历史资金影响。

本地验证：新增86项时序回归全部通过；同一测试回跑原HEAD为68失败/18通过（不是68个缺陷）；小程序总477项通过；全项目检查通过，项目测试2463通过、1480环境依赖跳过；微信静态167文件、支付宝23页面/13平台测试及官方编译通过。360/375/390px双端样式夹具证明空车恢复按钮可见，非原生或真机验收。

逐条修复和原始复现见[审计报告](miniprogram-state-audit-2026-10-10.md)。原始证据位于工作区父目录`outputs/miniprogram-state-audit-20261010/`，本轮交付证据保存在`outputs/miniprogram-rc253-20261011/`。提交、合并、标准后台部署与微信开发版上传已完成，证据如下；固定标签不随文档补充移动。

已知独立运维项OPS-SLS-20261010-01继续待修：日志队列保留，但云端发送存在float64字段类型错误；本版不扩大到该修复，OSS发布证据仍须独立通过。

## 交付证据（2026-10-11 01:15 CST）

- [PR #355](https://github.com/jingda2008/mbox-ops-platform/pull/355) 已合并；固定标签`v1.0.0-rc.253`指向`18eb81b7491929a670d7aa04bf530ef8b1c4790a`。修复提交`852f259e6c5609564d3a6a9d8452334ac00c9e6f`与合并提交的Git tree一致。
- [PR CI 38067123837](https://github.com/jingda2008/mbox-ops-platform/actions/runs/38067123837)、[主线CI 38067776372](https://github.com/jingda2008/mbox-ops-platform/actions/runs/38067776372)、[标签CI 38068283408](https://github.com/jingda2008/mbox-ops-platform/actions/runs/38068283408)、[Release 38068283420](https://github.com/jingda2008/mbox-ops-platform/actions/runs/38068283420) 均成功。标签检查包含移动浏览器136项、三屏18项、会员8项及数据库/接口验证；小程序477项，重复运行不累计为新测试。
- 标准`deploy/aliyun/deploy-release.sh`最终退出0并返回`deployment=complete`。部署清单时间北京时间2026-10-11 01:11:04；最终完成及公网检查随后通过。镜像`sha256:c0b21e77d49e521174ca0f4b09a61bd601039093e153c01684b1e45f52eba7d0`，平台镜像`sha256:faa786f8bcb6af2b61b6153a21cf42ed2d27aa505e8264cd71a64a3e19928c44`。
- 独立`/api/ready`回读与上述SHA/镜像一致，`production`、schema265、workers healthy；`/`、`/guest?table=W01`、`/reserve`、`/staff/live`公网HTTP及真实Chromium检查均通过。门店、微信AppID、Getui false与部署前一致；门店/商品配置摘要相同、无迁移变化。
- 备份`/opt/mbox/backups/mbox-20261010T170712Z-qOczdn.dump`，备份、镜像、部署及完成证据均通过OSS上传/回读；回滚容器`mbox-app-rollback-18eb81b-20261011-011101`，保留上一版rc252提交`cf4fd13780a862cddaae9b8212dadc18fb0361d0`。首次部署在备份转发前遇SSH banner超时、退出255，当时线上仍健康rc252；保留原日志后重试同一标准入口成功，没有手动绕过任何门禁。
- 微信官方DevTools CLI上传`1.0.0-rc.253`成功、退出0，AppID`wxdb9f2dc413484f2d`，包1,038,579字节。165文件中163个与合并源码一致，2个项目/生产配置覆盖已核对；上传前后完整性校验通过，候选清单SHA256`1fe6886e955f73abc7c5cc0579fe1f3f081a3dbbe2823bd2f9f674fff6a8f373`。回执仅给出包大小，没有独立上传编号。仅开发版上传，未选体验版、未提审、未正式发布、未真机验收，普通顾客端不能据此视为已获得修复。支付宝未上传。

本地证据位于`outputs/miniprogram-rc253-20261011/`：四份`*-ci-final.json`、`pr355-merged.json`、`deploy-rc253.log`、首次超时日志、`bundle/deployment/deployment-manifest.json`、`postdeploy-ready.json`、`postdeploy-config.json`及`wechat-rc253/`上传/源码/完整性报告。OSS前缀`mbox/evidence/rc/v1.0.0-rc.253/18eb81b7491929a670d7aa04bf530ef8b1c4790a`。

## 本轮发现的合并流程风险

`OPS-CI-MERGE-20261011-01`（P2）：北京时间00:28:02设置PR自动合并时GitHub直接完成合并，数据库/浏览器检查当时未结束。只读API确认main为`Branch not protected`且有效规则为空；不能把`--auto`视为必然等待CI。完整PR CI随后成功后才创建固定标签，标签CI/Release通过后才部署，本次没有把未验证发布包切到线上。主分支规则本轮未修改，风险仍待仓库管理员处理：后续应先明确核验所有必要检查，配置保护并用待执行/失败PR验证。
