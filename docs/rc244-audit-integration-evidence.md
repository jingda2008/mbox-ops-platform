# rc.244 审计修复集成证据

当前状态：2026-10-03 09:45 CST，代码已合并，rc.244生产部署及公网验证完成。下方01:44/02:07记录保留为历史过程；最新证据见文末。

- [PR #320](https://github.com/jingda2008/mbox-ops-platform/pull/320)，合并提交 `f654da209d95403e5430f9d6f4bac72e5e5f8fe8`。
- 验证提交 `3debf5c1cbb0abc98f9af5245b8283dff2ce1cd1`，与合并提交文件树相同；远端 #319 已集成。
- [最终完整CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37040743443) 全绿。数据库337套件2964项通过，跨维护账号实际LOGIN另130项通过。浏览器主流程112项通过、36项条件跳过，三屏18项、会员扫码/到店奖励8项通过，质量与负载检查通过。
- 首轮浏览器CI发现额外回归：主管取消查询分支缺工作站限制，吧台显示后厨任务；修复于3debf5c1。没有放宽浏览器断言；专项数据库12项通过，本地营业流程29项通过、1项既有跳过。
- 安卓0.4.0-rc.2/build7：262项单测通过，lint无错误，APK构建和签名校验通过。客户端来源bde49992；后续补丁仅修改后端和文档，客户端源代码相同。
- APK SHA256：`9559235f09f979570a2d57b3b1e584293662990f9a4143b07a64accf4a09ff59`。仍使用原预览签名；正式分发和自动更新渠道未发布。

四项原审计修复：无效区域配置须通过原幂等域证明未提交；权限移交后仅允许本人精确原回执，禁止新写/概览；原生口令时间保留秒；PIN/口令用服务器HMAC绑定载荷。附加第五项为共享出品查询工作站隔离。真实营业现场TC未因自动化通过而关闭。

发布阻塞证据：现有SSH别名经`139.224.254.60:6122`转发时，在认证前返回`Connection closed`；未修改系统代理、DNS或服务器配置。独立发布目录已npm ci（0漏洞）及浏览器启动预检通过，公网HTTP/浏览器正式冒烟仍有间歇连接/超时失败。API只读就绪仍是rc.243、schema251、SHA33168ef7、workers healthy。没有生产写入，备份、迁移、切流及OSS完成证据均不能标记完成。

原始本地证据保存在发布/开发目录的`.runtime`及本机交付目录，不将凭据、APK、构建缓存或未经审查的运行日志提交入库。后续部署须核对不可变标签、镜像摘要、备份/OSS读回及公开网页；后台部署与员工覆盖安装APK分别确认。

## 2026-10-03 02:07 CST 发布包完成，部署受阻

- 标签 `v1.0.0-rc.244` / `e67b327eedd7693a5eb31317976eaa9939ab9c0b`；[标签CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37042949372)及[发布流程](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37042949440)全部成功。
- [固定候选发布包](https://github.com/jingda2008/mbox-ops-platform/releases/tag/v1.0.0-rc.244)已生成。镜像`mbox-normalized:1.0.0-rc.244-e67b327`，摘要`sha256:c5fded05c01733d3f66b3dc73cc7d621a45f22cfa5805517d7aa6a3ddda58b9a`，平台摘要`sha256:63fe8a83253cafb32d3e75aa1aa649b866fe5315ef9006fb34b3cf31d9db172a`。
- 独立发布目录通过npm ci和浏览器预检；本次进程经既有代理保留TLS验证后，原线上rc.243四个入口的正式HTTP及浏览器冒烟全部通过，先前公网验证阻塞已恢复。
- 实际运行唯一入口`deploy/aliyun/deploy-release.sh`：发布清单/归档/证据校验及敏感内容检查通过，第一条应用主机SSH检查经`139.224.254.60:6122`中继在认证前断开，退出255。没有执行远端备份、数据库迁移、候选启动或切流，不能标为部署完成。
- 停止后只读检查：`ready`、workers healthy，生产仍为`33168ef756cb2a8c7761ba134e8660d947d68614`、schema251、原镜像`sha256:d1bde0f9d78b3660b8e7e040894a10962421f41f18b79aeaa014f3647de3408d`。

剩余条件是恢复既有SSH通道或提供经核实的新连接方式，然后从固定标签重新执行标准部署链。仍须取得新的备份/OSS读回、schema258候选健康、切流后就绪及公开网页证据。安卓build7为预览签名；手机安装与后端上线分别确认，真实营业验收继续开放。

## 2026-10-03 09:45 CST 代理部署完成

用户授权改用代理接入后，核实原 Clash 规则将域名和中继 IP 送往 DIRECT；此前仅设置本地 HTTP/SOCKS 端口并不等于使用代理出口。本次建立仅供发布进程使用的本地代理实例，强制使用现有节点并绑定物理网卡，避免 TUN 回环；出口实测为 `192.236.151.122`。SSH/SCP/rsync 均使用进程级配置，保留已知主机密钥校验；HTTPS 保留证书验证。未修改系统代理、DNS、原 SSH 配置或仓库部署脚本。

- 发布前本地代码干净；重新 fetch 后 main 为 `680c4f18`，相对固定标签仅三个发布记录文档变化，无未集成业务代码。
- 唯一部署入口 `./deploy/aliyun/deploy-release.sh` 完整执行，退出码 0，输出 `deployment=complete`。应用服务器身份和公网域名解析一致。
- 生产标签 `v1.0.0-rc.244`，完整 SHA `e67b327eedd7693a5eb31317976eaa9939ab9c0b`；镜像摘要 `sha256:c5fded05c01733d3f66b3dc73cc7d621a45f22cfa5805517d7aa6a3ddda58b9a`，与发布清单和线上就绪完全一致。
- 切流清单时间 `2026-10-03T01:41:56Z`（北京时间09:41:56）；数据库由251升级至258。后续公网就绪 `ready`、`production`、workers `healthy`。
- OSS 回读：发布证据27个对象、镜像4个对象、数据库备份4个对象、部署证据11个对象、完成证据3个对象，均 verified。备份/部署/完成三份报告再次只读核对，身份模式为 EcsRamRole。
- 标准 `npm run release:verify` 的 HTTP 与真实浏览器检查全部通过：`/`、`/guest?table=W01`、`/reserve`、`/staff/live`；没有绕过断言或 TLS 校验。
- 备份 `/opt/mbox/backups/mbox-20261003T013719Z-bEXJSM.dump`；旧版本回滚容器 `mbox-app-rollback-e67b327-20261003-094154` 保留。应用回滚不能撤销已写入的经营事实或新增数据库结构。

证据：发布机 `.runtime/deploy/v1.0.0-rc.244/deployment/deployment-manifest.json`，交付目录 `outputs/rc244/` 的同名清单、`post-deploy-ready.json` 和 `deploy-via-proxy.log`；服务端 `/opt/mbox/releases/e67b327/` 的备份/部署/完成 OSS 验证报告。上述“部署受阻”记录为历史状态，当前已解除。

本次完成后端上线，Android build7安装包未变；员工手机仍需安装该包，正式签名、线上更新分发渠道及真实收退款、打印、双设备、整班验收仍开放，不能将上线健康视为全部营业验收完成。
