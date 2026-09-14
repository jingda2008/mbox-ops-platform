# 商品售后修复验收记录（rc.199）

工作树：`/Users/jingda/mbox/mbox-aftersales-fix-20260914`。基线主线946fbb4，保留主线SYS-224，将本次审批项改记SYS-227；关闭SYS-225、库存SYS-226。

## 原因与已落实修改

1. 普通退款审批遗漏商品售后协调流程，触发数据库23514后被统一文案掩盖。查询真实关联、原单入口及授权后受控409已实现；数据库保护不放宽。
2. 长内容弹窗自身滚动，全局错误定位将唯一关闭栏带出屏幕。关闭栏与正文分离、可见视口适配、子层Escape/焦点、原请求恢复已实现。
3. 只读查询确认CXW001为whole_bottle，配方v1自2026-09-02 15:47起为500ml/份；库存当前330ml/瓶，档案更新时间2026-09-13 00:17。原扣减500ml与配方一致，冲突来自配方与包装档案不一致。更新时间本身不能证明谁在何时修改了容量；真实瓶身正确规格仍待门店提供证据。
4. 新预留、销售扣减及重做库存记录保存不可变包装证据；旧记录不回填。预检与提交共享资格判断，历史缺失和冲突保留核对，整瓶配置变更校验，不影响按杯合法配方。
5. 列表/详情分列资金、实物、通知，通知含生成时间。原¥78渠道成功不作新修复的资金验收证据，不重复操作；不代填知悉、损耗或库存处置。

## 逐项覆盖

表中为代码与自动化覆盖依据，不等同门店实机/实物验收。自动化最终执行结果见下方汇总；涉及iPhone、真实包装或新现场资金操作的部分保持待验。

|AC|修改与验证对象|证据定位|
|---|---|---|
|AC-01|真实关联及原单直达、普通入口隐藏|cashier-workbench-query；新增cashier浏览器场景|
|AC-02|旧普通approve/reject受控409，无资金动作|payment-api三项错误测试；quantity关联入口集成|
|AC-03|原单独立审批关联原子一致|quantity: one independent approval applies an explicit multi-payment split|
|AC-04|普通退款沿原流程|payment-api/command-service原有退款审批与驳回测试|
|AC-05|权限、自审、额度及租户保护|quantity自审/HTTP权限；关联拦截前先授权；payment-security-policy|
|AC-06|并发/双击原幂等与库存一次恢复|quantity既有并发；新captured package concurrent return|
|AC-07|多付款审批效果失败全部回滚|multi-payment split新增故障注入，原单requested、关联退款0、排队0|
|AC-08|丢回执及跨日原请求恢复|quantity既有跨日/关入口恢复；browser in-flight recovery key|
|AC-09|线上成功/失败/未知、回调去重|quantity retries only confirmed failed funding；provider observation/payment suites|
|AC-10|现金独立实退确认|quantity exact cash refund、manual-result与权限测试|
|AC-11|拒绝/撤回不独立改资金|quantity既有reject/withdraw/resume；新普通reject409|
|AC-12|成功资金保留，实物通知独立|quantity closed-visit physical/history；browser stock conflict|
|AC-13|原单关闭返回原入口与展开位置|新增cashier浏览器场景；小屏关闭按钮坐标点击|
|AC-14|不泛化23514及敏感错误|payment-api unrelated database constraints + error编号测试|
|AC-15|停用新增入口仍恢复原单|quantity disabling new quantity requests preserves original HTTP recovery|
|AC-16|长错误和关闭栏同时可达|browser long errors：可见性、44px、elementFromPoint、坐标点击|
|AC-17|小屏/方向/字体/可见视口|browser 320/390/844宽、300高和24px文字；真实iPhone微信与软键盘仍待门店验收|
|AC-18|读取失败/请求在途/未知关闭重开|browser load failure、in-flight；原key/body相同，仅恢复原操作|
|AC-19|错误定位与10秒刷新不抢滚动|browser虚拟时钟11秒、正文scrollTop和window.scrollY不变|
|AC-20|子层与Escape/焦点|browser replacement layer；关闭当前层，焦点返回原换品按钮|
|AC-21|500ml/330ml预检与执行一致|新quantity contradictory consumption test；库存无变动；真实瓶身核对未完成|
|AC-22|原包装一致单次回库|new captured package return；500ml原快照、现330，2并发请求仅1条return|
|AC-23|历史版本、缺失、多组成|packaged-return-evidence单元；新immutable snapshot集成；remake既有批次测试|
|AC-24|分装配方/未开封/整包装区分|packaged-return-evidence；整瓶/按杯配置；existing unopenedReceived=false拦截|
|AC-25|整瓶错误配置保存拦截|immutable reservation packaging集成：500合法、330不合法、glass45合法；不回填旧数据|
|AC-26|重复/并发/权限/当前条件重查|new captured package并发；preview执行同函数；quantity物理权限/批次回归|
|AC-27|钱退、实物暂停、新通知待知悉|browser pending分项；quantity acknowledges only shown notice versions|
|AC-28|实物与通知独立完成/失败恢复|quantity retained completed stop in handover、notice idempotence；browser不写关闭|

## 执行与交付状态

- 新增浏览器首轮4/4通过，覆盖长错误、缩小可见视口、放大字体、轮询、在途关闭重开、子层退出；最终专项5/5通过；打印页320/390两项复跑也通过。
- 完整check已通过（单元1799通过，710按环境跳过），构建和类型检查通过；新增迁移203清单已同步。
- 定向数据库原142项回归通过；新增包装/关联回归在独立PostgreSQL16验证，完整数据库2,180通过/1条件跳过；全浏览器72通过/11条件跳过/1临时404，单独复跑打印页2/2通过。404与本地构建重写静态文件时间重叠，独立进程无此问题；最终精确提交由CI再次全量验收。审批原子回滚和通知分期补测5/5通过，离店重做预检、通知阶段及新增原子回滚补齐后，完整售后文件最终146/146通过（19.33秒）；曾单独筛选打印测试遗漏前置路由，完整文件复跑已覆盖。
- 本地证据在`artifacts/aftersales-fix-20260914/`及`artifacts/normalized-browser/`；日志、图片不包含生产密钥，不将本地模拟支付作为实际渠道验收。
- 提交前最终check通过，售后数据库146/146通过；准备提交合并及标签CI，正式部署和线上回读按实际结果追加。
- 现场保留项：iPhone微信软键盘/方向/字体实际可退出、瓶身规格与库存负责人核对、真实实物收回/损耗及岗位知悉。未授权虚构这些业务事实，不以清空待办为验收。

发布前复核补齐：R5受控日志增加tenantId/storeId、命令及refund_decision_guard阶段，并逐字段测试；R4收银静默刷新失败显示延迟且保留原记录。PR234已合并3511bce，PR CI74条浏览器通过。rc.198未部署，目标改rc.199，标签保留。最新原单只读状态：退款成功¥78、实物暂停1份、岗位通知0条待知悉。

补齐项最终本地验证：完整check1799通过/710条件跳过；支付接口49通过（包含日志逐字段断言）；专项浏览器5/5通过，收银静默刷新失败保留原记录、提示延迟；商品原单数据库关联保护再次验证通过。
