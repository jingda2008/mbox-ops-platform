# 本地有限恢复候选，尚未启用

此目录新增 `supervisor.mjs` 和隔离测试。未修改 Windows 服务配置、未安装、未启动真实打印桥。生产启用须先核验现场版本、服务退出行为、完整进程树终止和防重复日志，在维护窗口独立验收。不要直接用旧主干的渲染器覆盖现场 1.0.11/1.0.12。

## 行为

仅启动同目录固定的 `bridge.mjs run`，不接收远程命令或任意可执行路径。桥在 `MBOX_PRINT_BRIDGE_DATA/progress.json` 写入 `{updatedAt: ISO}`，每次主循环（包括网络错误退避期间）应刷新。120 秒没有属于本次启动的新进展才终止子进程树并恢复。启动时有 120 秒宽限；旧文件、未来时间、损坏文件不能续命。

Windows 使用固定 `taskkill.exe /PID <child PID> /T /F` 终止挂起的整棵子进程树，只有确认关闭才能恢复。进程自然退出但 journal 仍有 printing 项时保守停止，防止孤儿 PowerShell 与新桥并行。任何终止都不删除/修改 `journal.json` 或 Windows 打印队列；已有未决任务依然需要核对实体纸票，绝不因恢复而自动补打。

每 10 分钟最多 2 次自动恢复。预算写入 `supervisor-budget.json` 并 fsync/rename，跨 supervisor 重启保留。耗尽、时钟回拨、预算损坏、未确认终止、异常上次退出都闭锁，不在过窗后自行重启。闭锁退出码为 0，避免 WinSW 按崩溃无限重启。已有锁时不擅自判断为过期，不拉起第二个桥。

网络错误本身不触发重启：只要主循环仍有进展，继续按桥自己的网络退避处理。此程序不重启 Windows Spooler、不重启电脑、不清空队列、不改变凭据和系统安全设置。

## 状态与告警边界

`supervisor-status.json` 为固定字段 `{version,kind,reason,updatedAt}`，kind 包含 running、bridge_recovery、recovery_exhausted、stopped。可由桥读取后上传固定诊断事件。自动恢复耗尽时桥已停，无法保证立即把本地故障上传后台；必须由后台依据心跳失联建立待办。没有新增外发通知渠道。

闭锁解除必须由有权维护人员先确认旧进程树已停止、检查 journal 和实体票据、解决根因，再保留故障证据并有意解除本地锁/预算。这里不提供自动清理命令或一键解除，避免误操作破坏防重打证据。窗口中的两次恢复预算不能由普通桥循环重置。

## 已测与未测

`node --test deploy/windows-print-bridge/supervisor.test.mjs` 使用临时目录、注入时钟及模拟子进程验证预算、重启、进展、锁、损坏与失败路径，不调用真实打印机。

尚未验证：Windows taskkill/WinSW 实机行为、Windows 磁盘 ACL、掉电时文件系统持久性、驱动/硬件状态及物理出纸。通过本测试不代表现场已启用或已验收。
