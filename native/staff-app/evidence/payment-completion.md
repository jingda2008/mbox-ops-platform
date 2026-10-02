# 日常支付补齐验证 · 2026-09-27

本轮承接前一批20项日常支付清单，代码位于独立原生工作树 `mbox-native-staff-app-20260926`。没有修改网页界面；共享后台增加保护与恢复接口。未提交/推送、未部署、未生产交易、未发布正式App。

## 实现范围

- 两端按份售后与套餐服务端重算，原款分摊、复核/撤回/修订、原商品恢复、未付款停止、未开封退回/损耗、岗位通知、失败退款恢复和现金实际退付。
- 活动独立收银、保护原金额、绑定原付款退款、异人复核执行、迟到旧款、重收授权。旧后台不开新活动写入口。
- 原订单/整桌次/营业日报打印、本人打印请求、设备结果、原快照补打、失败重试与生成恢复。未知出纸不能直接当失败重试。
- 真实支付渠道先查后关，显示活动及整笔合付范围，竞态到账优先，不显示假关单。
- 团购关联预检、并发原键/原券保护、持久平台结果、跨日/句柄过期/本地失败恢复、双人凭证复核/驳回。网页旧接口共用此流程，不绕开App保护。
- 服务器仅存券码摘要/脱敏信息和平台证据，不存原券码/prepareToken。App普通日志剥离券码/签名句柄，放系统安全存储；服务器已有原记录时，设备凭据丢失也能读取原事项恢复，不二次consume。
- 现金人民币总额交接：全店收银点合计、期初衔接、非营业存取、面额计数、差额、撤回重盘、另一人独立确认。新现金使旧盘点失效，外币拒绝混算，差额不伪记收入；通用幂等缓存过期后仍能找回原业务事件。
- 未付款取消/异常结清兼容旧指纹跨营业日恢复；付款并发复用逐一校验服务器关联的员工、原单集合、金额、键和付款标识。
- 财务明确回滚错误允许纠正；未知/旧接口错误保留原请求。原审计防止过期重放覆盖新跟进。
- 收银工具和活动收银折叠分组，避免新按钮挤占桌单列表；沿用品牌墨绿、金色点缀及确认页。

## 验证

| 项目 | 结果 | 证据 |
|---|---|---|
| iOS八组测试 | 385断言通过（44+89+29+36+68+52+50+17） | payment-completion-ios-full-tests.log |
| Android JUnit | 81通过，0失败/错误/跳过 | android/app/build/test-results/testDebugUnitTest；payment-completion-android-build.log |
| 两端最终构建 | BUILD SUCCEEDED / BUILD SUCCESSFUL | payment-completion-ios-build.log、payment-completion-android-final-build.log |
| 服务端TypeScript | 无错误 | payment-completion-server-typecheck.log |
| 选择性单元/接口回归 | 8文件148通过；10个需数据库用例在该调用跳过 | payment-completion-server-tests.log |
| 真实隔离Postgres | 6文件113通过，0跳过 | payment-completion-db.log |
| 两个模拟器 | 覆盖安装、启动、本机演练首页可见 | payment-completion-ios-home.png、payment-completion-android-home.png |

数据库六文件：payment-cashier-extremes.test.ts、cash-handover.integration.test.ts、voucher-operation.integration.test.ts、order-cancellation.integration.test.ts、customer-experience-activity-payment.test.ts、cashier-workbench-query.test.ts。使用官方 `scripts/run-normalized-postgres-tests.mjs` 相同的本地URL校验、随机隔离库/角色、全部迁移、UTC连接和最终清理流程，临时副本只选择这六文件；临时副本已删除。官方完整隔离测试也包含这些文件。

单元与数据库回归有重叠，不能相加称为不重复总数。原生测试验证规则、接口合同和恢复；截图是演练首页，没有真实账号新增页面全流程验收。

## 仍需部署和经营验收

1. 此树为rc.240基线，须整合到包含rc.242的最新生产主线。迁移251/252及配套接口一起发布；没有部署本轮后台。活动/关单能力和核销/交接协议不匹配时阻止新写操作。
2. 双人、双设备、真实支付/平台券、相机、PrintBridge出纸、现金实点、弱网/杀进程/安全存储故障/撤权需独立验收；没有生产资金或券测试。
3. 现金交接为全店人民币合计，实点期间暂停现金收退；确认后新流水衔接下次期初，不是锁死所有收款端。不支持多个独立钱箱或混合币种。
4. 人工平台凭证独立留痕，不伪称自动平台查单或平台已结算；核销不抵桌单应收。平台consume缺金额时沿用原签名查询金额，明确零保留为零，两者有隔离回归。
5. 打印模板/路由和设备安装仍沿现有管理；银行/平台结算导入、任意调账不是核销或财务跟进按钮的功能。
6. 正式签名、渠道发布和真机升级独立验收；FEATURE_PARITY中支付以外未迁移模块继续开放。其他人员改动未清理或发布。
