const reasons:Record<string,string>={
 payment_before_policy_change:'此到账事件早于自动收据规则启用时间，不自动补出历史票据；如需纸票请从原订单手动打印',
  print_policy_disabled:'此类自动打印已在配置中关闭，本次正常跳过；不补出关闭期间的历史票。',
 print_route_missing:'当前没有已启用且连接有效设备的对应打印路由，请到设备路由配置补齐。',
 print_no_eligible_lines:'本次没有符合该票种与路由条件的明细，未生成纸票；请核对原业务明细及票种设置。',
 print_order_not_active:'订单已取消或仍为草稿，本次不生成出品票。',
 print_payment_not_confirmed:'原付款尚未确认成功，不生成已收款凭条。',
 print_refund_not_confirmed:'原退款尚未确认成功，不生成已退款凭条。',

 printer_queue_not_found:'终端未找到所配置的打印队列，请核对设备管理中的 Windows 队列名。',
 printer_unavailable:'打印机报告离线、缺纸或设备错误，请检查电源、连接与纸卷。',
 printer_spooler_failed:'Windows 打印队列报告失败，请检查系统打印队列和设备状态。',
 printer_access_denied:'打印桥服务没有访问打印队列的权限，请检查终端服务账号授权。',
 powershell_not_found:'终端缺少可用的 PowerShell，打印程序未启动，请修复打印桥运行环境。',
 invalid_ticket_snapshot:'票据内容格式不符合当前打印桥要求，请检查服务端与打印桥版本。',
 bridge_print_timeout:'终端打印超过等待时间，是否出纸尚未确认；先核对纸票和系统队列。',
 ambiguous_previous_attempt:'上次打印结果不明确，防重复保护已阻止再次发送；先核对实体纸票。',
 ambiguous_print_result:'本次实体打印结果不明确，先核对纸票，勿直接再次发送。',
 bridge_print_failed:'终端打印执行失败，原因尚未细分；请用任务编号核对终端日志与实体纸票。',
 print_source_materialization_failed:'票据生成失败，未新增成功打印任务；请按票据编号核对服务端生成日志。',
}
export function printFailureReason(code:string|null|undefined):string{return code?reasons[code]??`未识别的打印错误（${code}），请用任务编号核对日志及实体纸票。`:'历史记录未留存失败原因，请核对终端与实体纸票。'}
