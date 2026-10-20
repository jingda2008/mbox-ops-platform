# rc261 本机改动整合生产发布记录

状态：2026-10-21 01:26:02 CST标准部署完成；01:26后只读业务回查及真实财务页面核验通过。范围为后台、员工Web及schema272。用户明确授权检查本机改动并执行必要提交、合并、部署；原工作目录均保留。

## 不可变身份与门禁

| 项目 | 结果 |
|---|---|
| 标签 / 提交 | `v1.0.0-rc.261` / `95c84a6b91e56facedc81ac0c241c2d9e2334b0f` |
| 镜像摘要 | `sha256:40164aaf0302a101e1941e754cfd7724e5dda94d893d32027f0109dd5c9d930d` |
| 平台镜像摘要 | `sha256:0ecef2e26e048df4adf0ea838d2806d7767e0bd62d16424e8b8dd89033b16230` |
| PR | [378](https://github.com/jingda2008/mbox-ops-platform/pull/378)，已合并 |
| PR / 主线CI | [39458962128](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39458962128) / [39461989904](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39461989904)，通过 |
| 标签CI / Release | [39462040880](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39462040880) / [39462040918](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39462040918)，通过 |
| 数据库 | 270→272，`migrationChanged=true` |
| 备份 | `/opt/mbox/backups/mbox-20261020T172334Z-O6kVqf.dump`，OSS四对象上传/读回通过 |
| 回滚保留 | rc260 / `mbox-app-rollback-95c84a6-20261021-012537`，application_image；新增表保留 |

主线及标签均为数据库3347项通过；主浏览器141项通过/42项条件跳过，三屏18、会员10、服务记录4通过。不同层存在重叠，不相加为独立用例总数。本地修复、首轮失败与旧目录处置见[审计报告](local-code-release-audit-20261021.md)。

## 生产回查

- 唯一部署入口`deploy/aliyun/deploy-release.sh`，dry-run及正式部署退出0；状态最终`completed`。发布产物29对象、镜像4对象、备份4对象、部署11对象、完成3对象均有OSS校验回执。
- 公网ready为production、schema272、预期SHA/摘要；容器healthy、worker无失败；`/`、`/guest?table=W01`、`/reserve`、`/staff/live`接口及浏览器检查通过，TLS验证保留。
- 切换前后19项表指纹全部一致：商品、价格、套餐、预约、权限、积分策略/账户/批次/控制，以及费用明细、周期规则、费用分类、成本中心。10条原费用含更正历史未变，原始金额合计44704363分；不能把含历史更正的原始总和当作经营费用净额。
- 现网FINANCE原本已有费用查看/管理，271为幂等追加，实际新增权限为0；未增加工资及员工管理权限。Caddy配置摘要仍为`44bcf655dbe8b772c7aa7ddea03cb455ee7f9d34d7c4b9c8d64f7ad75d7368b4`。独立官网七语7/7与本地一致，未重发。
- 14个现有凭据员工真实登录后读取桌台目录、G1桌次及历史详情，全部通过并退出。qucan缺少现用PIN，未猜测、重置或扩权。辅助验收脚本首轮把退出响应误写为200，现网和代码约定均为204；仅纠正脚本断言后完成全量回查，原错误记录保留。
- 财务账号fengtaofeng真实页面显示财务仪表盘、单金额费用表单、费用历史入口；当前日期范围3笔有效费用共143211.54元。工资导航未显示，员工管理接口403。G1实页显示当前主服务员李艳、开台确认及实际服务操作；本轮没有交接或伪造服务记录。已退出并关闭临时标签。
- 另一次只读核查时29张营业桌全部具有主服务员及责任历史，没有补写或重推旧桌归属。
- 公众号通知配置/偏好/通知/回执均为空，默认关闭；原integrationWorkersEnabled=false保留。认证、模板、明确同意和实际手机收信未完成，不把后台上线当作通知送达。

## 小程序与现场边界

微信ui.1的官方上传未成功，编译器拒绝通知页面转义后的逻辑表达式。随后[PR379](https://github.com/jingda2008/mbox-ops-platform/pull/379)修复，源码`ac86d92b4a75ba418fafb80284cf8d0808977fc9`的`1.0.0-rc.261-ui.2`官方编译/上传成功，1070334字节；上传后candidate完整性检查为ready（本地完整性信任，不是正式发布证明）。614项小程序测试及[完整PR CI39467064174](https://github.com/jingda2008/mbox-ops-platform/actions/runs/39467064174)通过，合并文件树与受测提交一致。后台镜像不受影响。支付宝23页官方编译通过，工具界面被本机锁屏阻断，未上传。体验版选择、正式审核发布、真机、真实支付退款及出纸仍无本轮证明。

费用跨月筛选在本轮UI自动化中未建立有效输入结果，因此不据此宣称跨月页面验收通过；数据库历史保留与自动化业务测试证据另列。界面显示70个已售单品尚缺成本，当前利润仍为系统标明的暂估，本轮没有填造成本。

## 证据

本机目录`outputs/local-code-release-audit-20261021/`：原始盘点、快照与失败日志，完整本地/PR/main/tag检查，`dry-run.log`、`deploy.log`、release/deployment-manifest、`production-deployment/`OSS回执与状态历史，前后ready/配置/19表指纹、`production-state-comparison.json`、`production-api-verification.json`和财务/服务历史截图。此目录未包含新导出的PIN或私钥。
