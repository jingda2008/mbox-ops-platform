# REQ-15 既有星驿映射核对（无新增通道）

本次只分类提交前校验错误，沿用已授权字段映射及签名，不修改接口参数。

|渠道字段|现有内部字段|类型/规则|
|---|---|---|
|orderNo|paymentIntentId|string，1至40位字母数字|
|txamt|amount|正整数分转字符串|
|custId|merchantId|必填字符串|
|openid|payerId|JSAPI必填字符串|
|payWay|payWay|既有微信/支付宝映射|
|asyncNotify|callbackUrl|HTTPS|
|outTime|expiresAt|按既有1至15分钟校验|
|code|response.code|保留原验证与业务码，不将查无订单等同失败|

本地确定未发送仅指createPayment参数校验阶段；网络、验签、响应解析或持久化失败仍保留未知。密钥、金额、单号值不写错误日志。
