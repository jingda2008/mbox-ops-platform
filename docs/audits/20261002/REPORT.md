# 2026-10-02 代码审计

收尾时间：2026-10-02 23:48 CST。

结论：确认 4 项缺陷，其中 2 项 P1、2 项 P2。现有测试通过，不能据此认定安卓全功能完成或可替代网页正式营业。本轮只新增审计证据和更新风险台账，没有修改业务实现、提交、推送或部署。

## 审计基线和覆盖

- 工作树：`/Users/jingda/mbox/mbox-android-completion-integration-20261001`，HEAD `33168ef756cb2a8c7761ba134e8660d947d68614`，版本 rc.243，加当前未提交安卓集成变更；审计前已有 122 个跟踪文件改动，另有大量未跟踪原生源码。结论针对磁盘现状，不能只按 HEAD 复现。
- 清点 2,375 个源码/测试/脚本/迁移文件：server 953、src 406、Android 240、iOS 原生 107、database 283，其他见 [完整路径清单](source-inventory.json)。计数包含测试和构建脚本，不是产品功能数或逐行人工审阅数量。
- 全仓执行仓库现有检查链；人工重点审阅原生命令与永久回执、事务/提交边界、员工登录与授权、待确认请求恢复、员工/桌台配置、媒体选择上传、提醒、更新校验以及新增数据库权限约束。结合网页共享服务、会员/规则管理适配器核对合同。
- **覆盖限制**：没有逐行人工审阅全部 2,375 个文件，没有执行完整浏览器端到端或模拟器逐屏点击、真实资金、打印机、双设备、供应商推送、正式包覆盖升级。自动化通过不等于这些验收完成。生产状态本轮未重新查询。

## 确认缺陷

### AUDIT-20261002-01 · P1 · 表单校验失败后，安卓原请求无法退出

**触发**：新增区域，在“排序”填 `100001`，填写其他合法字段并确认保存。表单允许 7 位输入，`tableConfigurationCommand` 没有校验区域排序范围，因此生成并保存待发送命令。服务器限制 `-100000..100000`，返回 `400 TABLE_CONFIGURATION_INVALID`。

**影响**：`StaffAPIError.definitivelyRejected` 不识别该响应，`recoverLive` 不标记请求为 rejected。原请求被冻结，重试只会重复 400；`memberReady`、退出/切换员工都被未决请求阻断，且当前主管恢复只适用于服务任务。需要额外恢复处理才能继续使用这些入口。这里没有发生区域新增，不应把确定的输入问题无限保留为交易未知。

**定位**：[安卓命令校验](/Users/jingda/mbox/mbox-android-completion-integration-20261001/native/staff-app/android/app/src/main/java/com/mbox/staff/LiveTableConfiguration.kt:11)；[后端范围约束](/Users/jingda/mbox/mbox-android-completion-integration-20261001/server/normalized/native-table-configuration.ts:10)；[拒绝结果分类](/Users/jingda/mbox/mbox-android-completion-integration-20261001/native/staff-app/android/app/src/main/java/com/mbox/staff/StaffAPI.kt:48)；[未决请求状态处理](/Users/jingda/mbox/mbox-android-completion-integration-20261001/native/staff-app/android/app/src/main/java/com/mbox/staff/AppModel.kt:2674)。

**证据**：[安卓探针源码](Audit20261002ProbeTest.kt.txt) 第二个测试，证明越界请求可生成、可序列化且错误不释放；[真实 Fastify 路由结果](mbox-audit-20261002-area-probe.log) 证明提交前返回该 400。退出及恢复不可达结论来自状态分支检查，未执行 GUI 点击复现。

**修复方向/关闭条件**：提交前对齐表单范围；后端对原请求提供可信“未提交”结论，前端允许返回修改。不能简单把所有 400 当成可丢弃，否则可能误删已落库原请求。新增“本例可返回修改”和“已提交但响应丢失绝不丢键”回归。

### AUDIT-20261002-02 · P1 · 自己移交管理员权限后，已成功修改被返回为 403

**触发**：门店还有另一位有效权限管理员时，当前管理员通过个人权限把自己的 `staff.access.configure` 设为 deny。事务允许并完成修改、保存永久回执；事务之后 `deployPermissions` 再用当前操作者读取管理概览，此时权限已撤销，因此抛出 403。用原请求号重试仍因权限不足得到 403。

**影响**：后端修改事实上已生效，界面却无法确认成功。安卓继续保存未决请求，当前员工不能恢复；网页共用该服务，也会收到失败响应。不是越权成功，而是成功回执和权限移交处理错误。此缺陷存在于共享服务，不能全归因于新增安卓适配。

**定位**：[提交后的再次鉴权读取](/Users/jingda/mbox/mbox-android-completion-integration-20261001/server/normalized/staff-access-management-service.ts:240)；[原生权限发布调用](/Users/jingda/mbox/mbox-android-completion-integration-20261001/server/normalized/native-staff-administration-api.ts:64)；[恢复要求原权限](/Users/jingda/mbox/mbox-android-completion-integration-20261001/native/staff-app/android/app/src/main/java/com/mbox/staff/AppModel.kt:2336)。

**证据**：[隔离数据库探针](staff-lifecycle-probe.integration.test.ts.txt) 使用真实受限 LOGIN，确认第一次响应 403、永久回执已有 1 行、原请求重试仍 403，详见 [运行日志](mbox-audit-20261002-probes.log)。

**修复方向/关闭条件**：不让提交后的概览读取改变已成功操作的结果；只返回允许的最小原回执，并设计不恢复已撤销管理权限的结果核对途径。安卓不能把“刷新管理页面失败”当作“原修改未确认”。覆盖自己移交、他人撤权、回执丢失、同键恢复与网页兼容。

### AUDIT-20261002-03 · P2 · 门店口令表单的整分钟时间无法提交

**触发**：按表单示例填写 `2098-10-02T09:00:00+08:00`。编辑器调用 `OffsetDateTime.parse(...).toString()` 后变成 `2098-10-02T09:00+08:00`（省略零秒）。随后 `staffAdministrationCommand` 用必须含秒的 `serverInstant` 校验自身输出，抛出“服务器返回的时间格式不兼容”。这时还没有发送后台请求。

**影响**：常见的整点/整分钟口令有效期无法确认，错误文案又误指服务器。非零秒时间不受本例影响。

**定位**：[表单时间序列化](/Users/jingda/mbox/mbox-android-completion-integration-20261001/native/staff-app/android/app/src/main/java/com/mbox/staff/LiveStaffAdministrationView.kt:44)；[提交前时间校验](/Users/jingda/mbox/mbox-android-completion-integration-20261001/native/staff-app/android/app/src/main/java/com/mbox/staff/LiveStaffAdministration.kt:11)；[要求秒的格式](/Users/jingda/mbox/mbox-android-completion-integration-20261001/native/staff-app/android/app/src/main/java/com/mbox/staff/ServerTime.kt:8)。

**证据**：[安卓探针](Audit20261002ProbeTest.kt.txt) 第一个测试按实际表单转换后调用实际命令函数，稳定抛出 `DateTimeParseException`；[执行结果](mbox-audit-20261002-android-probes.log)。

**修复方向/关闭条件**：使用固定的 ISO 日期时间格式输出秒，或在输入边界支持省略秒。覆盖整分钟、非零秒、小数秒和时区，避免放宽无时区服务器时间的安全约束。

### AUDIT-20261002-04 · P2 · 同一请求号修改 PIN/口令仍被当作原成功请求

**触发**：用同一个幂等键重放员工 PIN 重置请求，仅把 PIN 改成另一组四位数。接口构造指纹时删掉了 `pin` / `credential`，仅保留 `secretConfigured=true`，所以新请求与旧请求指纹相同。

**影响**：接口返回 `200`、`replayed=true`、`pinConfigured=true`，但新 PIN 实际没有生效。相同写法也用于新建员工和更换门店口令。正常安卓已冻结并加密原载荷，因此本例不是所有日常重试必然发生，属于后端重复提交合同缺陷；没有发现由此泄漏明文 PIN。

**定位**：[秘密字段从指纹中完全移除](/Users/jingda/mbox/mbox-android-completion-integration-20261001/server/normalized/native-staff-administration-api.ts:49)。

**证据**：[隔离数据库探针](staff-lifecycle-probe.integration.test.ts.txt) 确认改 PIN 重放返回 200，而用改后的 PIN 登录失败；[日志](mbox-audit-20261002-probes.log)。

**修复方向/关闭条件**：保留秘密值的受保护等值校验，例如服务端密钥 HMAC，并将其绑定原请求、员工和作用域。不要把四位 PIN 明文或无密钥摘要写进审计。分别测试同键同密钥重放、同键换密钥冲突，以及历史回执兼容。

## 验证结果

| 检查 | 本轮结果 | 证据/限制 |
|---|---|---|
| 全仓 `npm run check` | 退出 0 | 含架构、发布元数据、质量证据、微信/支付宝静态与脚本测试、类型、lint、常规测试和构建；[日志](mbox-audit-20261002-check.log) |
| 常规 Vitest（check 内） | 2,289 通过 / 1,274 跳过 | 无 DB 环境的跳过不能算通过；其中 2 项为临时审计探针在此轮无 DB 运行时跳过，之后已移出常规套件 |
| 隔离 PostgreSQL 全套 | 2,962 通过 / 1 跳过 | 336 测试文件通过，实际受限 LOGIN，258 迁移；[日志](mbox-audit-20261002-postgres.log) |
| Android 全量单元测试 | 260 通过，0 失败/跳过 | 移除临时探针后重跑全部 68 类；[汇总](android-results-summary.json)、[日志](mbox-audit-20261002-android-final.log) |
| Android lint | 0 error / 12 warning / 12 hint | 含依赖更新、图标等提示，不等同于运行时安全证明；[日志](mbox-audit-20261002-android.log) |
| 网页兼容快速回归 | 326 通过 / 15 跳过，构建成功 | [日志](mbox-audit-20261002-web.log)，与全仓测试有重叠，不能相加当覆盖率 |
| 新增缺陷探针 | DB 2 测试和 Android 2 测试通过预期缺陷断言 | 这些断言证明当前缺陷存在，不是功能验收通过；源文件保存为 `.txt`，未留在正常测试套件 |
| `git diff --check HEAD` | 退出 0 | [日志](mbox-audit-20261002-diffcheck.log) |
| iOS 现有领域/合同脚本 | `verify-all.sh` 下 18 个脚本执行成功，退出 0 | [日志](mbox-audit-20261002-ios.log)；不含完整 App 构建或 UI 验收 |

当前没有生成覆盖率报告，因此不能把测试数换算成功能完成百分比。依赖 CVE 全面审计、渗透测试、全端 UI 回归不在此次已完成证据内。没有新增已确认的资金重复记账缺陷，不等于已证明所有支付/库存并发路径无缺陷。

## 原有未关闭事项

采购退回业务规则与实现、厂商实时推送配置、正式签名/线上更新发布、配套后台上线、真实支付退款/打印与整班经营验收，仍按商业化清单保持开放；本次没有将这些事项记作已完成，也没有用新增缺陷覆盖原清单。

## 复现材料说明

- 从仓库根目录，将 `staff-lifecycle-probe.integration.test.ts.txt` 复制到 `server/normalized/audit-20261002-probe.integration.test.ts`，执行本目录 `run-postgres-probes.mjs`（显式设置本机 `TEST_NORMALIZED_ADMIN_URL`），结束后移除该临时文件。脚本创建/删除独立测试库及受限测试角色，禁止用于生产地址。
- 将 `Audit20261002ProbeTest.kt.txt` 复制到 Android 同包 test 目录，仅运行 `--tests com.mbox.staff.Audit20261002ProbeTest`，之后移除临时文件。这些测试断言的是当前错误行为，修复后应反转为正确行为的回归用例。
- 所有复现凭据均为本地测试生成的数据，没有使用员工生产 PIN 或门店口令。
