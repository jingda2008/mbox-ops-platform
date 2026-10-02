# 历史欠款实际补收 · 2026-09-27 10:19 CST

## 已实现

两端原单全额现金/POS/外部收款表单；原桌次/授权/金额绑定，实收与找零分离，原凭证与终端/外部方式/说明，二次确认。服务端闭合原桌次保持关闭，不激活新增履约，收款当前营业日与原订单日分开。

专用 `/api/payments/manual/closed-debt` 强制closedDebtGuard保护在原单锁内执行；不改旧网页请求的业务/幂等语义。App依赖supportsGuardedClosedDebtCollection，旧服务器不提供则禁用；混合版本误路由到旧节点时专用路径不存在，不会被忽略保护字段后入账。明确未入账的历史金额/授权冲突可确认失败后刷新；其他资金未知继续保留原请求，原员工原键恢复。

## 最终验证

- iOS：29 core + 36 live + 68 order + 89 cashier + 17 update = 239项断言通过（ios-historical-*-tests.txt、ios-historical-tests.txt）。新增31项覆盖旧服务器、三种收款凭证、实收/找零、权限拒绝、原表单金额/桌次/授权变化、回执错配、丢回执恢复与明确未提交白名单。
- Android：46个JUnit通过，0失败/0错误/0跳过（historical-TEST-*.xml）；本批新增4个测试组。
- 后端：payment-api、cashier-workbench-query、payment-command-service、payment-security-policy，92通过/10环境跳过（historical-backend-unit.txt）。
- 隔离PostgreSQL：closed-debt-recovery与batch-closed-debt-recovery共33通过（historical-postgres-tests.txt）。使用仓库隔离数据库runner的临时副本仅限定这两个测试文件；localhost独立随机数据库、受限NOSUPERUSER/NOBYPASSRLS登录，250迁移，结束已清理数据库/角色，临时runner已删除。未连接生产。
- 数据库新增测试验证确认金额不同/原授权失效时0新增记录，替换授权后旧请求拒绝、正确请求全额入账一次、重复原键回放、同键改guard冲突、桌次仍closed。既有用例同时覆盖旧无guard网页收款/原日/当日账本和跨门店权限。
- 双端构建通过，日志ios-historical-build.txt、android-historical-build.txt。iOS实际调试代码SHA256 `fda8e08a3d77d6a89b5068ff92d0979a7053081886d18fac02696b1a5a4ddd15`；Android APK `ab65efc3ef615236261e070cc9d15d63d0cdc38f14d39b4b8455a5cfb5a1e321`。
- 变更服务端文件oxlint通过。整体 `tsc -p tsconfig.server.json --noEmit` 退出2，48项报错，与git HEAD临时提取的未修改源码基线一致（仅工作目录/行号归一化）。证据historical-server-types*.txt、historical-type-comparison.txt。**不是整体服务端类型检查通过**。

## 边界

仅本地开发0.2.0（2）；网页UI未改，服务端新增兼容字段/校验/能力标记及错误类型，尚未提交推送部署。没有真实账号付款或生产资金写入；新增表单两端真机逐按钮/实际凭证、真实升级及整体营业验收未完成。部分历史补收、付款通道关闭/待定重试释放、所有金融撤权/未知恢复等仍在FEATURE_PARITY，不声明全部闭环。

最终还补了失败确认后清除旧收银/付款新鲜度，强制刷新原单。专用路径版重新通过两端收银合同、Android全套、双端构建和全部本批后端/数据库测试后才安装。

## 最终安装与检查

专用接口最终版本已覆盖安装：iOS 2EA116D3-018A-4D1E-9BB0-A908E2F29F7A，com.mbox.staff.native 启动PID42506；Android emulator-5554安装Success，com.mbox.staff.nativeapp/com.mbox.staff.MainActivity启动成功。没有卸载/清除原数据。安装启动不代表新增收银页面真机或真实资金验收。

商业化台账验证verified=true（380历史事项），git diff --check及维护的未跟踪源文件空白检查通过；src/normalized-ui与src/main.tsx无差异。临时数据库runner已删除。
