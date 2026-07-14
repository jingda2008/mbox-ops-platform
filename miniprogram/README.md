# M-Box 客户微信小程序

原生微信小程序工程，覆盖首个客户商业纵向闭环：到店前预约、桌码入桌、呼叫服务、订单/桌账摘要、投诉、会员权益、点歌入口和状态反馈。

## 业务边界

- 服务请求、投诉和“已解决/仍未解决”调用现有任务 API，不在前端伪造提交成功。
- 桌账从签名桌码 `/api/guest/session` 的本桌脱敏数据生成，只读展示。
- 会员页在开发环境调用 `/api/dev/member-portal/:memberId`；生产环境使用微信客户会话调用 `/api/wechat/member-portal`，未绑定会员时明确拒绝。
- 点歌页调用 `/api/guest/song-requests`，后端按签名桌码绑定当前桌台，仅提交点歌意向。
- 开发 API 不可用时可展示明确标注的开发占位数据，但所有写操作会被禁用。
- 小程序中没有 `AppSecret`、支付密钥、微信 access token 或员工会话密钥。
- 到店前预约不要求桌码；生产环境先建立微信客户会话，再调用 `/api/wechat/reservations`，只返回当前微信主体或已绑定会员本人的预约。

## 目录

```text
miniprogram/
  app.js / app.json / app.wxss
  config/              运行时环境配置
  utils/               请求、API、桌码会话和格式化
  mock/                明确标注的开发展示数据
  components/          加载、错误和空态组件
  pages/               首页、预约、服务、桌账、投诉、会员、点歌、状态、隐私
  project.config.json  微信开发者工具工程配置
```

## 本地运行

1. 在 `/Users/jingda/mbox/mbox-ops-platform` 启动现有 API，使 `http://127.0.0.1:8787/api/health` 可访问。
2. 打开微信开发者工具，选择“导入项目”。
3. 项目目录选择 `/Users/jingda/mbox/mbox-ops-platform/miniprogram`。
4. 使用测试号运行；`project.config.json` 已配置 `touristappid` 和编译条件“开发桌码 L01”。
5. 开发者工具中保持“不校验合法域名”开启。本地真机不能访问电脑的 `127.0.0.1`，真机联调需使用 HTTPS 测试域名或可访问的局域网地址。

开发默认配置位于 `config/index.js` 的 `DEVELOPMENT_DEFAULTS`：

```js
{
  apiBaseUrl: 'http://127.0.0.1:8787',
  storeId: 'mbox-lujiazui',
  defaultTableCode: 'L01',
  defaultTableToken: 'dev-table-token-L01',
  developmentActorId: 'emp-chen'
}
```

`developmentActorId` 只用于本地员工接口调试，不参与顾客桌码接口，且不得用于预发布或生产。

## 桌码参数

普通二维码/编译参数：

```text
pages/home/index?table=L01&token=<short-lived-table-token>
```

小程序码 `scene` 使用同样的键值格式并进行 URL 编码：

```text
table=L01&token=<short-lived-table-token>
```

优先级为：二维码参数或 `scene` > `extConfig`/本地运行时配置 > 开发默认值。体验版和正式版忽略本地运行时配置，也不会复用开发缓存中的桌号或令牌。

## 预发布与生产配置

体验版和正式版默认不提供 API、门店或桌台令牌，也不启用开发数据兜底。部署方应通过小程序托管/第三方平台的 `extConfig` 注入 `config/runtime-config.example.json` 所示的非秘密配置，或在构建前替换部署配置。

桌台令牌应来自每桌二维码或后端换取的短期会话，不应把全店永久令牌写入代码。正式 API 域名必须：

- 使用 HTTPS，并加入微信公众平台 request 合法域名。
- 校验 `storeId + tableCode + tableToken` 的一致性、有效期和状态。
- 只返回当前桌台和当前客户可见的数据，不能继续把全店 `/api/bootstrap` 暴露给客户。
- 用 `wx.login` 的临时 `code` 在后端换取客户会话；`AppSecret` 只在后端调用微信接口。
- 正式环境通过 extConfig 提供 `wechatIdentityEnabled`、`identityTenantId`、`identityStoreId` 和 `wechatAppId`；小程序只保存短期Bearer，不保存AppSecret或身份加密密钥。

## 当前后端边界

小程序预约已接入正式微信客户会话与本人数据隔离。商业发布前仍需完成以下外部联调：

- 当前桌台专用聚合接口已接入，禁止顾客端调用全店 `/api/bootstrap`。
- “舞台先确认、客户后付款”的点歌状态与微信支付接口。
- 客户支付意图、回调查询、退款状态和订阅消息接口。

这些缺口不会由小程序本地数据掩盖。

## 开发者工具验收

1. 不带桌码进入首页，确认仍可进入“预约到店”，但现场服务入口保持禁用；再使用编译条件 `table=L01&token=dev-table-token-L01` 确认显示 `休闲01`、服务专员和“开发模式”。
2. 关闭 API 后刷新，确认出现“开发占位数据”警告，服务、投诉和点歌写操作不可提交。
3. 启动 API 后点击“加水”，确认收到后端 `customerReply`；管理/员工 Web 应出现同一桌台任务。
4. 员工端将任务依次改为接单、到桌、完成；小程序状态页下拉刷新后确认状态一致。
5. 在小程序点击“仍未解决”，确认任务重开/升级；再次完成后点击“已解决”，确认任务关闭。
6. 提交投诉，确认备注包含所选投诉类型，且状态页可继续反馈。
7. 打开订单/桌账，确认只展示当前桌台会话的订单、商品、出品状态和台账余额，页面不存在支付成功模拟入口。
8. 打开会员权益，确认开发会员资料和权益带开发标识；切换非开发模式时不得继续使用开发会员 ID。
9. 打开点歌，选择当日排班曲目并提交，确认只出现“舞台正在确认/未发起支付”，状态页出现同一请求。
10. 用无效桌码和未开台桌码编译，确认首页阻止进入业务页面并给出明确错误。
11. 检查加载、网络错误、无订单、无权益、无歌单和无任务状态，确认页面均有可读反馈且无横向溢出。
12. 查看隐私说明，确认正式发布前待补充项与实际接入能力一致。
13. 在预约页提交称呼、人数、时间、区域和场景，确认列表只显示本人预约；重复同一网络请求不得生成第二条预约。
