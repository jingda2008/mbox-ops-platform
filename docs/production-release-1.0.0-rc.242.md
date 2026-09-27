# rc.242 原生补收配套后端生产发布记录

状态：2026-09-27 12:17 CST标准生产切换完成，12:18 CST线上只读能力验证通过。软件部署完成；真实资金、原生真机现场操作仍单独验收。

## 版本及范围

以包含rc.241修复的main整合原生历史补收后端和48项类型修复，保留收银查询性能与手机卡片布局。新增专用补收路径强制原金额/授权校验，工作台提供`supportsGuardedClosedDebtCollection`，保持旧网页请求及幂等回执兼容。无新迁移（schema250），不发布原生安装包或小程序。

| 项目 | 核实结果 |
|---|---|
| PR / 提交 | [PR #315](https://github.com/jingda2008/mbox-ops-platform/pull/315)；`1a9c5851ffd4d5ade8e566e986a2eadc6e406adb` |
| 版本 | `v1.0.0-rc.242` |
| PR CI | [36292060061](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36292060061)，质量、性能、完整数据库及浏览器全部通过 |
| 标签 CI / Release | [36292851277](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36292851277) / [36292851237](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36292851237)，均成功并绑定上述提交 |
| 镜像 | `mbox-normalized:1.0.0-rc.242-1a9c585` |
| 镜像摘要 | `sha256:f66670e80441c99c344a0b6900d2c966b1d0d36af657627b12d623bec851632c` |
| 平台镜像摘要 | `sha256:3c886d0b65a9b213a201e357d82609a93d5135b52e766b00496c91cc2cb919c0` |
| 数据库 | schema250，`migrationChanged=false` |
| 备份 | `/opt/mbox/backups/mbox-20260927T041532Z-IF2u6O.dump`，OSS上传与读回通过 |
| 回滚 | `mbox-app-rollback-1a9c585-20260927-121722`保留rc.241；`application_image`模式 |

## 验证

- 完整`npm run check`通过：常规2232项通过、1156项环境跳过；广范围`tsconfig.server.json`严格检查零错误，旧退款渠道17项回归通过。
- 独立UTC PostgreSQL完整回归2806通过、1容器条件跳过。首次使用本机Asia/Shanghai默认数据库时，两项历史证据指纹测试失败；独立UTC实例复验通过，没有修改测试断言或已有数据库配置。macOS本地发布shell测试缺少`flock`，对应Linux发布系统检查已在云端quality通过。
- 发布机`npm ci`及浏览器启动预检通过。使用既有SSH中继到已核实公网源站的本次进程专用TCP通道，保留HTTPS域名和证书校验；未改系统DNS/代理或发布脚本。
- 唯一部署入口`deploy/aliyun/deploy-release.sh`退出0，`deployment=complete`。发布证据、镜像、备份、部署及完成证据五次OSS上传读回均通过。
- `/api/ready`为`ready`，workers为`healthy`、无失败，tier=production、schema250、SHA/镜像摘要与发布清单一致。
- `/`、`/guest?table=W01`、`/reserve`、`/staff/live`的HTTP与真实浏览器冒烟检查均通过。
- 采用现有三沐岗位的真实有效权限执行只读收银查询：发布前能力标记false，发布后true；发布后查询耗时2411ms，保留rc.241性能修复。未输出订单金额或个人明细，未创建测试收退款、订单或修改营业数据。

NATIVE-20260927-06的类型修复、版本整合、CI、后端发布和线上只读能力验证完成；真实资金和真机操作仍保留独立验收边界，不据此宣称全部App功能已完成。

私有原始证据：发布工作树`.runtime/rc242/`与`.runtime/deploy/v1.0.0-rc.242/`。原生开发工作树原始修改保留，本次未重置、切换或合并其分支。后续发布应基于最新main，避免将旧开发基线直接覆盖线上版本。
