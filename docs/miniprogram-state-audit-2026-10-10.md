# 微信小程序同类状态缺陷审计

审计基线：`4f1fbe0cff4e5bcb5f9a50c79a18dcc7973d540d`（rc252交付记录合并后主线）。`miniprogram/` 源码树与已上传的 `cf4fd13780a862cddaae9b8212dadc18fb0361d0` 完全相同。初次审计业务代码未修改，未执行生产请求、真实订单或付款；以下是加载实际页面/工具模块、控制接口响应顺序得到的本地复现，不等于已在顾客手机确认故障。

## 初次审计结论（2026-10-10 23:46 CST）

确认 **6类缺陷**，覆盖 **12个可复现时序**。优先修复确认后采用未复核购物车版本、返回页面后的提交锁残留。rc252解决的是提交冲突分支提前刷新失败，尚未覆盖下列其他入口。

扫描25个注册页面的异步操作、禁用状态和生命周期；重点逐路径复核点单、共享购物车、账单、用券、套餐升级、桌台请求隔离与原请求恢复，并检查服务/投诉、预约、会员卡/授权等相近模式。此范围不是所有功能逐行验收，也不涵盖平台审核、真机系统行为或后端资金全链路审计。

## 已确认问题

### MINI-AUDIT-20261010-01 · P1 · 确认后采用变化过的购物车

位置：`miniprogram/pages/order/index.js:2013-2041`，以及 `confirmCheckout` 1971-1993。

当付款状态尚未读取完成，顾客在购物车版本1点击确认，`submitOrder`先等待桌账。此时 `busy=true`，但 `checkoutLocked=false`，购物车轮询仍能刷新；同桌另一人加入或更换商品到版本2后，请求用的是等待结束时的 `cartGeneration/cartVersion`，不是顾客确认时的版本。已复现：确认100分的商品后，轮询带回900分的另一商品，最终checkout请求携带版本2。

已证实的是客户端会发送新版本，未执行真实扣款。后端版本冲突校验无法识别这一问题，因为客户端主动提交了最新版本；仍可能有库存、身份或优惠等其他门禁拒绝请求。修复应在最终确认时固定桌次、购物车代次/版本、优惠、备注，异步前置检查后如有变化则重新展示让顾客确认。复现 `D-confirmation-adopts-unreviewed-version`。

### MINI-AUDIT-20261010-02 · P1 · 离开再返回页面后提交状态无法解除

位置：`miniprogram/pages/order/index.js:854-863,1995,2143`；`miniprogram/utils/checkout-upgrade.js:81-101`；推荐分支 `order/index.js:1438`。

提交进行中离开点单页，`onHide`作废旧页面请求；返回同桌时 `preparePage`生成新请求，但仅换桌才清除 `busy`。原请求完成时，两个finally都因旧请求不再有效而跳过清锁。已复现 `orderReady=true / busy=true / checkoutLocked=true`，点击“继续确认”在 `openCheckout:1947`直接返回，原幂等记录虽然保留但重试入口不可用。成功返回/拒绝返回均需要覆盖，不应通过删除原订单尝试来解锁。

相同模式还影响套餐升级后的 `busy` 和推荐请求的 `recommendationBusy`。复现B、B2、B3三种场景。修复需把写操作的完成归属与页面读取代次分开，保证重进同桌可恢复操作，旧回调不覆盖新操作。微信原生界面是否触发对应生命周期需真机验证；普通页面离开/返回的代码时序已成立。

### MINI-AUDIT-20261010-03 · P2 · 旧轮询覆盖新的购物车

位置：`miniprogram/pages/order/index.js:1792-1799`、`updateCart:1781-1783`。

刷新只验证桌台请求仍有效，没有对比购物车代次/版本，也没有在响应落地时重新检查写操作或结账状态。已复现：加购响应将版本推进到2，随后旧GET将页面退回版本1；另一条实际提交成功路径先清空为第2代购物车，旧GET随后恢复第1代商品。会造成数量回跳、已提交商品重新出现，并诱发下一次409。

修复需对每个桌次执行单调版本接纳，或让写操作/提交使旧读取失效，同时覆盖刷新开始和结束之间的结账变化。复现A1、A2。

### MINI-AUDIT-20261010-04 · P2 · 刷新失败仍提示已刷新

位置：`miniprogram/pages/order/index.js:1831-1833,1885-1887,1913-1915`；套餐选项错误回读在1599-1604存在同样缺少await后二次归属检查。

加减商品、清空、移除三个分支遇到版本冲突后都忽略 `refreshSharedCart()` 的false返回值。断网导致刷新失败时，旧版本仍保留、`orderReady=true`，却明确告诉顾客“已为你刷新”。还复现了等待刷新期间换桌，旧分支覆盖新桌错误提示的情况。

修复需校验回读成功与操作归属，失败时展示实际状态并阻止按旧版本结账，提供重试入口；恢复成功后才重新开放。复现C的3个入口与C2。

### MINI-AUDIT-20261010-05 · P2 · 旧订单回调删除新订单的恢复记录

位置：`miniprogram/pages/account/index.js:142-145`。

账单页放弃旧订单请求的异常分支收到 `GUEST_CHECKOUT_ALREADY_PAID`、`GUEST_CHECKOUT_NOT_FOUND` 或 `GUEST_ORDER_ACCESS_FORBIDDEN` 后，无条件删除全局待付款/放弃付款记录。与点单页的同类分支不同，这里没有核对原订单、幂等键及桌次。

已复现旧请求仍在途时换到另一桌并保存新订单恢复记录，旧请求返回NOT_FOUND后新记录被删。删除的是客户端恢复线索，不是服务器订单，不能据此断言已重复扣款。修复应只清理匹配原记录的内容。复现E。

### MINI-AUDIT-20261010-06 · P2 · 换桌后账单支付按钮保留旧锁

位置：`miniprogram/pages/account/index.js:173-175,251-277`。

批量支付请求期间换桌，`loadData`重置了订单和旧 `busyOrderId`，没有重置实际用于禁用按钮的 `payingBatch`。原请求完成时因scope不同又跳过finally。已复现W21的新账单完成读取后仍 `payingBatch=true`，选择和支付入口无法使用。修复应按桌次切换重置本页显示锁，并独立保留旧付款请求的恢复信息；旧回调不得解除新付款的锁。复现F。

## 对照结果及已知跨平台漂移

4个对照用例通过：跨桌旧购物车响应能被现有桌次守卫拦住；不离页的明确提交拒绝正常解锁；服务请求离开再返回同桌后正常释放写锁；冲突后成功回读能更新版本。这说明缺陷集中在同桌读写交错、页面生命周期和个别无归属清理分支，不能把所有异步守卫都判定无效。

支付宝 `alipay-miniprogram/pages/order/index.js:2077-2083`仍保留“锁住时刷新、随后解锁”的旧提交冲突顺序，属于已登记的MINI-W20-20261010-01跨平台风险。其线上支付受 `alipayOnlinePaymentEnabled()`限制；本轮仅核对源码，不把潜在分支写成支付宝现网已发生故障，也未计入上述6类新发现。

## 验证和修复验收要求

- 现有 `release:miniprogram:test`：391通过、0失败、0跳过；静态检查167文件通过。原测试绿灯并未覆盖这些时序。
- 本轮独立复现：12/12复现当前错误行为；这是审计证明，不是修复验收。4/4对照通过。
- 可复跑证据：工作区父目录 `outputs/miniprogram-state-audit-20261010/`，包含 `harness.cjs`、`reproduce.cjs`、`controls.cjs`、结果JSON、`source-identity.json`、基线测试与静态日志。执行 `node .../reproduce.cjs` 和 `node .../controls.cjs`；夹具加载实际业务方法和请求守卫，替代接口及原生UI，不连接生产。代码改变后应重新核对源码摘要。
- 修复候选至少应将12个反例改为保护性回归，并测试弱网、同桌多人、提交时切后台/返回、换桌、原生支付返回、优惠及套餐升级；分别验收原幂等键保留、禁止重复扣款和按钮可恢复。

初次审计状态：审计及风险登记完成；当时尚未执行业务修复、提交合并、新候选上传与真机复测。上述行号均对应审计基线，修复后的方法见下表。

## 逐条修复（2026-10-11 00:08 CST，本地验证完成）

用户授权全部修复后，01—06均已修复，并将12个原反例纳入长期回归。边界复核新增并修复两类问题：

- **MINI-AUDIT-20261010-07，P2**：未知checkout已经在服务器成功后，下一次读取可能拿到空车，但底栏仅在cart.length非零时出现，openCheckout也提前返回。继续确认现在独立于车内商品/冻结限制，只重放原checkout记录，不组装新订单。
- **MINI-AUDIT-20261010-08，P1**：原生付款成功/取消回调取当前pendingPayment而未核对原付款身份。已复现跨桌、同桌换单及仅持久化记录被替换三种情况；旧成功可能把新单标记为已接受付款，旧取消可能队列化新单放弃操作。回调现在同时校验页面和持久化记录的原订单、付款、重试键及桌次。仅证明本地状态错写，未发生本次真实支付或取消，也不推断历史资金影响。

| 编号 | 修复位置（微信、支付宝同结构同步） | 回归保护 |
| --- | --- | --- |
| 01 | order.checkoutDraft / checkoutDraftMatches / confirmCheckout / submitOrder | 最终点击前固定内容；等待账单或升级检查时购物车变化必须再确认；备注、优惠报价保持；连续点击只提交一次；账单失败不落单 |
| 02 | order.preparePage / recommend / confirmCheckout / submitOrder；checkout-upgrade.acceptCheckoutUpgrade | 完成锁归属于操作，不依赖读请求代次；离页后未知/明确拒绝/成功均可恢复原幂等请求；旧提交/升级/推荐finally不解除新操作锁 |
| 03 | order.updateCart / refreshSharedCart | 同桌代次和版本单调接纳；旧读取不能覆盖加购、提交后空车或已锁定提交；换桌仍接受新桌自己的较低版本 |
| 04 | order.recoverSharedCart及加减、清空、移除、套餐选项、提交冲突入口 | 回读失败真实提示并禁用旧草稿提交；冲突前启动的读不能解除限制；后续成功轮询恢复；await后再校验归属；支付宝旧冲突先锁后刷漂移同步修正 |
| 05 | account.clearCompletedGuestPaymentAbandonment / executePendingGuestPaymentAbandonment | 终态仅清原订单/桌次/幂等记录；同桌及跨桌新记录保留；未知结果保留原记录 |
| 06 | account.loadData / paySelectedOrders | 换桌重置显示锁与选择；旧尝试保留；A→B→A后旧回调不解除新付款锁或删除新尝试 |
| 07 | order.openCheckout；index.wxml/index.axml底栏 | 空车及冻结状态仍可重放原未知checkout；正常商品提交保持原有门禁 |
| 08 | order.handlePaymentAction | 成功/取消回调×跨桌/同桌/仅持久化替换均不修改其他订单；原生窗口onHide仍不触发放弃付款 |

回归文件：`scripts/miniprogram-state-recovery.test.cjs`及`miniprogram-state-fixture.cjs`。加载实际页面、购物车转换、优惠/升级、请求守卫、支付参数校验；只替代网络、存储、原生UI和非相关展示。86项新增双端测试通过；原有抽取方法夹具补入新草稿辅助方法，页面夹具明确设置已加载状态、匹配真实请求守卫的scope/generation语义，原业务断言仍保留。

模板仅改变两个底栏条件，双端标签/事件/CSS没有变更；已有历史跨平台差异的精确模板摘要随本次审核更新，未放宽标签/事件/图片/样式或平台能力门禁。支付宝官方编译23页面通过；此命令仍报告SDK 1.x，只证明源码可编译，不替代IDE 2.x或真机。完整门禁已通过；候选未提交合并、部署或上传，开发者工具原生多尺寸截图、iOS/Android真机和W20现场因果仍独立待验。

### 最终验证记录

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 新增时序回归 | 86通过、0失败、0跳过 | `repair-after.log`；原12反例已转为保护性断言，另含新旧操作交错、原请求重放及正向对照 |
| 相同测试回跑原始HEAD | 68失败、18通过、0取消、0跳过 | `repair-baseline-regressions.log`；`git archive 4f1fbe0c`隔离源码，使用同一测试/夹具，68不是独立缺陷数量 |
| 小程序完整回归 | 477通过、0失败、0跳过 | `repair-full-check.log`中release:miniprogram:test，包含原391及新增86 |
| 双端静态/平台 | 微信167文件；支付宝23页面、5tab、13平台测试通过 | `repair-static.log`；历史差异仍用准确模板哈希绑定，未禁用门禁 |
| 全项目检查 | `npm run check`退出0；2463项目测试通过、1480环境依赖跳过；类型、lint、构建通过 | `repair-full-check.log`；跳过不计验收，原有lint/打包体积警告仍保留；后端运行代码和数据库未修改 |
| 支付宝官方编译 | 23页面、产物检查通过 | `repair-alipay-compile.log`，SDK 1.x命令口径，非IDE 2.x/真机完成 |
| 空车继续确认按钮 | 360/375/390px两端均可见、无横向越界，按钮几何差≤2px | `layout/geometry.json`及6张有“样式夹具·非真机”标识的截图；Playwright装载实际模板片段/CSS，未声称原生截图SSIM或支付验收 |
| 交付边界 | 本地未提交工作树；无本轮新合并/部署/上传/审核发布/真机操作 | `repair-source-identity.json`记录基线SHA和变更文件/日志摘要；线上和已上传rc252仍是此前版本 |

以上日志均位于工作区父目录 `outputs/miniprogram-state-audit-20261010/`。首轮审计的`reproductions.json`和`source-identity.json`保留为历史证据；原`reproduce.cjs`断言错误行为，不应用于修复验收。后续回归运行仓库内`node --test scripts/miniprogram-state-recovery.test.cjs`或`npm run release:miniprogram:test`。
