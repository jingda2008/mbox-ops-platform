# 打印桥1.0.13可安装升级版 — 2026-11-14

当前结果：用户要求完成新版验证修复并交付直接升级包。已在隔离Windows Server 2022、Windows PowerShell 5.1.20348.5773、Node 22及真实WinSW服务和Windows spooler上通过验证。未操作门店电脑、服务、队列或真实订单；门店安装和实体出纸仍待实际验收。

## 下载产物与准确来源

- 安装包：`MBOX-PrintBridge-1.0.13-OneClick-r1.zip`（1.0.11现有安装的升级包，不用于新电脑首次配对）。
- SHA256：`8c8fbf461f28df6ef95ef8b9df73d6130d906b5985c6167c001eaf1e9c85558a`。
- 通过验证的准确提交：`96d87e60f85f652afb2400d1830e7558cfbb9f88`；[Windows验证运行43601870819](https://github.com/jingda2008/mbox-ops-platform/actions/runs/43601870819)。交付的是该Windows运行上传的原始ZIP，回下载后重新核对ZIP完整性、全部34个manifest文件及归档摘要，未解包修改后冒充已验证包。
- 本机交付：`/Users/jingda/mbox/outputs/print-bridge-installable-20261114/verified/MBOX-PrintBridge-1.0.13-OneClick-r1.zip`；同目录有摘要、构建记录和Windows证据。完整日志在`/Users/jingda/mbox/outputs/print-bridge-installable-20261114/windows-final.log`。
- 源码与生成过程已经提交到`codex/print-bridge-113-installable-20261114`分支；本次不发布新后台版本，不变更rc294生产服务，也没有远程替门店安装。

## 保留与修复

以SHA256 `b7b6af7fae7b1e470487e4e835e8557374d9a0b4fee8fd7ca967cecfd97ba9d7` 的完整1.0.11-r1包为基线。保留旧版Node渲染函数、结构化票据参数、Logo、中文编码、纸宽、备注、切纸和Windows服务注册。45组样票×纸宽配置的原始输出字节与旧包完全一致；不是把仓库历史渲染器覆盖到门店。

只移植结束页/结束文档失败检查、诊断事件持久缓存和上传、损坏journal拒绝打印、已提交但HTTP回报失败不重复打印；未知打印结果保留不确定状态，不自动补打。未启用尚未现场验证的supervisor，不修改WinSW恢复策略、打印队列或配对凭据。

升级保留原空队列检查、完整原版哈希匹配、备份、停服后再检查、文件校验和事务回滚；新增诊断模块若原来不存在，回滚恢复时撤回新增文件。升级成功还须收到新版本心跳确认，不以SCM显示Running直接判定成功。修改过、混合、更高或非1.0.11版本拒绝覆盖；相同1.0.13可重复运行，验证健康后不重新停服。

## 验证范围

- Windows实际PowerShell5.1：45组原始字节、34文件摘要及所有交付PS1解析通过。
- 15项事务故障注入、6项从实际交付SendBytes提取的C#结束调用失败场景、17项诊断/丢回执/损坏日志测试通过。故障注入明确属于模拟，不当作实体设备证据。
- 10项Windows原生检查通过，详见[原始证据](print-bridge-113-windows-evidence.json)：原桥真实WinSW服务和心跳；实际交付PS1解析；篡改包拒绝；未知安装拒绝；在途journal拒绝并保留；损坏journal拒绝；新版心跳故意503后的真实停服、旧文件/原服务恢复和新增模块清理；1.0.11→1.0.13真实升级并确认新心跳及配置/journal不变；重复升级幂等；真实winspool Open/Start/Write/End/Close向隔离Generic/Text Only文件端口输出完全一致RAW字节，并拒绝不存在的队列。
- 服务、队列和HTTP后台均为隔离测试机/loopback夹具，没有接触门店资金或真实纸票。真实纸卷、缺纸、卡纸、型号驱动及人员看到/听到告警需门店验收，不能用文件端口或Windows回执代替纸票。

Windows首轮发现构建依赖系统默认字符集，已明确UTF-8；后续修正了测试误解析不随包交付的旧源码及测试服务缺少description字段。失败日志保留，最终准确提交全绿，不把失败运行计入通过。

测试WinSW来源：[官方2.12.0发布](https://github.com/winsw/winsw/releases/tag/v2.12.0)，测试下载摘要固定为`05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`。生产升级不会下载/替换WinSW。隔离打印队列使用[微软Add-Printer接口](https://learn.microsoft.com/en-us/powershell/module/printmanagement/add-printer)。

## 门店操作

1. 将ZIP完整解压到新文件夹，不放进原打印桥安装目录，也不在压缩包内直接运行。
2. 没有出单时，双击`MBOX-OneClick-Upgrade.cmd`，允许管理员授权。程序自动检查、备份、升级并确认新心跳；失败会尝试恢复原版。
3. 成功后后台应出现1.0.13心跳；刷新员工网页，按需开启打印提醒声音，并核对两台打印机的实体票。

升级本身不主动打印测试票、不清队列、不重新配对、不重放历史订单。可选`MBOX-Test-Only.cmd`只试打合成系统测试票，会用纸；如果提示未知版本、在途任务或manual-recovery-required，请保留提示和`upgrade-last-result.json`，不要反复强制执行或删除journal。
