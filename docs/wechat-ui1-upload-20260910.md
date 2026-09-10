# 微信视觉版上传记录

记录时间：2026-09-10 17:22 CST。

- 工作树：`/Users/jingda/mbox/mbox-member-growth-reliability-20260909`。
- 功能提交：`1002d21fab781a368a0a3df58493faf1cef8279f`。
- [PR200](https://github.com/jingda2008/mbox-ops-platform/pull/200) 已合并，主线提交 `babb3e791a4cfec40d9e717053c6e946a6ac2744`。
- [CI34459206113](https://github.com/jingda2008/mbox-ops-platform/actions/runs/34459206113) 质量、数据库/HTTP、浏览器、性能、verify通过；无需项跳过。
- 本地完整check、6组布局测试、支付宝官方23页编译通过。CSS测试不是原生全状态验收。
- 微信正式AppID `wxdb9f2dc413484f2d`，API `https://mbox.shmbox.com`，生产模式，开发身份/默认桌码/数据兜底关闭。
- 工程 `.runtime/wechat-ui1-babb3e7/miniprogram`；候选清单绑定合并SHA，148文件与预览候选一致，上传后哈希验证通过。
- 官方开发者工具上传版本 `1.0.0-rc.184-ui.1`，回执 `✔ upload`，退出码0，941811字节。
- 上传日志 `/tmp/mbox-ui1-upload.log`，包信息 `.runtime/wechat-ui1-babb3e7/upload-info.json`；仅证明上传成功，不含体验版选择证明。
- 预览第一次因临时二维码路径拒绝失败，更换至候选目录后成功，日志 `/tmp/mbox-ui1-preview-retry.log`。

本轮无后端/数据库部署，无支付宝上传，无微信正式审核发布。体验版选定仍未核实；此前微信后台访问策略限制不绕过。SYS-158原生完整状态验收继续保留。
