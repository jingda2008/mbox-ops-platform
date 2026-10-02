# 在线更新开发证据 · 2026-09-27 02:02 CST

- 两端0.2.0/build2；自动/手动检查、更新说明及系统版本要求，原生更多入口与紧凑新版本提示。
- 开发preview与正式stable由编译配置固定；iOS正式渠道不接受TestFlight，所有链接只允许指定官方域名和路径。错误、404、无发布版本不会虚报最新。
- Android私有APK流式下载，HTTPS主机/路径约束，不跟随重定向；空间、大小、摘要、签名、原包名和递增版本验证，安装前再校验。FileProvider仅分享专用缓存，系统安装来源权限由员工自行确认；安装器启动不是安装成功。此代码非Google Play自动更新集成。
- 应用内安装前阻止未决订单/金融请求或正在进行业务，不退出/卸载/清空数据。未来存储迁移仍须逐版本验收；不能阻止系统自身的自动更新安排。
- 本地清单生成工具拒绝调试APK、错证书、重复/降级build及无效分发链接，原子写文件，保留另一平台；不执行上传部署。生产签名只由环境注入。

验证：iOS新增17项断言通过；Android全套39个JUnit通过，其中新增5个更新用例；Python发布工具2例通过，并用实际当前签名debug APK验证拒绝且不写清单。双端构建覆盖安装/启动成功，版本0.2.0（2）。日志、XML、产物hash见本目录ios-update-tests.txt、android-AppUpdateTest.xml、update-publisher-tests.txt及update-builds.txt。

CUA看到最终功能版前一构建启动；点击更多时工具报告Mac锁定且暂停自动解锁，后续版本页/按钮未完成检查。未绕过锁屏。Android未逐按钮验收；没有实际在线更新包下载/系统安装的端到端证据。

线上未激活：仓库中preview/stable均为空清单，未发布到服务器；没有正式Android签名或Apple真实更新链接；所有测试fixture链接均不可发布。需要确定分发方式、配置长期签名、发布真实包和HTTPS清单、真机验证后才可称“员工直接在线更新已可用”。当前风险NATIVE-20260927-05保持开放，原网页与后端源码未修改。

只读线上HEAD探测：stable.json返回HTTP404；preview.json本次连接失败（URLError），不推断其响应内容。没有发送员工cookie或凭据；见update-endpoint-probe.txt。
