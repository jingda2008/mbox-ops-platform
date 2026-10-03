# 1.0.0-rc.245 点单与付款恢复闭环修复

四项已证缺陷均完成代码修复，PR [#324](https://github.com/jingda2008/mbox-ops-platform/pull/324) 已合并。网页与后端于 **2026-10-03 11:21:29 CST** 切换至生产 rc.245，发布脚本与后续回读通过。双小程序完成候选包及官方编译/预览，尚未上传、审核或发布；手机端不能据此认定已更新。

## 逐项状态

| 审计项 | 修复行为 | 验证证据 | 当前交付状态 |
| --- | --- | --- | --- |
| LOGIC-20261003-01 | 网页发送前持久保存原载荷/幂等键，未决时冻结新点单；刷新、重开后独立恢复 | 原201响应丢失→刷新→空购物车→原键200找回同一订单；存储不可用、载荷变化、身份/网络未知和并发重试测试 | 代码合并、CI通过、网页生产部署；现场弱网与真实资金验收仍开放 |
| LOGIC-20261003-02 | 商品备注映射到该版本购物车每一稳定份次，旧接口保留备注字段 | 实际四份备注随订单写入；缺份次或数量变化拒绝静默丢备注；既有套餐与优惠分配回归 | 代码合并、CI通过、网页生产部署；实体票据及终端读回待现场验收 |
| LOGIC-20261003-03 | 服务端和网页对同商品拆行累加数量；保留按商品总量判重策略 | 无备注与按份备注同样409；明确确认同一冲突单后201；套餐选择、备注不自动豁免重复确认 | 代码合并、CI通过、网页/API生产部署 |
| LOGIC-20261003-04 | 双小程序弹窗展示冲突单尾号，明确继续/返回；确认绑定原桌次、版本及新请求 | 两端实际页面方法各6项：取消、改车、换桌不提交；最新冲突重新确认；响应丢失沿确认后的原键恢复 | 代码合并、CI及候选官方编译通过；平台交付和真机验收未完成 |

原始问题及复现见 [2026-10-03代码审计](code-function-audit-20261003.md)。本次未证实重复扣款、超额退款或越权入账事故，也未在生产制造点单、收退款或库存测试。

## 不可变版本与生产结果

| 项目 | 已核实结果 |
| --- | --- |
| 发布标签 / SHA | `v1.0.0-rc.245` / `b729efad3d5b14b1f52184e526860e4beb51d508` |
| 镜像 | `mbox-normalized:1.0.0-rc.245-b729efa` |
| 镜像摘要 | `sha256:95a1d64d143cde4c9c04d41f5b3c426e418eeea82492788bbff249e696288581` |
| 平台镜像摘要 | `sha256:3f8b70743d8c2d020bbd3007c4e8de2c67a637abdc310c5be0018f8bfc94ca50` |
| 数据库 | schema258，无新增迁移；`migrationChanged=false` |
| 发布入口 | `./deploy/aliyun/deploy-release.sh`，`deployment=complete`，退出码0 |
| 代理路径 | 进程专用代理实测出口 `192.236.151.122`；SSH经存证中继到应用主机；保留TLS和严格主机密钥校验，未改系统代理或DNS |
| 生产readiness | `ready`、`workers=healthy`、`tier=production`，SHA/摘要/schema与固定标签一致 |
| 入口验证 | `/`、`/guest?table=W01`、`/reserve`、`/staff/live`：HTTP与真实Chromium均通过 |
| 新鲜备份 | `/opt/mbox/backups/mbox-20261003T031607Z-Y5lBKo.dump`，OSS完整回读通过；本机临时中转副本已由脚本删除 |
| OSS存证 | 发布27对象、镜像4、备份4、部署11、完成3，全部verified；使用`EcsRamRole` |
| 回滚基线 | rc.244 `e67b327eedd7693a5eb31317976eaa9939ab9c0b` / schema258；保留 `mbox-app-rollback-b729efa-20261003-112127` |

[GitHub Release](https://github.com/jingda2008/mbox-ops-platform/releases/tag/v1.0.0-rc.245) 与 [生产回读汇总](/Users/jingda/mbox/outputs/code-logic-audit-20261003/rc245-validation/deployment-readback-summary.json)、[部署清单](/Users/jingda/mbox/outputs/code-logic-audit-20261003/rc245-validation/deployment-manifest.json)、[OSS回读](/Users/jingda/mbox/outputs/code-logic-audit-20261003/rc245-validation/production-oss-readback.json) 保存版本证据。ready和入口检查只证明运行及页面可达，不证明生产历史账平或现场整班通过。

## 验证与CI

本地 `npm run check` 通过：常规2303通过/1273环境跳过，小程序355项；真实受限LOGIN数据库2964通过/1项Docker维护恢复演练跳过；新增真实数据库浏览器3项与既有点单支付浏览器29项通过。新增网页/后端19项及小程序12项包含于上述集合，不重复累计。修正共享购物车前置数据后，既有双设备用例接三个新闭环用例连续执行4项通过。本地日志对应修复候选树；最终提交由下列不可变CI及发布产物验证。

| 检查 | 结果 |
| --- | --- |
| 最终PR CI [37090276175](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37090276175) | success；数据库2965项、维护账号实际LOGIN130项、主浏览器115通过/36条件跳过、三屏18项、会员8项；质量、性能及verify通过 |
| 合并SHA CI [37091087490](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37091087490) | success，SHA `b729efad` |
| 固定标签CI [37091115788](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37091115788) | success，同一SHA |
| Release [37091115839](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37091115839) | success，同一SHA，已验证镜像和质量证据 |

首次PR CI `37089050622` 的质量、性能及数据库检查通过，新增两个浏览器用例因既有共享购物车留下3件商品而在“加入商品”前超时：页面实际为“增加”按钮，测试误设为空购物车。修正仅针对测试前置数据：通过真实API读回版本/代次后清空、验证空车并刷新；业务断言未放宽。首次失败日志、快照与最终通过日志均保留于 [证据目录](/Users/jingda/mbox/outputs/code-logic-audit-20261003/rc245-validation)。

## 小程序交付边界

两个最终候选均来自合并SHA `b729efad3d5b14b1f52184e526860e4beb51d508`。

- 微信：正式AppID `wxdb9f2dc413484f2d`、生产API、禁用开发数据回退；162源文件逐一匹配，两个构建覆盖文件单独核验。候选门禁为`ready / candidate / local_integrity_only`；官方预览包1,022,332字节，最终候选文件与已预览包一致。[候选与来源证据](/Users/jingda/mbox/outputs/code-logic-audit-20261003/wechat-rc245-final)。
- 支付宝：正式AppID `2021006196615276`，150源文件；官方编译23页通过，最终worker1,171,447字节。[候选与来源证据](/Users/jingda/mbox/outputs/code-logic-audit-20261003/alipay-rc245-final)。原先本地较早编译worker1,171,272字节不能替代最终候选值。
- 支付宝范围纠正：`alipay-miniprogram/config/index.js`在所有配置合并后强制关闭身份、支付、手机号、通知；本次重复加单修复是该页面方法在能力启用条件下的逻辑修复，不等于现网支付宝支付开通。平台适配与证据缺失时继续失败关闭。
- 平台上传、体验版选择、审核、发布、已交付包真机验证均未执行；不将官方编译或预览写成平台上线。操作期间曾遭遇Mac锁屏，后续界面已可读取。

真实资金、打印、双设备、整班及经营TC沿原清单保持开放，工程回归不替代现场验收。

以最终候选证据运行现有`upload`阶段校验，结果为`blocked`，见 [逐项缺口](/Users/jingda/mbox/outputs/code-logic-audit-20261003/wechat-rc245-final/upload-gate-gap.json)。当前材料没有绑定本版本的iOS/Android真机附件、独立签名的平台验收证明，以及域名/隐私/模板平台附件和上传回执。该结果是候选材料不满足上传验收口径，不表示平台后台一定未配置；未伪造附件或复用旧版本验收冒充本版证据。
