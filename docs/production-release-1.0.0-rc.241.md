# rc.241 收银复核读取及手机卡片布局生产发布记录

状态：2026-09-27 00:10 CST 标准生产部署完成，公网检查及三沐权限只读收银查询通过。真实手机重新进入和现场员工验收仍待门店确认。

| 项目 | 已核实证据 |
|---|---|
| 故障 | 生产服务、Caddy和数据库均未停止；收银复核查询50单约9.6秒，超过网页8秒限时，页面显示“暂时没有接上收银数据”。历史付款关联在RLS下重复扫描是主要耗时。截图中“原订单权益与归属恢复”卡片被通用两列样式压入38像素窄列。 |
| 修复 | 历史付款查询按已选付款事实主键读取，保持原结果和前端限时；该卡片改为单列全宽。生产只读A/B同批50条原始订单逐字段相同，旧查询9.664秒、候选2.480秒；390px浏览器布局检查无横向溢出。无资金、身份、权限或小程序源码变更。 |
| PR / 主线 | [PR #313](https://github.com/jingda2008/mbox-ops-platform/pull/313)，`6f81921e86d2a425acf0712644f323da648b0ea5` |
| PR CI | [36252036846](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36252036846)成功，包含质量、性能、完整数据库及浏览器流程。 |
| 标签 CI / Release | `v1.0.0-rc.241`；[36253060809](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36253060809)和[36253060836](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36253060836)成功，均绑定同一完整SHA。 |
| 数据库 | 生产schema仍为250；本版无迁移。 |

## 标准部署与线上核对

独立发布工作树完成依赖安装和浏览器启动预检。通过既有运维中继建立仅本次命令使用的TCP通道至生产公网源站`139.196.99.138:443`，保持`https://mbox.shmbox.com`的SNI与证书验证；未改变系统DNS或仓库发布脚本。发布前3次公网TLS检查及旧版四条浏览器路线通过。随后使用`deploy/aliyun/deploy-release.sh`部署，发布前备份、OSS上传读回、候选验证、正式切换、发布后OSS读回均通过。

| 项目 | 结果 |
|---|---|
| 镜像 | `mbox-normalized:1.0.0-rc.241-6f81921`；`sha256:994e5ad5b19d472453ef267573d86d25389eeed658f552f0092d8ea51fb7fecb` |
| 平台镜像摘要 | `sha256:036de443153a4c6ffc9874bc5723168d2245d424bc66e56c5a93c96198937228` |
| 备份 | `/opt/mbox/backups/mbox-20260926T160814Z-X8TBIB.dump`；备份及发布证据的OSS上传读回通过。 |
| 回退 | `mbox-app-rollback-6f81921-20260927-001002`保留，`application_image`回退模式；原rc.240镜像可回退。 |
| 生产健康 | `/api/ready`为`ready`、`production`、schema250、`writeEnabled=true`，SHA和镜像摘要与rc.241一致。 |
| 公网页面 | `/`、`/guest?table=W01`、`/reserve`、`/staff/live`的HTTP和真实浏览器检查通过。 |
| 收银读取 | 三沐实际岗位权限、只读事务：50单2.593秒；请求上限100单实际返回53单2.493秒，均小于页面8秒限时。当前营业日仍为2026-09-26（06:00切换）。无付款、退款或业务数据写入。 |
| 布局产物 | 生产`StaffModulePanel-DI6-oMAF.css`包含`#order-financial-recovery`全宽规则；本地390px Chromium页面检查通过。 |

软件发布及生产只读查询的恢复证据已完成。真实员工在手机内打开收银复核、查看完整卡片并确认操作正常仍是现场验收项，不能由浏览器模拟或SQL计时替代。

私有证据目录：发布工作树`outputs/cashier-review-release-20260926/`及`.runtime/deploy/v1.0.0-rc.241/`，含标准部署日志、只读复测和部署清单；不提交原始业务数据或凭据。
