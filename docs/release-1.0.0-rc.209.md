# 1.0.0-rc.209 结账票实收状态与完整合计

用户明确授权提交、合并并部署后台。关联SYS-241。后台新生成整桌/单笔账单按确认收款及待收状态区分预结账单/结账单；完整合计考虑退菜、取消及套餐补差，实收/退款/净收/待收单列，渠道待确认不算实收。补打保持历史快照。

HTML结账及支付凭条统一商场抬头，去除指定冗余说明。门店PrintBridge 1.0.10升级包沿用已确认r4固定字形，需单独在门店Windows安装及实体试打；本次后台部署不代替门店安装。

无新增数据库迁移。G1、G2室外临时4人桌已通过带审计的生产命令生效，配置provision不会删除这两桌。此次主线还包含已在生产overlay运行的服务号/存酒提醒/会员登录修复，部署前需核对运行时与正式构建相符。

## 验证及发布边界

既有176项打印/售后/硬件检查通过，最终候选另含Windows包检查；正式结果以本版CI及发布证据为准。1.0.10升级包15项事务故障注入、5项版本基线和45组打印配置通过；Windows服务/UAC、纸票及商场识别未现场验收。

TC登记继承上一版领域证据，当前候选未逐条现场执行，不将历史通过记作本次实物通过。完成部署后另记标签、SHA、镜像摘要、schema、备份读回及公共入口检查结果。

## rc.209 生产发布结果（2026-09-19 02:25 CST）

- PR #251已合并；标签`v1.0.0-rc.209`，部署提交`6c076ddef187149f4081b57c5859e5dd7b8ea2bf`。PR CI 35376596365、标签CI 35377966901、发布工作流35377967085全部通过。
- 镜像OCI摘要`sha256:0b2013e1858f65a3b37563b205108edf814fb2fb034f0038b9d3ae80dea60d65`；运行平台镜像摘要`sha256:e69f70ecce58ce143cf579bb00fa033b1192a49dc30ac005bfb1613afa3278a9`。
- 通过标准`deploy/aliyun/deploy-release.sh`发布；数据库schema保持220，没有新增迁移。线上`/api/ready`为ready，SHA/摘要/production与发布清单一致；`/`、`/guest?table=W01`、`/reserve`、`/staff/live`通过HTTP及真实Chromium页面渲染验收。
- 备份`/opt/mbox/backups/mbox-20260918T182327Z-NrPOpK.dump`已上传OSS并读回；deployment证据8对象、completion证据3对象验证通过，发布状态completed。回退容器`mbox-app-rollback-6c076dd-20260919-022452`保留。
- 首轮上线后本地发布目录缺少`@playwright/test`，公网HTTP验证通过，但浏览器验证无法启动，标准脚本自动回退rc.208。已在独立发布目录执行`npm ci`，先以原版本验证4条浏览器路由通过，再完整重跑部署并成功。首轮失败/回退记录保留，未跳过门禁或改写不可变标签。
- 上线只读核对：G1/G2仍为室外区域、4人、available；新的收款汇总与checkoutState代码均已在运行镜像内。数量售后开关true和服务号存酒提醒模板在配置源、规范化输出、容器、解析配置中一致。
- VIP3原桌次4单只读汇总：应付/确认收款/净收均3144元，退款0、待收0；既有星驿渠道pending分摊仍合计3144元，与发布前审计一致，未算作第二次实收。本次未改写现金记录或擅自关闭渠道，实际资金核对仍以原审计为准。
- 1.0.10安装包及构建输入已上传rc.209发布资产并重新下载核验SHA256；门店最后报告版本仍1.0.9，未执行Windows安装或实体出纸验收，SYS-241保持现场验收待完成。

证据：独立发布工作树`artifacts/rc209-deployment/`及`.runtime/deploy/v1.0.0-rc.209/deployment/deployment-manifest.json`；实现工作树`artifacts/checkout-print/release-preflight/`。发布页：https://github.com/jingda2008/mbox-ops-platform/releases/tag/v1.0.0-rc.209 。
