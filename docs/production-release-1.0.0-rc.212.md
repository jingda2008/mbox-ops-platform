# rc.212 营业时间调整交付

更新时间：2026-09-20 01:03 CST。按用户确认，营业日自动营业时段为11:00至次日06:00，预约时间不变。

## 实际修改

自动营业日任务在06:00结转上一营业日，11:00再自动开启当天营业日；早间继续处理关日阻塞，不把未结款当作已结清。员工工作台显示11:00—次日06:00。既有手工提前结束营业日、财务切日、收退款及历史记录保留，不新增员工业务强制禁用规则。

预约逻辑、预约界面、微信和支付宝源码均未修改；本次无需小程序上传。没有数据库迁移，schema 221。

## 代码与验证

- [PR #261](https://github.com/jingda2008/mbox-ops-platform/pull/261) 已合并；源代码提交 `cba9adf39f9de892570d222c9ac83c64befc9d2d`，标签 `v1.0.0-rc.212`。
- [PR CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35455200554)、[标签CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35455918045)、[发布](https://github.com/jingda2008/mbox-ops-platform/actions/runs/35455918145) 均成功。标签数据库2305项、浏览器89项及真实HTTP、性能、质量门禁通过。
- 本地定向13项、隔离数据库26项、真实PostgreSQL时间表达式9项通过，覆盖06:00、10:59:59、11:00、跨午夜、跨年及人工切到未来日期。
- 独立工作树 `/Users/jingda/mbox/mbox-operating-hours-20260920`；发布SHA下npm ci及发布前Chromium预检通过。

## 正式部署与服务器回读

标准入口 `./deploy/aliyun/deploy-release.sh` 退出0、deployment=complete。

| 核对项 | 结果 |
|---|---|
| 线上版本 | rc.212 / cba9adf39f9de892570d222c9ac83c64befc9d2d |
| 发布镜像摘要 | sha256:a9959d1de8d67446eec107b2241eb4f0b05811ceeb653799bfeae9d4cf08a61b |
| 平台镜像摘要 | sha256:6e7366d2386c6e0c32860e2d486dadb6f0d1c2216bf05dcefe88815fc1d9833f |
| readiness | ready、production、schema221、workers healthy |
| 服务器营业时间 | openingTime=11:00:00，cutoff=06:00:00，timezone=Asia/Shanghai |
| 跨午夜归属回读 | 2026-09-20 01:02:28 CST 的营业日仍为2026-09-19 |
| 公开入口 | /、/guest?table=W01、/reserve、/staff/live 的HTTP与真实Chromium验证通过 |
| 备份 | /opt/mbox/backups/mbox-20260919T165954Z-duklP9.dump；4个对象OSS读回verified |
| 部署与完成证据 | 8个、3个对象OSS读回verified |
| 回退版本 | mbox-app-rollback-cba9adf-20260920-010130，保留原rc.211 |

本地证据位于 `artifacts/operating-hours/`，不可变发布材料位于 `.runtime/deploy/v1.0.0-rc.212/`。

软件修改及正式部署完成；11:00/06:00真实到点的现场状态尚未发生，不以模拟边界或凌晨回读冒充现场验收。SYS-266保留此项现场关闭条件。
