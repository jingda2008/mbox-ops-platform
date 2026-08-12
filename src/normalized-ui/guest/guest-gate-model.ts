import type { GuestSessionView } from './guest-api'

export type GuestGateReason =
  | 'connecting'
  | 'waiting'
  | 'session_ended'
  | 'scan_required'
  | 'table_mismatch'
  | 'temporary_failure'

export function guestGatePresentation(
  reason: GuestGateReason,
  table: GuestSessionView['table'] | null,
  fallbackMessage: string,
): { kicker: string; title: string; description: string; note: string | null; action: string | null; alert: boolean } {
  const tableName = table?.displayName ?? table?.code ?? '本桌'
  if (reason === 'waiting') return {
    kicker: `${tableName} · 桌位已识别`,
    title: '欢迎入座，请联系服务人员开台',
    description: `请告知身边的服务人员为 ${tableName} 开台。无需重复扫码，开台后菜单会自动出现。`,
    note: '页面每 8 秒自动更新，开台完成后会直接进入菜单。',
    action: '立即刷新',
    alert: false,
  }
  if (reason === 'session_ended') return {
    kicker: `${tableName} · 本次服务已结束`,
    title: '感谢今晚相聚',
    description: '如果您换了位置或重新入座，请扫描新桌面上的 M-BOX 二维码继续。',
    note: null,
    action: null,
    alert: false,
  }
  if (reason === 'scan_required') return {
    kicker: '需要确认桌位',
    title: '请扫描桌面上的二维码',
    description: '为避免进入其他桌的订单，请用微信扫一扫重新扫描您面前的 M-BOX 桌码。',
    note: '不用输入桌号，也不要使用别人转发的页面。',
    action: null,
    alert: true,
  }
  if (reason === 'table_mismatch') return {
    kicker: '桌位信息不一致',
    title: '请扫描当前桌面的二维码',
    description: '这个页面和您所在的桌位没有对应上，重新扫描当前桌码即可继续。',
    note: null,
    action: null,
    alert: true,
  }
  if (reason === 'temporary_failure') return {
    kicker: '连接暂时不稳定',
    title: '网络有点慢，再试一次',
    description: fallbackMessage || '桌位信息还没有连接上，稍等片刻再试即可。',
    note: '如果多次失败，请让身边的服务伙伴协助。',
    action: '再试一次',
    alert: false,
  }
  return {
    kicker: table === null ? '正在识别桌位' : `${tableName} · 正在连接`,
    title: '欢迎来到 M-BOX',
    description: '稍等一下，我们正在为您连接桌边服务。',
    note: null,
    action: null,
    alert: false,
  }
}
