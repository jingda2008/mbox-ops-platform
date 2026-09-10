export const PRINT_TICKET_KINDS = ['bar_production','kitchen_production','order_summary','delivery','cashier_settlement','cashier_payment','cashier_refund','table_settlement','daily_settlement'] as const
export type PrintPolicyKind = typeof PRINT_TICKET_KINDS[number]
export const PRINT_TICKET_LABELS: Record<PrintPolicyKind,string> = {
  bar_production:'吧台酒水制作单',kitchen_production:'后厨制作单',order_summary:'整单汇总单',delivery:'配送单',
  cashier_settlement:'预结算单（未收款）',cashier_payment:'支付凭证',cashier_refund:'退款凭证',table_settlement:'整桌结账归档单',
  daily_settlement:'营业日结单',
}
export interface PrintTicketPolicy { ticketKind: PrintPolicyKind; enabled: boolean; copies: number | null }
