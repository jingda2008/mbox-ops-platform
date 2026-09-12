# 支付证据与财务闭环补齐

最终发布rc.190，schema197；精确工作树/Users/jingda/mbox/mbox-member-growth-reliability-20260909。

初查（rc.189整改前）：应用服务器采集timer不存在，中转服务器inactive；SLS payment-audit在2026-09-11 22:25至2026-09-12 01:00 CST计数0。正式应用网关保留同期间请求日志，但该入口未发现callback/notify路径记录；旧应用过滤后未取得支付异常。数据库logging_collector=on、log_min_error_statement=error，但RDS服务端历史错误日志尚未取得，不能据此断言所有日志永久丢失。回调可能走其他中转路径，当前证据不足以确定原始异常。

线上reconciliation.manage定义缺失，仅CASHIER角色直接持有reconciliation.view；补齐管理权限仅处理核对进展，不包含收款退款授权。既有员工个别拒绝仍优先，保存时同时检查查看与管理权限。

实现：成功观察未消费且付款未入账时生成只读派生信号，置顶且一笔一条；不写重复通知/升级记录。关闭界面仍显示异常数，可见页面一分钟刷新；隐藏页面暂停。接手由员工本人执行并留审计，禁止代签现场处理。

云日志通过应用宿主机受限SSH键转送至现有中转机RAM角色。该键在中转机强制执行限量脱敏接收器，禁止终端与转发；不复制长期云凭证。费用沿用现有单分片日志库及500条/512KiB每轮限制。部署后必须确认定时器成功及安全探针云端可检索，不以源码存在代替采集生效。

现场验收清单：下一笔实际顾客付款后记录原商户单号、到账金额与营业日；员工核对收银状态、原订单与财务流水一致；退款仅在确有业务需求时验证原款入口，不发起测试退款。尚未发生的真实交易不得标记验收完成。

RDS日志追查限制：2026-09-12现有ECS角色调用rds:DescribeDBInstances返回Forbidden/ImplicitDeny；未增加云权限或绕过限制。要继续追查需有权限人员从RDS导出2026-09-11 22:25至2026-09-12 01:00 CST错误日志，或提供受控只读入口。网关与云日志现有证据已检查。

本地验证：新增197迁移后初次完整检查仅迁移链测试仍期望196而失败，补齐明确迁移清单后重跑。权限测试初次错误地要求既有SERVER无收款权限，现改为比较迁移前后所有非核对权限保持一致；不是修改SERVER原权限。

验证完成：常规检查1662通过，独立PostgreSQL1887通过/1既有跳过；证据管线25项通过，补充末端字段留存和安装前置失败2项通过；手机320/390宽度布局测试1项通过。财务测试覆盖重复刷新无写入/无重复行、恢复前禁止结案、到账恢复后信号消失、结案后退出列表、权限回收403；权限迁移重复执行只增加符合角色的核对管理权限，其他权限前后相同。上述均为自动化证据，尚非现场真实收款验收。

## 最终交付与线上回读（2026-09-12 18:23 CST）

rc.190已合并并部署：475fe51ff99bed633c8879c37961f29aa58dcdb9；镜像sha256:cfd3a5e626ae0e6da44b8cbf9d52d685312e40675c0f640e91cb866eaf3102c3；schema197，production/ready。备份/opt/mbox/backups/mbox-20260912T101953Z-Do3ecl.dump及云端上传回读均通过。正式首页、顾客、预约、员工页面与浏览器检查通过，pay域名TLS入口同SHA，旧实例仍stopped/restart=no。

PR216、标签CI34687549172、发布34687549208均成功。常规1662项通过；独立数据库1888项通过/1既有跳过，含真实门店配置连续provision授权保留；日志聚焦11项通过，含180条长事件分批不丢失。首次常规仅配置版本断言仍为v22失败，修正v23后完整重跑通过。

18:21:47 CST生产只读回查：收银员工sanmu有效reconciliation.view/manage均true；VIP1 ¥88为refunded，B06 ¥1380为succeeded；近七天已有成功观察但付款尚未入账计数0。该数不是所有未知付款的渠道核对结论。本轮未发起收款或退款，已处理¥20不重开。

采集器已按正式SHA安装，timer active、service success；历史发送积压清零，再一轮采集仍success/0。SLS实际查回2026-09-12T09:55:12.588352640Z支付查询错误的付款标识、stage=query_provider、code=OnlinePaymentUnknownError及原始时间；另查回10:21:53Z的container_started，releaseSha等于475fe51全SHA。支付查询错误可追查不代表未知付款已到账。日志库真实TTL为运行错误7天、支付/发布90天，均一分片。

历史根因由旧容器实际代码复现、同库及回调404时间链补证；未记录的原始异常文本不能伪造恢复。财务接手/结案功能与权限已交付，员工实际接手、下一笔真实营业付款及按业务需要发生的退款仍需现场证据，不以自动化测试或代操作冒充验收。未新增外部消息推送。

证据：.runtime/payment-evidence-rc189/rc190-deploy.log、rc190-postdeploy-readback.json、rc190-pay-ingress-readback.txt、rc190-sls-runtime-readback.json，以及.runtime/deploy/v1.0.0-rc.190/deployment/deployment-manifest.json。原始调试文件不进入产品界面或公开日志。

## 新发现：旧支付入口和共享数据库后台仍在运行（SYS-178，P0）

2026-09-12追查补到关键证据：中转机139.224.254.60仍运行518e9412f1e12ea006494c9ab20ea7a632df3250（容器启动2026-08-27），runtimeRole=normal、writeEnabled=true、integrationWorkersEnabled=true，与正式应用数据库身份摘要及tenant/store一致。pay.shmbox.com及旧IP入口均反代该旧mbox-app，而不是最新门店服务。

VIP1成功观察14:30:30.982Z，中转Caddy回调404在14:30:31.027Z；B06成功观察16:39:22.654Z，中转Caddy回调404在16:39:22.681Z。两笔均order_batch。旧PaymentRepository.lockPayable只支持order和activity_registration，对order_batch抛PaymentNotFoundError('invalid payable target')；旧接口映射404。已在旧容器实际编译代码以无数据库写入的调用复现该错误。该证据把此前缺失原始异常的排查推进到可复现的版本不兼容原因；不能再仅归因为日志缺失或渠道故障。401请求同时存在，但不据此断言其来源或把它当两笔已验签成功记录的原因。

修复入口脚本converge-payment-ingress.sh核实新版SHA和TLS身份，经内网HTTPS转发至10.100.80.223，保留mbox.shmbox.com证书验证；备份配置、退役过期旧IP虚拟主机并验证pay域名返回新版SHA后，才把旧mbox-app移出守护列表、禁用自动重启并停止旧实例。旧容器与历史日志保留。入口验证失败时恢复原配置且不停止旧实例；旧实例已停止后不自动回退到不兼容代码。归档脚本及执行结果，不使用数据库状态伪造补救。

防复发：旧主机退出后写入受控退役标记；正式deploy-release.sh在任何激活前拒绝把应用再次部署至已退役的支付主机。中转日志与网关用途继续保留，不能将其当作门店应用发布目标。

## 入口切换校验补充

首次切换被TLS验证阻止并自动恢复，旧实例未停：旧IP证书有效期2026-08-22至08-28，已过期；pay.shmbox.com证书有效至2027-02-27。Caddy续签日志显示ACME外部连接超时，不能绕过TLS校验宣称入口正常。2026-09-12 08:00 CST至检查时刻未发现旧IP业务请求；用户营业入口为mbox域名，支付回调实际走pay域名。整改为退役旧IP虚拟主机，保留pay域名并验证当前应用SHA；保留所有备份。另修复旧配置CRLF兼容与候选仍含旧上游时的显式退出。切换脚本成功/失败回退测试覆盖CRLF，应用镜像仍rc.189，运维脚本修订另按合并SHA执行。

## rc.189部署与旧入口退役实证

2026-09-12 17:38 CST正式部署rc.189/1642b0dbf53b199d229fef443b59c0a137755a0e，schema197；镜像sha256:1cfbaa77f4828bffcae8f64ba8f18bd54c4a81f4d66f075666f908eefa97cd90。备份mbox-20260912T093705Z-guq33v.dump，发布脚本页面及浏览器检查通过。17:40按已合并8311d777b3ff8ea89400d8aab4f6c4c443003355执行入口收敛，结果legacyStopped/legacyIpRetired/ingressVerified均true；备份/opt/mbox/ingress-backups/20260912T094036Z-converged。

日志安装首次运行因应用到中转公网6122连接超时失败，事件保留队列，未标记完成。中转实际内网10.100.50.234:6122连通且受限密钥认证成功；改内网路由，并以HostKeyAlias沿用已核实的公网主机密钥。主机systemd219不支持strict/ReadWritePaths和show --value，改支持的full/ReadWriteDirectories和Result=success判断。云端回读完成后另记实际结果。

## 线上回读发现的剩余缺口与rc.190

收银员工有效权限view=true/manage=false，数据库无员工deny；原因是正式发布provision会删掉门店默认配置外且未标记运行配置管理的权限。迁移197有效但随后被旧v22配置覆盖。v23默认配置补CASHIER核对管理，并新增读取实际门店配置、重复provision后的真实数据库断言。该发现证明迁移测试不能替代发布后有效权限检查。

日志内网认证后，旧积压发布日志的合法镜像摘要含连续数字，被通用手机号扫描拒绝；队列仍保留。严格哈希字段以精确十六进制长度/前缀校验，自由文本继续敏感过滤；云端索引先去小数秒再转时间，保留原timestamp字段。新增合法/非法摘要与源时间回归，目标rc.190。

SLS首批已实际查回支付错误及原始小数秒时间；TTL回读runtime-errors=7天、payment-audit/release-audit=90天，均单分片。第二批历史积压触发Linux单参数上限，队列保留353条。发送器按最终编码UTF-8大小拆为每次最多60000字节，180条长事件测试验证拆批且全部传递；云端写入采用至少一次交付，失败重试以既有fingerprint关联，不涉及支付账务。
