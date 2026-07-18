import type { RoleHomeNavigationId } from './role-access'
import type { OperationsConsoleView } from './OperationsConsole'

export type VoiceCommandResolution =
  | { kind: 'ready'; target: OperationsConsoleView; label: string; summary: string }
  | { kind: 'denied'; target: RoleHomeNavigationId; label: string }
  | { kind: 'unknown' }

interface CommandRoute {
  target: OperationsConsoleView
  label: string
  keywords: readonly string[]
  actionKeywords?: readonly string[]
}

const commandRoutes: readonly CommandRoute[] = [
  { target: 'home', label: '岗位工作台', keywords: ['首页', '工作台', '回到岗位', '返回岗位', '我的工作'] },
  { target: 'payments', label: '收银与支付', keywords: ['收银', '支付', '退款', '对账', '收款', '付款码'] },
  { target: 'reservations', label: '预约与到店', keywords: ['预约', '订金', '到店名单', '客人到店'] },
  { target: 'commerce', label: '订单与出品', keywords: ['订单', '点单', '下单', '菜品', '酒水制作', '待制作', '出品', '送餐', '送酒'] },
  { target: 'inventory', label: '库存与存酒', keywords: ['库存', '存酒', '盘点', '缺货', '原料'] },
  { target: 'benefits', label: '会员与权益', keywords: ['会员', '权益', '赠送', '优惠券', '召回'] },
  { target: 'songs', label: '演出与点歌', keywords: ['歌手', '演出', '排班', '点歌', '歌单', '舞台'] },
  { target: 'tasks', label: '服务任务', keywords: ['任务', '提醒', '投诉', '呼叫', '待处理', '要处理', '现在要做', '该做', '服务需求'] },
  { target: 'layout', label: '桌台布局', keywords: ['布局', '区域图', '桌台图'] },
  { target: 'master', label: '人员与主数据', keywords: ['员工', '人员', '岗位', '权限', '主数据'] },
  { target: 'config', label: '运营配置', keywords: ['配置', '规则', '服务流程', '系统设置'] },
  {
    target: 'live',
    label: '现场桌台',
    keywords: ['现场', '桌台', '开台', '翻台', '结台', '换桌', '转桌', '合台', '加桌', '暂未点单'],
    actionKeywords: ['开台', '翻台', '结台', '换桌', '转桌', '合台', '加桌'],
  },
]

function normalizeCommand(command: string) {
  return command.trim().replace(/[，。！？、,.!?\s]+/g, '')
}

export function resolveVoiceCommand(
  command: string,
  allowedNavigationIds: readonly RoleHomeNavigationId[],
): VoiceCommandResolution {
  const normalized = normalizeCommand(command)
  if (!normalized) return { kind: 'unknown' }

  const route = commandRoutes.find((item) => item.keywords.some((keyword) => normalized.includes(keyword)))
  if (!route) return { kind: 'unknown' }
  if (route.target !== 'home' && !allowedNavigationIds.includes(route.target)) {
    return { kind: 'denied', target: route.target, label: route.label }
  }

  const hasProtectedAction = route.actionKeywords?.some((keyword) => normalized.includes(keyword)) ?? false
  return {
    kind: 'ready',
    target: route.target,
    label: route.label,
    summary: hasProtectedAction
      ? `先打开${route.label}并定位操作；涉及业务状态变更时仍需在原页面核对并确认。`
      : `打开您有权限使用的${route.label}。`,
  }
}

export function voiceSuggestionsForNavigation(allowedNavigationIds: readonly RoleHomeNavigationId[]) {
  const suggestions: Array<{ command: string; target: RoleHomeNavigationId }> = [
    { command: '看看我现在要处理什么', target: 'tasks' },
    { command: '打开现场桌台', target: 'live' },
    { command: '查看待制作订单', target: 'commerce' },
    { command: '查看今晚演出安排', target: 'songs' },
    { command: '打开预约到店名单', target: 'reservations' },
    { command: '查看收银和退款', target: 'payments' },
    { command: '查看库存和存酒', target: 'inventory' },
    { command: '打开人员与岗位', target: 'master' },
    { command: '打开运营配置', target: 'config' },
  ]
  return suggestions.filter((item) => allowedNavigationIds.includes(item.target)).slice(0, 4)
}
