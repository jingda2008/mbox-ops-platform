# 星驿基础支付正式适配

## 已实现范围

本适配依据星驿官方 `xypay-skills` V1.0.1 和在线接口文档实现，资金状态全部进入 M-Box 统一支付域：

- JSAPI 下单：`POST /yyfsevr/order/pay`
- 星驿聚合支付码：`POST /yyfsevr/order/getCodeUrl`
- 商户扫客户付款码：`POST /yyfsevr/order/scanByMerchant`
- 支付查询：`POST /yyfsevr/order/orderQuery`
- 普通退款：`POST /yyfsevr/order/refund`
- 退款查询：`POST /yyfsevr/order/refundQuery`
- 支付成功异步通知验签、持久化幂等和订单状态推进
- 微信、支付宝、云闪付实际结算渠道识别
- 按原支付商品和数量部分退款
- 英文 JSONL SFTP 对账文件解析边界

员工协助点单后可以选择让客人扫描平板上的支付二维码，也可以使用平板后置摄像头或扫码枪读取客户付款码。订单同步到客人手机后，客人仍可点击微信支付。相同订单只允许一笔有效支付意图占用对应商品，防止重复收款。

## 状态边界

- 生成支付码或取得 JSAPI 参数只进入 `processing`，不能记为到账。
- 付款码接口同步返回 `000000` 或 `222222` 时仍只进入 `processing`，最终以验签回调或主动查单为准。
- 星驿码创建响应不提供星驿平台交易号，系统允许交易号暂为空；验签回调或主动查单后绑定真实 `ORDER_NO`。
- 只有验签回调或主动查单可以把支付变更为 `succeeded`。
- 客人自助订单在验签到账后才提交厨房/吧台并扣减受控库存。
- 回调 `PAY_CHANNEL=1/2/9` 分别归入支付宝、微信、云闪付结算。
- 退款受理只进入 `processing`，最终结果由退款查询确认；退款 `tag` 优先按原支付实际渠道选择。

## 安全实现

- 环境只能使用官方 `test`、`uat`、`production` 三个固定 HTTPS 域名。
- 顶层参数按 ASCII 升序签名；排除 `null`，保留空字符串；对象和数组使用紧凑 JSON。
- 请求使用 RSA PKCS#1 v1.5 公钥加密 SHA256 小写十六进制摘要。
- 同步响应和回调先验签再读取业务字段；缺签、坏签、HTTP 非 200、金额/商户/订单冲突均拒绝。
- 回调采用数据库持久化幂等，不使用仅 24 小时 Redis 去重替代支付账本。
- 支付渠道网络调用与支付意图创建事务分离，避免外部超时占用数据库事务。
- 公钥、机构号、商户号不得进入前端、日志或 Git，生产应通过 Cloud Run Secret Manager 注入。
- 客户付款码只在一次 HTTPS 请求内短暂使用；数据库、审计日志、支付载荷和幂等记录只保留 SHA256 指纹，不保存原始付款码。

## 必需环境变量

```dotenv
MBOX_POSTAR_ENABLED=false
MBOX_POSTAR_ENVIRONMENT=test
MBOX_POSTAR_MERCHANT_ID=
MBOX_POSTAR_AGENCY_ID=
MBOX_POSTAR_PUBLIC_KEY=
MBOX_POSTAR_CALLBACK_URL=https://your-domain.example/api/payments/providers/postar/callback
MBOX_POSTAR_CALLBACK_SUCCESS_CODE=000000
MBOX_POSTAR_REFUND_TAG=2
MBOX_POSTAR_HTTP_TIMEOUT_MS=10000
```

`MBOX_POSTAR_REFUND_TAG` 是历史订单或无法识别原渠道时的兜底值。新聚合码订单会按回调识别出的微信、支付宝或云闪付渠道退款。

## 上线前阻断项

1. 取得星驿 KYC 审核通过后的机构号、商户号和生产公钥。
2. 由星驿确认回调成功码使用空串还是 `000000`，按实际结果配置。
3. 在星驿测试/UAT 环境完成 1 分钱或官方许可金额联调：客扫支付码与商户扫付款码分别覆盖微信、支付宝、云闪付。
4. 覆盖支付成功、取消、超时、重复回调、主动查单、部分退款、重复退款和退款查询。
5. 开通 SFTP 正式账单并完成次日对账；在此之前不能把接口流水当作最终财务对账。
6. 生产发布前保持 `MBOX_POSTAR_ENABLED=false`，凭据和联调结果齐全后再受控开启。

## 官方依据

- [xypay-skills 使用说明](https://www.postar.cn/xyf/doc/8552129m0)
- [JSAPI 下单](https://www.postar.cn/xyf/doc/341551817e0)
- [支付查询](https://www.postar.cn/xyf/doc/341551811e0)
- [退款](https://www.postar.cn/xyf/doc/341551821e0)
- [退款查询](https://www.postar.cn/xyf/doc/341551822e0)
- [交易结果通知](https://www.postar.cn/xyf/doc/341551808e0)

本机收到的 `/Users/jingda/Downloads/xypay-skills` 与官网下载的 V1.0.1 压缩包逐文件一致；官方压缩包 SHA256 为 `8244a29e16b0d31237c44084431066d9380507dd922ee524e41515e8a7827d0a`。
