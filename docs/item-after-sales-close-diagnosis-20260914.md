# 商品售后弹窗无法关闭及退库受阻诊断

核查时间：2026-09-14 21:55 CST。本次为诊断；没有修改业务代码、生产配置、退款、库存或通知确认记录。

## 结论与证据

1. **关闭入口被滚出视口。** 唯一“关闭商品处理”按钮在 dialog 的普通滚动 header 内，header 为 static。全局 installGlobalActionReveal 监听新增 role=alert，并对错误提示执行 scrollIntoView(block:start)，使错误前面的标题及关闭按钮滚出弹窗顶部。弹窗未提供遮罩点击关闭或底部关闭入口；手机没有常用 Escape 键。onClose 本身没有等待退款/实物完成的条件。
2. **退库报错由记录口径不一致触发。** 原单位库存关联扣减 quantity=500.000000，库存项“芙丝矿泉水”配置 base_unit=ml、item_type=bottle、package_volume_ml=330.000000。整包装校验要求消耗量为包装容量整数倍，500 % 330 != 0，因此返回 PRODUCTION_REVIEW_REQUIRED 及截图所示文案。不能据此认定水是配方成品；通用错误文案未展示真正的容量冲突。实际瓶身容量、原商品用量配置和历史配置变化来源尚未核实，不能猜测应把哪一项改成330或500，更不能直接改历史流水绕过保护。
3. **待办保留有未完成事实。** 原售后仍为 approved/completed_at=null；1份单位 production_state=ready、held_by_case_id为原申请、stopped_by_case_id=null，库存关联 consumed/return_movement_id=null。资金退款 succeeded，凭证2026091491071345。21:34:12创建的吧台通知于21:34:16知悉；21:43:14审批另生成的吧台通知尚未知悉。尚待核对实物并完成相应岗位通知，不能把退款成功等同于整笔售后结束。

## 隔离复现

采用与运行版本一致的原源码组件、CSS及全局自动显示脚本，模拟照片所示的已批准、资金完成、实物暂停状态；本地请求全部拦截，退库错误为夹具返回，未请求生产业务接口。

- 源码工作树：/Users/jingda/mbox/mbox-staff-session-release-20260914，97e0cb89a8b3cbc2498773d91b15128630399def；线上容器只读核对仍为rc.197。
- Chromium 390×650视口：初始关闭按钮top=35、bottom=79；报错自动滚动80px后top=-45、bottom=-1，完全不可见；捕获到自动scrollIntoView目标为红色错误提示。
- 点击遮罩未关闭；将弹窗scrollTop恢复0后点击原关闭按钮，弹窗正常卸载。未发现关闭操作被后台业务状态禁止。
- [复现截图](/Users/jingda/mbox/requirements-assets/20260914/item-after-sales-close/chromium-error.png)、[测量和滚动调用](/Users/jingda/mbox/requirements-assets/20260914/item-after-sales-close/chromium-result.json)。原两张附件及隔离脚本同目录保留；脚本原执行位置是上述源码工作树的artifacts/close-diagnostic。
- 此为Chromium移动视口复现，未在用户iPhone微信WebView中直接操作。WebKit运行时未安装，启动未成功；不把本次结果表述为iOS实机测试通过。截图与复现结果一致，但原机具体滚动手势/事件轨迹没有抓取。

## 源码定位

- src/normalized-ui/ItemAfterSalesPanel.tsx:60—61：原生dialog、唯一关闭按钮及cancel事件。
- src/normalized-ui/item-after-sales.css:1—3：弹窗overflow:auto、header未固定。
- src/global-action-reveal.ts：MutationObserver监听role=alert后自动scrollIntoView；没有为弹窗保留关闭栏可见区。
- server/normalized/item-unit-inventory-repository.ts:162—169：ml整瓶回库校验与通用错误提示。
- server/normalized/item-after-sales-progress-repository.ts:66：实物与资金都完成才将对应售后标为completed；岗位通知在查询中单独计算待知悉数量。

## 修复方向与当前操作边界

关闭栏固定可见、内容独立滚动，调整错误定位避免隐藏关闭栏，并验证长内容、报错、软键盘及请求在途时的退出。关闭弹窗仅退出查看，不撤销已提交动作，重开读取原结果。库存问题需核实瓶身与原扣减来源，修正数据口径及可退库能力提示；不能把所有ml物料放开回库，也不能为了消除待办登记虚假损耗或虚假岗位知悉。

临时退出可尝试在弹窗内部向下滑动，回到内容最顶部，点击“关闭商品处理”；本机隔离复现中该路径正常。关闭后待办仍可存在。实物是否已收回/未开封需现场事实，不能由后台推断。

事故退款已成功，不再次退款。新风险SYS-225（关闭入口）与SYS-226（容量冲突及退库引导）继续开放；本次仅定位，不代表已修复。


需求转化记录（2026-09-14 21:58 CST）：用户要求已纳入[专项修改需求](refund-approval-entry-requirements-20260914.md)R6—R8，关联REQ-04-CLOSE/RETURN、SYS-225/226及AC-16—28。本文原诊断及证据边界保留，需求形成不代表修复完成。
