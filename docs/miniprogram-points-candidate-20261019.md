# 积分小程序候选准备记录

记录时间：2026-10-19 18:33 CST。用户要求现场到店后再验，本轮只核对上传记录并准备最新版本。

## 上传证据结论

- 最后找到的成功回执为2026-10-11 00:36 CST的`1.0.0-rc.253`，提交`18eb81b7491929a670d7aa04bf530ef8b1c4790a`。官方CLI退出0、日志含upload成功、包大小1,038,579字节，记录未选体验版/提审/发布。
- 对应实际上传候选和Git版本均无“使用积分抵扣”。未找到更新的积分版上传回执。
- 证据位于`/Users/jingda/mbox/outputs/miniprogram-rc253-20261011/wechat-rc253/`的`upload-result.json`、`upload-info.json`、`upload.log`及候选文件。
- 微信平台页面访问受电脑操作工具规则限制，未绕过。远端当前开发/体验/正式版本仍未核实；不能断言其他人员未曾上传。本地证据不足以称为积分入口已上传。

## 最新候选

| 项目 | 结果 |
|---|---|
| 候选版本 | 1.0.0-rc.260 |
| 来源 | 本轮fetch确认的最新origin/main：55be235542e066b2d1232d2749424492a406e1f8 |
| AppID | wxdb9f2dc413484f2d |
| 正式API | https://mbox.shmbox.com |
| 积分入口 | 使用积分抵扣；全积分时“积分结清，无需另付款”均在候选中 |
| 安全配置 | production、微信身份启用、开发数据兜底关闭、无默认桌码/开发身份 |
| 小程序回归 | 539通过、0失败、0跳过 |
| 静态检查 | 168源文件通过 |
| 候选完整性 | 166文件、candidate阶段ready；164文件与主线逐字节一致，工程配置及release-config为构建生成 |
| 比上次上传变化 | 12文件，涉及会员进度、积分入口/报价、账户显示及请求适配 |
| 本轮上传/提审/发布 | 均未执行 |

候选工程：`/Users/jingda/mbox/outputs/miniprogram-rc260-20261019/wechat-rc260/miniprogram`。

可导入压缩包：`/Users/jingda/mbox/outputs/miniprogram-rc260-20261019/MBOX-WeChat-1.0.0-rc.260-candidate.zip`，SHA256 `7e2688af4ac7ef1ce6252823552621d5638f55c36d6d3823dfdab8a44f5f1200`，510,489字节，ZIP CRC检查通过。

候选清单SHA256 `963607ac6c0be70fc80f987cfed8423cd8a6d8f2b9da4bde2ef37c1d5cfbfc5c`。输出目录留存`tests.log`、`static.log`、`candidate-verification.json`、`source-readback.json`、`preparation-result.json`及使用说明。candidate ready只证明本地完整性，不代表微信原生编译、平台审核、正式发布或真机验收通过。无后台部署、生产交易或新打印命令。
