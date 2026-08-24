# M-Box 客户微信小程序

原生微信小程序工程，覆盖首个客户商业纵向闭环：到店前预约、桌码入桌、呼叫服务、订单/桌账摘要、投诉、会员权益、点歌入口和状态反馈。

## 业务边界

- 服务请求、投诉和“已解决/仍未解决”调用现有任务 API，不在前端伪造提交成功。
- 桌账从签名桌码 `/api/guest/session` 的本桌脱敏数据生成，只读展示。
- 会员资料、积分、入会协议和权益只使用规范化的“我的”及关联页面；已移除旧运行时会员页和 `/api/wechat/member-portal` 数据源，避免与规范化会员账本混用。
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

1. 在当前仓库启动规范化 API，使配置的健康检查地址可访问。
2. 打开微信开发者工具，选择“导入项目”。
3. 项目目录选择当前仓库的 `miniprogram` 目录。
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

网页二维码/编译参数保留既有地址兼容：

```text
pages/home/index?table=L01&token=<fixed-table-token>
```

微信官方小程序码受 `scene` 长度限制，只放置32字符随机桌码凭证；后端凭证可权威识别门店和桌台，不依赖客户端桌号：

```text
<32-character-fixed-table-token>
```

优先级为：二维码参数或 `scene` > `extConfig`/本地运行时配置 > 开发默认值。体验版和正式版忽略本地运行时配置，也不会复用开发缓存中的桌号或令牌。旧的长凭证不能直接冒充微信官方小程序码，必须经过明确轮换。

正式桌码分两步生成：先使用 `npm run qr:generate:normalized` 签发受保护的固定桌码清单，再使用 `npm run qr:render:wechat-mini` 调用微信官方接口渲染体验版或正式版小程序码。两个步骤均需显式确认变量；私密清单、图片和审计清单使用受限文件权限，正式渲染缺少 AppID/AppSecret 或页面未被微信接受时会停止，不回退成普通网页二维码。

替换线上小程序前必须使用 `npm run release:miniprogram:verify` 分阶段核对：

- `candidate` 只声明“本地候选包完整、正式运行配置形式有效且绑定指定提交”，报告标记为 `local_integrity_only`，不宣称已经微信验证。
- `upload` 核对 AppID、合法域名、隐私资料、模板、开发者工具、iOS/Android 真机附件和微信上传回执，并且必须由受控复核岗对当前候选包和证据摘要做 Ed25519 独立签名。
- `release` 不会继承或提升 `upload` 结果；它还必须核对审核编号、正式发布编号、正式桌码，并取得一份明确声明 `release` 的新签名。

附件路径和 SHA-256 只证明“这次核对的文件没被替换”，不能证明文件来自微信。上传/发布阶段的可信边界是：仓库外受控复核人、受保护的签名私钥、GitHub Environment 审批和与候选提交精确绑定的证据包。签名私钥禁止进入代码库、Actions 产物或小程序包。示例结构位于 `docs/miniprogram-release-evidence.example.json`，占位内容按设计会被拒绝。

源码工程始终保留测试 AppID 和开发默认配置，禁止直接作为正式上传包。正式候选必须在仓库外的全新目录生成：

```text
APP_COMMIT_SHA=<40位候选提交SHA> \
MBOX_MINIPROGRAM_RUNTIME_CONFIG=<正式非秘密配置JSON> \
MBOX_MINIPROGRAM_CANDIDATE_OUTPUT=<全新且不存在的输出目录> \
npm run release:miniprogram:build
```

构建器会写入正式 AppID、强制打开微信合法域名校验、注入不含密钥的正式运行配置，并生成覆盖候选包全部文件的 SHA-256 清单。空 API、空门店、空微信身份、IP 地址、端口或路径域名、默认桌码、开发身份、私钥和重复覆盖目录都会被拒绝。`AppSecret`、身份加密密钥和桌码私密清单不得进入候选包。

候选、上传和发布应分别执行：

```text
APP_COMMIT_SHA=<同一提交SHA> MBOX_MINIPROGRAM_RELEASE_STAGE=candidate MBOX_MINIPROGRAM_RELEASE_EVIDENCE=<证据JSON> npm run release:miniprogram:verify
APP_COMMIT_SHA=<同一提交SHA> MBOX_MINIPROGRAM_RELEASE_STAGE=upload MBOX_MINIPROGRAM_RELEASE_EVIDENCE=<证据JSON> MBOX_MINIPROGRAM_RELEASE_TRUSTED_KEY_ID=<受保护key-id> MBOX_MINIPROGRAM_RELEASE_TRUSTED_PUBLIC_KEY_BASE64=<Ed25519公钥PEM的base64> npm run release:miniprogram:verify
APP_COMMIT_SHA=<同一提交SHA> MBOX_MINIPROGRAM_RELEASE_STAGE=release MBOX_MINIPROGRAM_RELEASE_EVIDENCE=<证据JSON> MBOX_MINIPROGRAM_RELEASE_TRUSTED_KEY_ID=<受保护key-id> MBOX_MINIPROGRAM_RELEASE_TRUSTED_PUBLIC_KEY_BASE64=<Ed25519公钥PEM的base64> npm run release:miniprogram:verify
```

Actions 不会读取开发电脑或 runner 上的任意绝对路径。将 `evidence.json`、候选目录、附件、attestation 和独立签名放在同一个受控 tar.gz 产物根目录，以下名称上传到指定提交的已有 GitHub draft release，并同时提供 GNU `sha256sum` 格式的 `.sha256`：

```text
miniprogram-candidate-evidence-<commit>.tar.gz
miniprogram-upload-evidence-<commit>.tar.gz
miniprogram-release-evidence-<commit>.tar.gz
```

`小程序分阶段验证` workflow 可手动选择 `candidate/upload/release`，每个阶段只下载对应受控产物，防止阶段混用。员工后台、标准服务端和数据库使用独立的 `release.yml` 与 `production` Environment；其发布清单明确排除 `wechat-miniprogram`，不会上传、审核或替换微信端代码。小程序正式发布只允许经 `miniprogram-release-stage.yml` 的 `release` 阶段验证对应 `miniprogram-release-evidence-<commit>.tar.gz`，不能从员工/服务端发布结果推断微信已发布。各 `miniprogram-*` Environment 必须在 GitHub 中配置独立审批人和受保护的公钥/key-id；资料或公钥缺失时，小程序门禁按设计拒绝，但不阻断员工/服务端发布。

商业就绪检查需同时传入 `MBOX_MINIPROGRAM_RELEASE_REPORT`、受保护的 key-id 和公钥。它会再次验证报告内嵌的原始 attestation 和签名，并且只接受 `release + trusted_external_attestation`；手写 `status=ready`、缺公钥、伪签名、过期签名、`candidate` 或 `upload` 报告均会失败关闭。

## 预发布与生产配置

体验版和正式版默认不提供 API、门店或桌台令牌，也不启用开发数据兜底。正式上传只使用上述隔离候选构建产物；`extConfig` 可继续提供非秘密运行配置，但不得用来补救一个本身缺少正式 API、门店或微信身份的上传包。

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
