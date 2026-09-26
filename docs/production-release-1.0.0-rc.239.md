# rc.239 按钮闭环修复发布记录

状态：2026-09-26 09:40:45 CST后端标准生产部署完成，公网HTTP/浏览器与线上读回通过。微信开发版已上传；小程序正式发布及现场实机验收仍待完成。

| 项目 | 已核实证据 |
|---|---|
| 修复 | 取餐受限账号异常原出品入口改为明确经理交接；有权限账号可到达原任务；微信/支付宝清空购物车确认固定原桌次及版本 |
| PR及主线 | [PR #309](https://github.com/jingda2008/mbox-ops-platform/pull/309)，`17717537ce3e1871c43f615815d237e7a0dfccff` |
| 标签 | `v1.0.0-rc.239`，schema248，无迁移 |
| 本地 | 两端22项购物车回归、6项浏览器、完整check及支付宝23页官方编译通过 |
| PR CI | [36207016883](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36207016883)成功；数据库2755项通过，浏览器主组107通过/29配置跳过及三屏专项18通过，HTTP和压力检查通过 |
| 标签CI / Release | [36208052870](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36208052870) / [36208052736](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36208052736)，均成功 |

发布机在独立工作树完成npm ci和真实浏览器启动预检。直接公网TLS偶发超时，复用既有运维中继建立仅本发布命令使用的HTTPS通道，目标为经服务端DNS重新核实的公网139.196.99.138；保持原HTTPS域名和证书验证。三次TLS预检及旧版四条页面浏览器预检通过，未更改系统DNS或代理。标准发布入口保持`deploy/aliyun/deploy-release.sh`，无手工流量切换。

微信开发版上传回执及正式发布限制见[小程序交付记录](miniprogram-upload-20260926-rc239.md)。现场平板、真实支付及小程序正式发布不因后端部署自动完成。

私有证据：`outputs/button-closure-release-20260926/`；原始业务数据或凭据不提交Git。

## 上线读回与回退

| 项目 | 结果 |
|---|---|
| 镜像 | `mbox-normalized:1.0.0-rc.239-1771753`；`sha256:6617275568e18d9bccdd72748b2e6f83d2b5d6149f4de425bd5012916a92c271` |
| 数据库 | schema248，`migrationChanged=false`；未进行业务数据修正 |
| 备份 | `/opt/mbox/backups/mbox-20260926T013845Z-N5vQXM.dump`；备份及镜像/发布证据OSS上传、读回均验证成功 |
| 回退 | `mbox-app-rollback-1771753-20260926-094043`；原提交`e34adcde6c8afbab5571f1207523dbddc42214e9`保留 |
| 健康 | `/api/ready`为ready、production、writeEnabled=true；SHA及摘要匹配，worker健康 |
| 公网页面 | `/`、`/guest?table=W01`、`/reserve`、`/staff/live`的HTTP和浏览器验证通过 |
| 原开关 | 后厨批次、三屏流程及数量售后三项均保持true |
| 上线产物 | `ThreeScreenWorkspace-CM4-KH7F.js`包含经理交接、未决回执提示及正常取餐提示；只读检查通过 |

取餐平板需刷新后进行现场验收；异常交接的完整点击流程已在真实隔离登录浏览器验证，生产本轮未制造异常出品、制作、取走或真实支付。不能以静态产物读回代替现场实物验收。BTN-20260926-02的软件部署完成，现场岗位确认继续保留。
