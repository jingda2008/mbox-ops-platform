# M-BOX 星驿支付联调字段映射

状态：已按 2026-08-14 测试商户资料和星驿基础支付 V1.0.1 文档整理。

安全边界：本文不记录公钥正文、TLS 私钥、数据库密码、付款码或客户隐私。

## 1. 扫码支付（客人扫二维码）

接口：`POST /yyfsevr/order/getCodeUrl`

### 请求参数

| 星驿字段 | M-BOX 字段/来源 | 类型 | 必填 | 转换与约束 |
|---|---|---:|:---:|---|
| `agetId` | 服务端安全配置 `POSTAR_AGENCY_ID` | string | 是 | 只从服务端读取 |
| `custId` | 服务端安全配置 `POSTAR_MERCHANT_ID` | string | 是 | 只从服务端读取 |
| `orderNo` | `payments.public_id` | string | 是 | 1-40 位字母数字；每次发起唯一 |
| `txamt` | `payments.amount_minor` | string | 是 | 人民币分，正整数 |
| `timeStamp` | 服务端北京时间 | string | 是 | `yyyyMMddHHmmss` |
| `version` | 常量 | string | 是 | `1.0.0` |
| `outTime` | 支付有效期 | string | 是 | 测试默认 5 分钟，限制 1-15 分钟 |
| `asyncNotify` | 交易回调地址 | string | 是 | `https://pay.shmbox.com/api/payments/providers/postar/callback` |
| `remark` | 订单摘要 | string | 否 | 不含手机号等隐私 |
| `title` | 商品/桌台简短标题 | string | 否 | 最长 30 字符 |
| `payType` | 常量 | string | 是 | `00`，由客人确认支付 |
| `sign` | 服务端签名模块 | string | 是 | 排除 `sign` 后 ASCII 排序、SHA-256、RSA 公钥加密 |

### 响应参数

| 星驿字段 | M-BOX 字段/用途 | 类型 | 处理规则 |
|---|---|---:|---|
| `code` | 发起结果 | string | 仅 `000000` 视为二维码创建成功 |
| `msg` | 安全化错误提示/审计 | string | 不直接向客人展示原始内部错误 |
| `data` | `provider_snapshot.qrCodeUrl` | string | 必须是 HTTPS；前端生成支付二维码 |
| `sign` | 响应验签 | string | 验签失败拒绝处理 |

## 2. 付款码支付（员工扫客人付款码）

接口：`POST /yyfsevr/order/scanByMerchant`

| 星驿字段 | M-BOX 字段/来源 | 类型 | 必填 | 转换与约束 |
|---|---|---:|:---:|---|
| `code` | 本次付款码输入 | string | 是 | 敏感瞬时数据，不落日志、不写审计正文 |
| `tradingIp` | 受信服务端获取的客户端 IP | string | 是 | 不信任前端自报值 |
| `type` | 终端类型 | string | 是 | 平板/App 使用 `A`，PC 使用 `C` |
| `operator` | 当前员工 ID/编号 | string | 是 | 必须匹配登录操作人 |
| 其他公共字段 | 同扫码支付 | - | 是 | 同上 |

响应中的 `threeOrderNo` 必须等于 `payments.public_id`，返回金额必须等于内部应收金额；`000000` 和 `222222` 均进入查单/回调确认，不凭同步响应直接结算。

## 2A. JSAPI 支付（客人在微信内主动支付）

接口：`POST /yyfsevr/order/pay`

| 星驿字段 | M-BOX 字段/来源 | 类型 | 必填 | 转换与约束 |
|---|---|---:|:---:|---|
| `openid` | 服务端微信身份绑定 | string | 是 | 必须由当前公众号/小程序 AppID 授权取得，禁止前端自行提交 |
| `payWay` | 常量 | string | 是 | 微信支付固定为 `1` |
| `ip` | 服务端解析的客户公网 IP | string | 是 | 仅信任受控反向代理传递的地址 |
| `wxAppid` | 服务端安全配置 `POSTAR_WECHAT_APP_ID` | string | 是 | 必须已在星驿及微信侧与商户绑定 |
| `traType` | 当前微信载体 | string | 是 | 服务号/公众号为 `5`，小程序为 `8` |
| `operator` | 系统操作人 | string | 是 | 客户自助统一使用受控系统操作人标识 |
| 其他公共字段 | 同扫码支付 | - | 是 | 金额、商户、订单号、回调及签名规则一致 |

成功响应必须验签，并校验 `threeOrderNo`、金额、机构和商户。服务端只向当前会话返回微信调起支付所需的 `appId/timeStamp/nonceStr/package/signType/paySign`；前端调用 `WeixinJSBridge.invoke('getBrandWCPayRequest', ...)`。前端返回成功只表示客户完成了微信交互，仍须等待验签回调或主动查单确认后才能将内部订单记为已支付。

如果当前页面不在微信内、没有可信 `openid`、AppID 未配置或商户未完成绑定，系统应明确降级到“客人扫码支付”，不得接受前端伪造身份，也不得模拟支付成功。

## 3. 订单查询

接口：`POST /yyfsevr/order/orderQuery`

| 星驿字段 | M-BOX 字段/来源 | 类型 | 必填 | 转换与约束 |
|---|---|---:|:---:|---|
| `agetId` / `custId` | 服务端安全配置 | string | 是 | 与发起支付一致 |
| `orderNo` | `payments.public_id` | string | 是 | 使用 M-BOX 三方支付单号 |
| `orderTime` | 支付创建日期 | string | 是 | 北京时间 `yyyyMMdd` |
| `timeStamp` / `version` / `sign` | 服务端生成 | string | 是 | 同签名规则 |

`data.orderStatus=1` 才可确认支付成功；金额、商户、单号、币种必须全部匹配后，才更新订单和对账记录。

## 4. 退款与退款查询

退款接口：`POST /yyfsevr/order/refund`
查询接口：`POST /yyfsevr/order/refundQuery`

| 星驿字段 | M-BOX 字段/来源 | 类型 | 必填 | 转换与约束 |
|---|---|---:|:---:|---|
| `orderNo` | `refunds.public_id` | string | 是 | 每次退款唯一，不能复用支付单号 |
| `refundAmount` | `refunds.amount_minor` | string | 是 | 人民币分，不超过可退余额 |
| `tag` | 原支付渠道 | string | 是 | 微信 `2`；以后按查单结果映射，不由前端指定 |
| `reOrderNo` | 原星驿支付平台单号 | string | 三选一 | 优先使用已验签保存的平台单号 |
| `oldTOrderNo` | 原 `payments.public_id` | string | 三选一 | 无平台单号时使用 |
| `asyncNotifyUrl` | 退款回调地址 | string | 否 | `https://pay.shmbox.com/api/refunds/providers/postar/callback`；需星驿侧开通 |
| `remark` | 审批后的退款原因 | string | 否 | 最长 60 字符 |

退款同步 `code=000000` 只表示受理，不表示成功。必须通过验签退款回调或退款查询的成功状态完成退款；退款继续保留人工申请、审批和执行审计。

## 5. 异步通知映射

| 星驿字段 | M-BOX 字段 | 校验 |
|---|---|---|
| `AGET_ID` | 机构绑定 | 必须匹配服务端配置 |
| `CUST_ID` | 商户绑定 | 必须匹配门店绑定 |
| `THREE_ORDER_NO` | `payments.public_id` | 必须存在且渠道为 `postar` |
| `ORDER_NO` | `payments.provider_transaction_id` | 作为星驿平台交易号 |
| `TXAMT` | `payments.amount_minor` | 必须完全一致 |
| `ORDER_TIME` | 成功时间/证据 | 按北京时间格式解析 |
| `sign` | 验签证据 | 失败一律拒绝，不返回成功确认 |

成功确认固定返回：`{"rspCod":"000000","rspMsg":"success"}`。重复回调通过业务事件键幂等处理，不能重复入账、重复扣库存或重复生成出品任务。

## 6. 联调结论判定

- 二维码生成成功不等于支付成功。
- 同步返回成功不等于退款成功。
- 只有验签回调或主动查单同时通过“商户、单号、金额、币种、状态”校验，才允许结算。
- 未取得测试支付结果前，继续标记为联调中，不能宣称正式收款可用。

## 7. 员工协助点单与桌码接力规则

- 员工协助点单和桌码客人看到的是同一笔桌次订单，不复制订单、不拆分应收。
- 员工选择“客人扫二维码”后，同桌客人可在自己手机的“本桌已点”继续同一个二维码支付动作。
- 员工选择“扫客人付款码”后，桌码只显示员工收款中，不允许另一台手机重复发起。
- 客人先从手机发起微信支付后，员工端不能把该笔付款切换为另一种收款方式。
- 同一个桌次可由多人扫码并查看共享商品和履约状态，但不向其他客人暴露付款人身份、`openid`、付款码、支付签名或机构原始报文。
- JSAPI参数只返回给发起它的可信微信身份；二维码可以在同一桌次复用；付款码只由当前员工收款会话使用。
