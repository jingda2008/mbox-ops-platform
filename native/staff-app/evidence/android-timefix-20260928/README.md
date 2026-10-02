# Android 0.2.2 时间格式兼容修复

2026-09-28 20:20 CST

## 原因

用户真机截图：Text '2026-09-30 01:06:06.09+08' could not be parsed at index 10。StaffAPI.grant对成功响应expiresAt直接Instant.parse，而生产staff-session-repository.ts使用expires_at::text返回PostgreSQL日期文本。该值包含空格分隔和短时区+08，旧解析器不接受。原测试fixtures仅ISO格式，未覆盖生产文本。这是客户端解析缺陷，不是本截图所证明的口令错误；不需要更改口令或部署后端。

## 修复范围

新增serverInstant，统一接受显式时区的ISO与PostgreSQL时间；保留小数精度，按偏移转换实际时刻，不依赖手机时区，不假定缺失时区。日期/时间越界、无时区和过期准入仍拒绝。

统一设备准入、员工会话、心跳有效期、持久化恢复、业务权限租约、点菜上下文/草稿、责任分配、预订回执时间比较及历史导出。会话入口将时间规范化为UTC ISO；原品牌图标保留。

## 证据

- 修复前针对设备准入的1项回归失败，DateTimeParseException，与截图一致，见reproduction-before.log。
- 修复后152测试通过，0失败/错误/跳过，包含新增8项：截图原值/微秒、偏移等价、不同手机时区、非法/过期拒绝、设备准入Cookie、登录/心跳/恢复、点菜上下文与导出。
- ./gradlew :app:testDebugUnitTest :app:assembleDebug成功。
- apksigner签名验证通过；证书SHA256与0.2.1一致：8a4419da1eb035b3059adc284cf7b802c99e7ab539b9f590ed54d60e6593ddbf。
- emulator-5554覆盖安装成功；包com.mbox.staff.nativeapp，0.2.2(4)，未清除应用数据。
- 线上device-access空JSON检查返回400 AUTH_REQUEST_INVALID，接口存在；未尝试口令猜测、未修改任何账户或生产业务数据。
- 真机重新验证口令、真实员工登录及营业操作仍待验收；模拟器安装与桩接口回归不等于实际账号联调。
- 本次未改动或部署网页/后端/数据库，仅Android及证据清单；保留工作区其它既有改动。

## 安装包

/Users/jingda/mbox/outputs/native-installers/20260928/MBOX-Staff-0.2.2-Android-timefix.apk

SHA256：784b17bf0949b64330df38097fc854eb15e7fbde585f2fe328858671f12d6346

内部测试debug签名包，直接覆盖0.2.1安装，不要先卸载。重新输入原门店口令验证，然后用员工账号/PIN登录。无需后端同步部署；其它尚未发布的营业功能仍遵循原清单。
