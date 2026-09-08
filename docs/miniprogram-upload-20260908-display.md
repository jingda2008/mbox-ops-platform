# 小程序显示修订上传记录

- 代码 PR：https://github.com/jingda2008/mbox-ops-platform/pull/193
- 合并提交：`f809d2d1c44f0bed5f1d2b764f0ddbaaa8405485`
- PR CI：`34193935532`，质量、数据库、浏览器和性能检查通过。
- main CI：`34193975717`，结论 success。
- 本地：149项Node测试、微信静态检查通过；支付宝21页5tab一致性、13项适配测试和官方编译通过。
- 微信AppID：`wxdb9f2dc413484f2d`
- 上传版本：`2026.09.08.1`
- 上传方式：微信开发者工具官方CLI，返回 `✔ upload`，退出码0。
- 上传包大小：874675字节。
- 独立候选：`/private/tmp/mbox-mini-display.cbLmrK/candidate/miniprogram`
- 候选清单SHA256：`62120fc2360a096f4e2b2c472260f5c05296237b17cfcde422ea2bfb0c0cc11d`
- 候选校验：`candidate / ready / local_integrity_only`；不冒充平台独立签名或商业验收。
- 上传信息回执：`/private/tmp/mbox-mini-display.cbLmrK/upload-info.json`（临时文件，非长期归档）。

## 明确边界

已提交、推送、合并并上传微信开发版本；**未核实或设置体验版**。当前工具安全策略禁止访问微信公众平台，必须由用户在后台选择该版本设为体验版。Mac锁屏也阻止了本次上传候选的画面复查。

未部署后端，未上传支付宝小程序，未提交微信审核或发布正式版。多选项有车场景、大字体、iOS/Android真机仍待验收。测试活动实际结束于09-11 06:00，本次没有修改或停用运营数据。
