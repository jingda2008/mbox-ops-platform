# M-BOX 服务人员操作审计：第二轮新增问题

日期：2026-09-20。承接[第一轮操作审计](/Users/jingda/mbox/mbox-ux-audit-20260920/docs/staff-operator-audit-20260920.md)，本轮继续查找其他问题，不修改业务源码。

## 本轮结论与证据范围

新增确认 **5 个问题点**，其中优先处理多人转桌的旧状态提交、同设备跨页面切换员工后的操作身份不一致。成功提示被读回失败覆盖、未知回执后重试，与第一轮发现属于相近的恢复逻辑问题；这里按业务入口单列整改，不把出现次数当成独立安全漏洞总数。

- 基线：SHA `887461043e521463f73b9bd17efa381e4eeea6ad`，`1.0.0-rc.214`，schema 222。本轮通过远端 main 查询确认与第一轮相同；未核验生产部署身份。
- 实际执行：Chromium 手机视口 390×844，真实网页、应用服务与 PostgreSQL 16 隔离数据库，本机端口 18893。按门店员工夹具登录李艳、冷言志、三沐。
- 两个 P1 场景均没有网络故障注入；其余场景明确标注为读回失败、延迟真实响应或丢失成功回执。
- 团购平台使用 `MBOX_VOUCHER_MODE=test` 的模拟适配器。可以证明网页、后端和本地核销记录的状态问题，不能证明真实四平台已经发生核销事故。收付款模拟，通知和打印 worker 关闭。
- 既有定向测试 **5 文件、43 项全部通过**，含真实数据库集成与单元/API 测试。另完成下述 5 个探索场景和 3 类对照检查。第一轮 102 项浏览器与 97 项后台结果保留为前次证据，本轮没有重跑或重复计数。
- 本轮为审计交付；下列项目均待整改。没有提交、推送、部署、真实资金操作或顾客消息发送。

## 新增问题清单

| 编号 | 清单编号 | 优先级 | 服务人员实际遇到的情况 | 证实的结果 |
|---|---|---|---|---|
| OP-09 | SYS-277 | P1 | 两人都在原桌上准备转桌，分别选不同目标 | 两次均成功；第二次实际从第一人的目标桌继续转走，页面却仍说从原桌转出 |
| OP-10 | SYS-278 | P1 | 同一浏览器另一页切了员工，旧页表头仍是原员工 | 旧页提交开台，记录归属新员工；之后读回才退回登录 |
| OP-11 | SYS-279 | P2 | 券已核销，随后列表刷新失败 | 成功提示被网络错误覆盖，仍显示没有核销记录；重复办理被后台拦截，但错误直接显示英文 |
| OP-12 | SYS-280 | P2 | 查询券期间改了券码，旧查询结果随后返回 | 确认框显示旧券，提交却带新券；后台以 400 拒绝，没有核销错券 |
| OP-13 | SYS-281 | P2 | 建立活动草稿已成功，网络丢失回执后原表单重试 | 同一份资料建立两份独立草稿；未发布，未产生报名或扣款 |

优先级是依据本轮影响范围作出的整改判断，不是线上事故等级或发生频率统计。

## OP-09：两人转桌，第二人的旧确认会移动已变更位置的桌次

复现步骤：

1. 李艳将空闲 VIP4 开台，2 人。李艳和冷言志分别使用独立登录的两个浏览器上下文，均打开 VIP4 的桌台操作。
2. 李艳选择转往 VIP5；冷言志仍在 VIP4 的旧页面，选择转往 666。
3. 先提交李艳的转桌，再立即提交冷言志的转桌。没有修改请求内容，也没有暂停轮询或伪造接口结果。

两次实际返回均为 200。数据库事件为：

| 顺序 | 操作员工 | 实际源桌 | 实际目标 | 桌次位置版本 |
|---|---|---|---|---|
| 1 | 李艳 | VIP4 | VIP5 | 1 |
| 2 | 冷言志 | VIP5 | 666 | 2 |

同一个桌次 `47609020-1d30-4fc0-978e-dcfe20a0dcfa` 最后位于 666。第二位员工提交前仍看到 VIP4，成功提示也是“VIP4 已转至 666”，与第二条真实转桌事件不一致。

本轮使用没有订单和服务任务的 2 人桌。已经证明的是位置变更与确认对象不一致；由此导致送错商品、顾客扫码异常或员工协调失误属于现场风险推断，没有声称本次测试已发生这些后果。

源码原因：

- [前端确认](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-ui/staff-actions/StaffActionsPanel.tsx:765)根据旧桌台状态生成提示；[请求](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-ui/staff-actions/staff-actions-api.ts:577)只提交桌次 ID 与目标桌，没有当时所见的源桌或位置版本。
- [后端转桌](/Users/jingda/mbox/mbox-ux-audit-20260920/server/normalized/table-management-repository.ts:736)正确加锁，但锁住之后读取的是桌次**现在**所在的桌，不核对员工确认时的位置。串行化避免同时修改，并不等于拒绝过期意图。
- 数据库已有 `location_version`，但这条整桌转桌路径没有把它作为确认前提。

整改与关闭条件：确认绑定桌次及所见位置版本；在同一事务内检查，发现已转桌就提示当前桌位并要求重新确认。重放已成功的原操作应先返回原结果，不能被新版本误拒绝。验证两人同时转桌、A→B→A、正常连续转桌、目标被占、回执丢失，以及顾客扫码/订单/服务任务归属。

证据：[additional-exploration.json](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/additional-exploration.json) 的 R2-04、[数据库结果](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/db-evidence.txt)。同文件活动场景的首次失败是测试资料未填完，后续在单独脚本补齐，不计作另一缺陷。

## OP-10：旧页显示原员工，操作以新员工身份提交

复现步骤：

1. 同一浏览器的页面 A 以李艳登录，打开空桌并填 2 人，停在“确认开台”。
2. 页面 B 通过正常“切换账号”输入冷言志和有效 PIN，切换成功。
3. A 页仍显示“李艳”，在下一次身份变化识别之前点击确认。

A 页的请求返回 201，数据库 `opened_by_employee_id` 为冷言志。原始样本为 VIP3；补充截图样本为 888，均相同。888 桌次为 `4f70367b-a2b5-4049-a2d9-d86971e8f919`。随后业务页读回发现员工变化，退回登录，**不能撤回此前已成功的开台**。

[提交前旧页截图](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/r2-identity-old-form-before-submit.png)显示李艳与待确认的 888；[另一页当前员工](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/r2-identity-new-employee.png)显示冷言志；[后续登录页](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/r2-identity-eventual-login.png)证明并非永久保持旧身份。

边界：两个员工都经过有效认证，也都有开台权限。这是共享浏览器中“表头身份、页面所持操作上下文与当前 Cookie 身份”不一致的竞态，不是无 PIN 登录、权限绕过，或服务器把当前登录者认错。已证明开台归属变化；收款、审核等其他动作的实际后果尚未逐项复现。

源码原因：[切换账号接口](/Users/jingda/mbox/mbox-ux-audit-20260920/server/normalized/staff-auth-api.ts:94)替换浏览器共享会话 Cookie；[请求发送](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-api.ts:258)携带当前 Cookie。旧页没有随写请求带上并由后端核对“发起该操作时的会话身份”。[业务页读回](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-ui/staff-actions/StaffActionsPanel.tsx:256)有员工变化检查，[5 秒轮询](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-ui/staff-actions/StaffActionsPanel.tsx:423)及操作后刷新也会触发，但都可能晚于写入。

整改与关闭条件：写操作绑定发起时的会话身份，由后端核验；跨页面切换同步关闭旧操作界面。不能只缩短轮询间隔。验证切人后旧页提交、页面休眠恢复、切回原员工、旧回执晚到、原员工未知操作恢复，并逐项核对操作者与业务审计记录。

此项与已有 SYS-257 的待确认制作命令归属不同：本轮证明的是新写操作发出前，页面身份与共享会话已经不一致。

证据：[exploration.json](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/exploration.json) R2-03、[补充身份场景](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/identity-evidence.json)、[controls.json](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/controls.json)、[数据库结果](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/db-evidence.txt)。

## OP-11：团购已核销，刷新失败却覆盖成功结果

通过网页查询模拟美团券 `AUDIT-R2-RECEIPT-ONE` 并确认。核销 POST 真实返回 201，仅使随后的 GET 列表读取失败。页面清空券码和预览，显示“网络连接失败，请检查网络后重试”以及“本营业日还没有团购核销记录”。

实际核销记录 `901f958a-459a-42a9-8eed-e4fccbcdbb3d` 已存在，`provider_status=consumed`，并带模拟平台凭证 `sim-cert-PT-ONE`。由独立 API 读取和数据库查询共同确认。

同一券再查询、再确认，后台返回 409，核销记录仍只有 1 条，所以本轮**没有重复核销证据**。不过页面直接显示 `Voucher has already been redeemed`，没有中文业务说明或原核销记录入口。这是额外确认的文案与恢复问题，合并登记在本项。

源码：[GroupVoucherRedemptionPanel.tsx](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-ui/GroupVoucherRedemptionPanel.tsx:87)把写成功与列表读回放在同一 try/catch，读回失败覆盖成功提示；[商业接口](/Users/jingda/mbox/mbox-ux-audit-20260920/server/normalized/commercial-ops-api.ts:900)直接透传重复核销的英文异常。

整改与关闭条件：已成功的券保留成功凭证，列表失败只显示“已核销，记录列表暂未更新”，提供核对原记录/刷新入口；“无记录”只用于成功读取后的空结果。已核销、过期、不存在等常见错误用中文说明并给出下一步。恢复后的平台记录、数据库记录及结算金额一致。真实四平台仍按 SYS-268 独立验收。

证据：[成功被覆盖截图](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/r2-voucher-success-misreported.png)、[英文错误截图](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/r2-voucher-duplicate-english.png)、[exploration.json](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/exploration.json) R2-01、[重复核销对照](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/voucher-repeat-control.json)、[数据库结果](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/db-evidence.txt)。

## OP-12：查询旧券期间换码，确认信息与实际提交不一致

在查询 `AUDIT-R2-ORIGINAL-1111` 时，只延迟真实服务器回执。在回执到达前，将输入改成 `AUDIT-R2-NEXT-9999`。旧回执到达后，预览及最终确认框仍显示尾号 11 的旧券；实际 POST 却提交新券码以及旧查询凭证。

后台返回 400“券码与查询结果不一致，请重新查询”。[现有凭证绑定校验](/Users/jingda/mbox/mbox-ux-audit-20260920/server/normalized/commercial-ops-api.ts:452)有效，没有核销错券。影响是确认界面不可信和无效操作，并非后台金额或券码校验被绕过。

源码：[查询回执](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-ui/GroupVoucherRedemptionPanel.tsx:60)没有输入版本校验；改码只清空当下的 preview，晚来的旧结果又写回。[提交](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-ui/GroupVoucherRedemptionPanel.tsx:88)组合当前输入与旧 preview。

整改与关闭条件：查询结果绑定平台、券码及输入版本；编辑之后旧结果不能恢复为可确认状态。确认展示与提交使用同一个不可变快照。覆盖手输、扫码、切平台和慢响应；保留后端现有校验，不用放宽校验来消除报错。

证据：[exploration.json](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/exploration.json) R2-02、[旧券确认框](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/r2-voucher-stale-confirm.png)。

## OP-13：活动草稿成功但丢回执，原表单重试重复建档

管理者完整填写测试活动草稿，点击“建立草稿并读回”。让实际 POST 提交成功，仅丢弃成功响应。原表单仍保持新活动状态，页面提示网络失败。再次点击建立，同样返回 201。

数据库存在两份相同标题、时间、地点及容量的独立草稿：

- `community-activity-4b7c80e45addeb3c01c5e611`
- `community-activity-371b5ad69b094541fff31e72`

两条 status 均为 draft，published_at 均为空。已证明重复建档，没有发布两场活动、重复报名或扣款。

源码：[saveDraft](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-ui/ActivityOperationsPanel.tsx:181)在获得成功响应前仍认为是新草稿；每次点击用 [operationKey](/Users/jingda/mbox/mbox-ux-audit-20260920/src/normalized-ui/ActivityOperationsPanel.tsx:843)创建新的随机幂等键。未知结果重试被服务端视为新的创建操作。

整改与关闭条件：为同一创建尝试保留稳定编号和结果查询入口，网络结果未知时恢复原创建；只有明确新建才更换编号。不能简单按活动同名去重，因为重复举办的活动可以同名。覆盖丢回执、关闭、刷新、切人、第二次真实新建和后续独立复核发布。

证据：[activity-exploration.json](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/activity-exploration.json)、[重复草稿截图](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/r2-activity-duplicated.png)、[数据库结果](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/db-evidence.txt)。

## 对照检查、覆盖与未验证边界

| 检查 | 结果 | 能说明什么 |
|---|---|---|
| 两名员工同时给同一空桌开台 | 1 次 201、1 次 409“已开台” | 同桌重复开台被拦住，不能把转桌问题概括为“所有桌台并发都失效” |
| 已核销券再办理 | 409，记录仍 1 条 | 本地重复核销保护有效；真实平台故障恢复仍需独立验收 |
| 新券码配旧查询凭证 | 400 | 后台绑定有效，错误在前端展示与提交一致性 |
| 跨页面切人后继续观察 | 写入完成后退回登录 | 有事后身份检查，但不能保证旧操作在写入前被阻止 |
| 5 个既有定向测试文件 | 43 项通过 | 覆盖内权限、开台冲突、团购凭证、活动状态等约束有效，未覆盖的跨页/跨操作竞态仍需新增回归 |

43 项日志在 [targeted-backend.log](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920/targeted-backend.log)。覆盖文件为 table-management-api、table-management-repository、commercial-ops-api、staff-auth-api、activity-operations.integration。

本轮不提供全部漏洞已穷尽的保证。新增场景之外的跨店授权、真实四平台、真机休眠与恢复、真实扫码设备、打印、跨营业日高峰协作仍保留验收边界。第一轮 OP-03 阻断的桌台记录与推荐规则完整服务链，也没有在本轮被模拟为通过。

## 对界面和未来 App 的直接调整要求

1. 每次确认明确绑定当前员工、业务对象及其版本；对象已被其他人改变时，解释变化并重新确认。
2. 分开呈现“提交中、已成功、结果待核对、仅列表更新失败”，每种状态只提供对应动作。成功凭证不能被后续刷新错误抹掉。
3. 草稿、查询结果与待确认操作按员工和业务对象隔离；切人、切桌、切券码时处理未完成内容。
4. 列表空态必须以成功读取为前提；保留旧数据时标明更新时间和更新失败。
5. 员工界面使用业务中文，例如“此券已核销，查看核销记录”。操作编号、位置版本、幂等键等保留在系统中，不要求服务人员理解后再恢复业务。

界面可以简化，但这些写入前提、成功凭证和异常恢复规则要先明确；否则改成 App 后仍会带入同样的错误。

## 复现资料

本轮脚本与证据集中在 [第二轮证据目录](/Users/jingda/mbox/mbox-ux-audit-20260920/artifacts/staff-operator-audit-round2-20260920)，已由仓库忽略，含测试夹具，不应整体加入提交：

- `start-audit.ts`：来自既有浏览器临时环境脚本，调整相对导入并启用团购模拟；业务代码未改。
- `explore.mjs`：OP-11、OP-12、OP-10。
- `explore-additional.mjs`：OP-09；活动初次资料校验未通过，后续见下一脚本。
- `explore-activity.mjs`：补齐必填资料后的 OP-13。
- `controls.mjs`、`identity-evidence.mjs`、`voucher-repeat-control.mjs`：对照检查与补充截图。
- `db-evidence.sql/.txt`：只读查询，核对上述实际写入。
- `targeted-backend.mjs/.log`：为 43 项定向测试单独创建并清理临时数据库。

复现必须使用新的隔离数据库和本地服务；这些测试会真实写入测试门店的数据。不要把脚本地址改成生产地址，也不要把同一问题多次复现产生的记录数视为新缺陷数。


环境清理：2026-09-20 16:32 CST，本轮服务已正常停止，临时数据库已删除，专用容器已移除；18893 / 55442 均已关闭。其他工作环境未操作，证据文件保留。


## 后续实施记录

2026-09-20：本文件保留发现时的证据和原设计建议。13 项实际问题与36项术语的最新实施状态见 [逐项修复与验证](staff-operator-fix-verification-20260920.md)。原文中的“未修复”属于审计时点，不能据此覆盖后续验证；也不能将本地修复等同于正式 App 或现场验收。


### 2026-09-20 19:27 CST 界面增补核对完成

本轮本地修复核对扩展至OP-17，并补齐统一会员工作台、统一待办、桌台主操作/更多及跨页面返回。107个不同浏览器用例取得通过，12组操作与故障恢复通过；历史发现与计划保留，实际完成范围以[最终逐项核对表](staff-operator-fix-verification-20260920.md)为准。未上线，原生App与现场验收仍独立列示。
