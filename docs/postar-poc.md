# 星驿支付正式适配 PoC

## 范围

本 PoC 依据 2026-07-14 可访问的星驿官方文档实现现有 `PaymentProviderAdapter`：

- 支付查询：`POST /yyfsevr/order/orderQuery`
- 普通退款：`POST /yyfsevr/order/refund`
- 退款查询：`POST /yyfsevr/order/refundQuery`
- 支付成功回调验签
- 英文 JSONL SFTP 对账文件

现有 `PaymentProviderAdapter` 没有创建支付或终端推单方法，因此以下接口只保留契约路径和集成边界，没有旁路接入现有支付域：

- JSAPI 下单：`POST /yyfsevr/order/pay`
- 终端推单：`POST /yyfsevr/order/cashierPay`
- 关闭终端推单：`POST /yyfsevr/order/closeCashierPay`

## 安全实现

- 环境只能从 `test`、`uat`、`production` 选择，分别映射官方三个固定 HTTPS 域名，不接受自定义 base URL。
- 顶层参数名按 ASCII 升序排列并区分大小写；`sign` 不参与签名；顶层 `null` 排除，空字符串参与。
- 字符串直接拼接，数字和布尔值使用字符串表示，对象和数组使用保持属性顺序的紧凑 JSON。
- 待签名串使用 UTF-8 SHA256，摘要固定为小写十六进制。
- 请求 `sign` 使用 RSA PKCS#1 v1.5 公钥加密摘要；回调和同步响应使用同一公钥解密 `sign`，再定时安全比较摘要。
- 同步响应在读取 `code`、`data` 或状态前必须验签；缺签、坏签、HTTP 非 200、字段冲突和未知状态全部拒绝。
- 回调只接受普通支付成功：`ORDER_STATUS=1/e/i`，并交叉检查普通正向 `TRAN_TYPE_SER`。退款、撤销、担保和预授权通知不会映射成支付成功。
- 普通退款受理成功仍返回 `processing`，最终结果只由已验签的退款查询确定。
- 对账只接受官方英文 JSONL 格式，校验汇总笔数、机构号、商户号、日期、金额符号和交易类型；中文元单位格式不自动换算。

## 上线阻断

以下问题必须取得星驿书面确认和测试环境实报文后才能启用资金流量。当前代码均 fail closed，不设置兼容默认值。

1. **同步响应签名**：安全规范要求请求和返回都验签，但支付查询、退款、退款查询的响应 schema 均未声明 `sign`。适配器要求同步响应存在顶层 `sign`，实际缺失时直接失败。需确认签名字段位置、参与签名字段范围，以及错误响应是否签名。
2. **回调确认 `rspCod`**：通知正文示例为 `{"rspCod":"","rspMsg":"success"}`，响应 schema 示例为 `{"rspCod":"000000","rspMsg":"success"}`。适配器只负责验证回调，不生成确认响应；回调路由在确认前不得猜测。
3. **PHP 空串规则**：安全规范正文和失败排查要求空字符串参与签名，PHP demo 却排除空字符串。实现遵循规范正文并保留空串，但上线前必须用星驿提供的跨语言官方向量确认。

## 状态边界

支付查询仅映射：`0/99 -> failed`、`1/e/i -> succeeded`、`2 -> processing`。退款、撤销、冲正、担保、预授权及未知状态全部拒绝，不能算支付成功。

普通退款查询仅映射：`3 -> failed`、`4/c -> succeeded`、`5/b -> processing`。`7/98` 属于撤销流程，不进入普通部分退款。`121338` 没有可核验退款金额，不能满足现有支付域的金额一致性约束，因此拒绝写入并等待后续查询。

## 依赖注入

`PostarPaymentProviderAdapter` 不直接读取环境变量、不直接调用 `fetch`、不创建 SFTP 连接：

- `PaymentProviderSecretSource` 提供 `postar.agencyId` 和 `postar.publicKey`，可通过构造参数改密钥名。
- `PostarHttpClient` 负责超时、连接池、TLS、代理、审计和重试策略。退款 POST 不得由通用网络层自动重试，重试必须沿用同一退款单号并由业务幂等控制。
- `PostarTransactionMetadataSource` 提供支付日期、退款日期、退款商户号和原支付渠道 `tag`。这些信息不在当前适配器请求契约内，不能从订单号猜测。
- `PostarSftpBillSource` 负责白名单 IP、SFTP 凭据和下载官方英文账单原始字节。测试环境官方不提供 SFTP。
- `now` 可注入，生产应提供可靠的上海时区时间源。

## 剩余集成点

1. 在服务端组合根实例化适配器，并把支付意图渠道值配置为 `postar`。
2. 实现生产 HTTP 客户端，设置明确的连接/读取超时、响应大小上限、TLS 校验和敏感字段脱敏日志。
3. 从支付意图和退款记录实现 `PostarTransactionMetadataSource`；退款 ID 必须是 1 至 40 位大小写字母或数字。
4. 回调路由必须传入原始 UTF-8 body，验签成功且支付域提交成功后，才按星驿最终确认的 `rspCod` 返回一级 JSON 对象。
5. 开通并实现生产 SFTP 英文账单源；每天 06:00 后拉取前一日文件并接入现有 reconciliation 流程。
6. JSAPI 下单和终端推单需要先扩展现有支付域命令/契约，再复用本适配器的签名和白名单 HTTP 边界；不得直接从路由调用星驿。
7. 普通退款异步通知目前不能通过只接受支付结果的 `verifyPaymentCallback` 写入退款域，正式接入先使用主动退款查询，后续新增独立退款通知边界。
8. 用星驿测试环境完成无资金或官方许可的小额联调向量，覆盖三个上线阻断后再开放生产开关。

## 官方依据

- [协议规则](https://www.postar.cn/xyf/doc/7306733m0)
- [安全规范](https://www.postar.cn/xyf/doc/7306848m0)
- [JSAPI 下单](https://www.postar.cn/xyf/doc/341551817e0)
- [支付查询](https://www.postar.cn/xyf/doc/341551811e0)
- [退款](https://www.postar.cn/xyf/doc/341551821e0)
- [退款查询](https://www.postar.cn/xyf/doc/341551822e0)
- [交易和退款结果通知](https://www.postar.cn/xyf/doc/341551808e0)
- [交易对账文件 ISV](https://www.postar.cn/xyf/doc/341551807e0)
- [终端推单](https://www.postar.cn/xyf/doc/341551835e0)
- [关闭终端推单](https://www.postar.cn/xyf/doc/341551836e0)
