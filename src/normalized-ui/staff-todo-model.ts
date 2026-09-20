import type { CashierWorkbenchRefund, CashierWorkbenchView } from '../shared/cashier-workbench-contracts'
import type { StaffBootstrapView } from '../shared/normalized-contracts'
import type { StaffAnnualGiftReservation, StaffDailySnackClaim, StaffOperationsData } from './staff-actions/types'

export interface StaffTodo {
  id: string
  domain: 'service' | 'member' | 'refund' | 'print'
  title: string
  detail: string
  owner: string
  next: string
  route: string
  state: 'action' | 'waiting'
  priority: number
  time: string | null
}
export interface StaffTodoSource {
  id: string; label: string; endpoint: string; route: string; limit?: number
  map(data: unknown): StaffTodo[]
}
export function todoRoute(route: string, id: string, parameters: Record<string, string> = {}) {
  return `${route}?${new URLSearchParams({ ...parameters, todo: id })}`
}
function rows<T>(data: unknown): T[] {
  if (!Array.isArray(data)) throw new Error('待办数据读取不完整，请重新读取')
  return data as T[]
}
export function uniqueStaffTodos(items: readonly StaffTodo[]): StaffTodo[] {
  const unique = new Map<string, StaffTodo>()
  for (const item of items) {
    const previous = unique.get(item.id)
    if (!previous || (previous.state === 'waiting' && item.state === 'action')) unique.set(item.id, item)
  }
  return [...unique.values()].sort((a, b) => (a.state === b.state ? 0 : a.state === 'action' ? -1 : 1)
    || b.priority - a.priority || (Date.parse(a.time ?? '') || 0) - (Date.parse(b.time ?? '') || 0) || a.id.localeCompare(b.id))
}

export function staffTodoSources(bootstrap: StaffBootstrapView): StaffTodoSource[] {
  const permissions = bootstrap.access.permissions
  const has = (...codes: string[]) => codes.some(code => permissions.includes(code))
  const navigation = new Set(bootstrap.navigation.map(entry => entry.code))
  const sources: StaffTodoSource[] = []
  if (navigation.has('tasks')) sources.push({
    id: 'service', label: '现场服务', endpoint: '/api/operations', route: '/staff/tasks',
    map: data => rows<StaffOperationsData['tasks'][number]>((data as StaffOperationsData)?.tasks).map(task => {
      const mine = task.assignedToActor || task.assignedEmployeeId === bootstrap.staff.id || task.backupEmployeeId === bootstrap.staff.id
      const canAct = has('service.execute') && (mine || task.assignedEmployeeId === null)
      return { id: `service:${task.id}`, domain: 'service', title: `${task.tableCode} · ${task.title}`, detail: task.detail ?? '查看服务要求后办理',
        owner: mine ? '我负责' : task.assignedEmployeeId ? '已安排负责同事' : '待安排', next: canAct ? '查看并处理' : '查看负责同事进度',
        state: canAct ? 'action' : 'waiting', priority: task.priority === 'urgent' ? 3 : task.priority === 'high' ? 2 : 1,
        time: task.dueAt ?? task.createdAt, route: todoRoute('/staff/tasks', `service:${task.id}`, { factId: task.id }) }
    }),
  })
  const memberRoute = navigation.has('member-fulfillment') ? '/staff/member-fulfillment' : '/staff/member-exceptions'
  if (navigation.has('member-fulfillment') && has('loyalty.redemption.fulfill')) {
    sources.push({ id: 'annual', label: '生日与节日礼遇', endpoint: '/api/staff/annual-benefit-reservations', route: memberRoute,
      map: data => rows<StaffAnnualGiftReservation>(data).map(item => ({ id: `benefit:${item.reservationId}`, domain: 'member', title: `${item.tableCode} · ${item.title}`,
        detail: `${item.quantity} 份 · 核对顾客后领取`, owner: '会员服务人员', next: '办理领取', state: 'action', priority: 1,
        time: item.expiresAt, route: todoRoute(memberRoute, `benefit:${item.reservationId}`) })),
    })
    sources.push({ id: 'snacks', label: '每日点心', endpoint: '/api/staff/annual-daily-snack-claims', route: memberRoute,
      map: data => rows<StaffDailySnackClaim>(data).filter(item => ['reserved', 'redeemed'].includes(item.status)).map(item => ({
        id: `snack:${item.id}`, domain: 'member', title: `${item.tableCode || '会员'} · ${item.title}`, detail: `${item.quantity} 份 · ${item.status === 'reserved' ? '待核销' : '已核销，等待制作与送达'}`,
        owner: item.status === 'reserved' ? '会员服务人员' : '制作与传菜同事', next: item.status === 'reserved' ? '核对并领取' : '查看交付进度', state: item.status === 'reserved' ? 'action' : 'waiting',
        priority: 1, time: item.expiresAt, route: todoRoute(memberRoute, `snack:${item.id}`) })),
    })
  }
  if ((navigation.has('member-fulfillment') || navigation.has('member-exceptions')) && has('loyalty.redemption.fulfill', 'loyalty.redemption.exception')) sources.push({
    id: 'redemptions', label: '积分兑换', endpoint: '/api/staff/loyalty/redemptions/pending', route: memberRoute,
    map: data => rows<{ publicId: string; memberNo: string; itemName: string; pointsUsed: number; expiresAt: string }>(data).map(item => ({
      id: `redemption:${item.publicId}`, domain: 'member', title: `${item.memberNo} · ${item.itemName}`, detail: `${item.pointsUsed} 积分 · 核对实际交付结果`,
      owner: '会员服务人员', next: '查看兑换', state: 'action', priority: 1, time: item.expiresAt, route: todoRoute(memberRoute, `redemption:${item.publicId}`),
    })),
  })
  if (navigation.has('member-exceptions') && has('loyalty.redemption.exception')) sources.push({
    id: 'member-exceptions', label: '礼遇出品异常', endpoint: '/api/staff/complimentary-fulfillment-exceptions', route: '/staff/member-exceptions',
    map: data => rows<{ id: string; tableCode: string; title: string | null; status: string; updatedAt: string }>(data).map(item => ({
      id: `member-exception:${item.id}`, domain: 'member', title: `${item.tableCode} · ${item.title || '会员礼遇'}`,
      detail: item.status === 'failed' ? '自动重试已停止，请核对是否实际交付' : '正在重试制作通知', owner: '会员异常处理人员',
      next: '查看并核对原记录', state: item.status === 'failed' ? 'action' : 'waiting', priority: 2, time: item.updatedAt,
      route: todoRoute('/staff/member-exceptions', `member-exception:${item.id}`),
    })),
  })
  if (navigation.has('payments')) sources.push({
    id: 'refunds', label: '退款', endpoint: '/api/payments/workbench?limit=100', route: '/staff/payments', limit: 100,
    map: data => {
      const view = data as CashierWorkbenchView
      const result: StaffTodo[] = []
      const addRefund = (refund: CashierWorkbenchRefund, title: string, parameters: Record<string, string>, provider: string) => {
        if (!['requested', 'approved', 'processing', 'failed'].includes(refund.status)) return
        const approve = !refund.afterSalesCase && refund.status === 'requested' && view.actions.canApproveRefund && refund.requestedByEmployeeId !== bootstrap.staff.id
        const manual = ['cash', 'physical_pos', 'external_manual'].includes(provider)
        const execute = !refund.afterSalesCase && view.actions.canExecuteRefund && (refund.status === 'approved' || (refund.status === 'processing' && (manual || refund.providerSubmissionState === 'not_started')))
        const id = `refund:${refund.id}`
        result.push({ id, domain: 'refund', title, detail: `¥${(refund.amountMinor / 100).toFixed(2)} · ${refund.status === 'requested' ? '等待独立审核' : refund.status === 'approved' ? '已审批，待退款' : refund.status === 'failed' ? '退款未完成，需核对' : '退款处理中'}`,
          owner: approve || execute ? '我可处理' : refund.status === 'requested' ? '其他有审批权限的同事' : '退款经办人员',
          next: refund.afterSalesCase ? '查看原售后单' : approve ? '复核申请' : execute ? '查看退款执行' : '核对退款进度',
          state: approve || execute ? 'action' : 'waiting', priority: 2, time: refund.createdAt, route: todoRoute('/staff/payments', id, parameters) })
      }
      for (const order of rows<CashierWorkbenchView['orders'][number]>(view?.orders)) for (const payment of order.payments) for (const refund of payment.refunds) {
        addRefund(refund, `${order.tableCode} · 商品退款`, { orderId: order.id, query: order.publicId }, payment.provider)
      }
      for (const registration of view.activityRegistrations ?? []) for (const refund of registration.payment?.refunds ?? []) {
        addRefund(refund, `${registration.activityTitle} · 报名退款`, { registrationId: registration.id, query: registration.publicId }, registration.payment!.provider)
      }
      return uniqueStaffTodos(result)
    },
  })
  if (navigation.has('devices') && has('print.view', 'print.view_all', 'print.reprint', 'hardware.manage', 'printer.manage')) sources.push({
    id: 'printing', label: '打印失败', endpoint: '/api/hardware/print-jobs?status=failed,dead&limit=100', route: '/staff/devices', limit: 100,
    map: data => rows<{ id: string; printerName: string; sourceReference: string; status: string; createdAt: string }>(data).map(job => {
      const canAct = has('print.reprint', 'printer.manage') || (job.status === 'failed' && has('print.retry'))
      return { id: `print:${job.id}`, domain: 'print', title: `${job.printerName} · 票据未完成`, detail: job.sourceReference,
        owner: canAct ? '我可处理' : '有打印处理权限的同事', next: '核对原票与设备', state: canAct ? 'action' : 'waiting', priority: 2, time: job.createdAt,
        route: todoRoute('/staff/devices', `print:${job.id}`, { printJobId: job.id }) }
    }),
  })
  return sources
}
