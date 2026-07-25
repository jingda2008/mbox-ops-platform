import type {
  AssistantCapabilityId,
  AssistantServerToolId,
  AssistantToolDescriptor,
} from '../src/shared/assistant-tool-contracts.js'
import type {
  AssistantCapabilityPolicyConfig,
  RuntimeState,
  StaffPermissionId,
} from '../src/shared/contracts.js'
import { effectivePermissionIdsForEmployee } from '../src/shared/staff-access.js'

type CapabilityDefinition = Omit<AssistantToolDescriptor, 'argumentGuide' | 'aliases'> & {
  aliases: readonly string[]
  argumentGuide?: Readonly<Record<string, string>>
}

const humanRefundGuard = 'AI不得提交、审批或调用退款渠道；只有人工操作和渠道回执可以改变退款状态。'

const definitions: Record<AssistantCapabilityId, CapabilityDefinition> = {
  'analytics.query': {
    id: 'analytics.query',
    name: '查询经营数据',
    description: '按受控指标、维度和营业日范围查询本人有权查看的经营数据',
    domain: 'analytics',
    executionMode: 'server_execute',
    risk: 'normal',
    requiredPermission: 'dashboard.view',
    aliases: ['经营分析', '数据统计', '销售排行', '服务分析', '帮我查数据'],
    argumentGuide: {
      metric: '必填：sales_amount销售额、sales_quantity销量、estimated_gross_profit预估毛利、order_count订单数、average_check桌均消费、guest_count到店人数、service_request_count服务需求数、service_completion_rate服务完成率、median_service_response_seconds响应中位数、complaint_count投诉数',
      dimension: '必填：none总计、product商品、category品类、table桌台、employee员工、party_size人数结构、business_date营业日、hour时段、service_type服务类型',
      period: '必填：current_business_day本营业日、previous_business_day上一营业日、last_7_business_days最近7日、this_month本月、last_month上月、custom自定义',
      limit: '选填，返回1至20项，默认10',
      sort: '选填，desc从高到低，asc从低到高',
      dateFrom: '仅period=custom时必填，YYYY-MM-DD营业日',
      dateTo: '仅period=custom时必填，YYYY-MM-DD营业日',
    },
  },
  'table.open': {
    id: 'table.open', name: '开台', description: '按桌号和实际到店人数开台并建立临客桌次',
    domain: 'table', executionMode: 'server_execute', risk: 'normal', requiredPermission: 'table.open',
    aliases: ['开台', '客人入座', '客人到了'],
    argumentGuide: {
      tableCode: '必填，现场桌号，例如L01', partySize: '必填，实际到店人数；不得猜测',
      customerName: '选填，未提供时使用现场客人', salesEmployeeId: '选填，员工ID或姓名；未提供时归属当前操作员工',
    },
  },
  'service.task.create': {
    id: 'service.task.create', name: '创建服务任务', description: '为指定桌台创建一条可派发、升级和追踪的服务任务',
    domain: 'service', executionMode: 'server_execute', risk: 'normal', requiredPermission: 'service.execute',
    aliases: ['安排服务', '创建任务', '叫人服务'],
  },
  'service.task.schedule': {
    id: 'service.task.schedule', name: '定时指派服务', description: '按指定时间、桌台、服务内容和员工创建一次性服务安排',
    domain: 'service', executionMode: 'server_execute', risk: 'normal', requiredPermission: 'service.execute',
    aliases: ['稍后提醒', '定时派单', '过一会安排'],
  },
  'service.task.accept': {
    id: 'service.task.accept', name: '接单', description: '接管一条当前员工有权处理的服务任务',
    domain: 'service', executionMode: 'server_execute', risk: 'normal', requiredPermission: 'service.execute',
    aliases: ['接单', '我来处理', '接下任务'],
    argumentGuide: { taskId: '必填，实时任务列表中的任务ID', note: '选填，接单说明' },
  },
  'service.task.arrive': {
    id: 'service.task.arrive', name: '确认到桌', description: '把本人已接单的服务任务更新为已经到桌',
    domain: 'service', executionMode: 'server_execute', risk: 'normal', requiredPermission: 'service.execute',
    aliases: ['已经到桌', '到桌了', '开始服务'],
    argumentGuide: { taskId: '必填，实时任务列表中的任务ID', note: '选填，到桌说明' },
  },
  'service.task.complete': {
    id: 'service.task.complete', name: '完成服务', description: '把本人已到桌的服务任务闭环并记录结果',
    domain: 'service', executionMode: 'server_execute', risk: 'normal', requiredPermission: 'service.execute',
    aliases: ['完成服务', '任务完成', '已经处理好'],
    argumentGuide: { taskId: '必填，实时任务列表中的任务ID', note: '选填，处理结果或说明' },
  },
  'payment.refund.request': {
    id: 'payment.refund.request', name: '人工申请退款', description: '打开收银工作台，由有权限员工核对原支付、商品、数量、金额和原因后提交',
    domain: 'payment', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'payment.refund.request',
    aliases: ['申请退款', '办理退款', '退钱', '退商品'],
    humanWorkflow: {
      navigationId: 'payments', instruction: '人工选择原支付和商品，填写数量与退款原因后提交申请。', resultGuard: humanRefundGuard,
      requiredAuditEvents: ['refund.requested.v1'], separationOfDuties: true,
    },
  },
  'payment.refund.approve': {
    id: 'payment.refund.approve', name: '人工审批并执行退款', description: '由不同员工复核退款申请，再在收银工作台人工审批并提交渠道或登记POS凭证',
    domain: 'payment', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'payment.refund.approve',
    aliases: ['审批退款', '批准退款', '确认退款', '退款打款'],
    humanWorkflow: {
      navigationId: 'payments', instruction: '审批人核对原单、可退余额、申请人、原因和凭证后人工操作。', resultGuard: humanRefundGuard,
      requiredAuditEvents: ['refund.provider.approved.v1', 'refund.provider.submitted.v1', 'refund.physical_pos.completed.v1'],
      separationOfDuties: true,
    },
  },
  'payment.pos.report': {
    id: 'payment.pos.report', name: '人工报送POS收款', description: '人工核对物理POS小票和流水号后报送，保持待对账状态',
    domain: 'payment', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'payment.pos_report',
    aliases: ['报送POS', '登记POS收款', '录入刷卡流水'],
    humanWorkflow: {
      navigationId: 'payments', instruction: '人工填写终端、流水号、方式和小票凭证。',
      resultGuard: 'AI不得虚构POS到账；人工报送后仍需对账。', requiredAuditEvents: ['payment.physical_pos.reported.v1'], separationOfDuties: false,
    },
  },
  'payment.cash.confirm': {
    id: 'payment.cash.confirm', name: '人工确认现金实收', description: '由收银员当面点验现金后确认实收',
    domain: 'payment', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'payment.pos_report',
    aliases: ['确认现金', '现金收款', '现金到账'],
    humanWorkflow: {
      navigationId: 'payments', instruction: '收银员点验现金并核对桌账金额后人工确认。',
      resultGuard: 'AI不得确认实际未点验的现金。', requiredAuditEvents: ['payment.cash.confirmed.v1'], separationOfDuties: false,
    },
  },
  'business_day.close': {
    id: 'business_day.close', name: '人工营业日关账', description: '人工核对开放桌、支付、退款、投诉和交班差异后关账',
    domain: 'business_day', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'business_day.close',
    aliases: ['关账', '关闭营业日', '日结'],
    humanWorkflow: {
      navigationId: 'payments', instruction: '人工完成收银交班、差异责任人和阻塞项核对。',
      resultGuard: 'AI不得绕过未完成事项强制关账。', requiredAuditEvents: ['business_day.closed.v1'], separationOfDuties: true,
    },
  },
  'config.publish': {
    id: 'config.publish', name: '人工发布配置', description: '人工检查配置草稿和影响范围后发布版本',
    domain: 'config', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'config.manage',
    aliases: ['发布配置', '上线规则', '配置生效'],
    humanWorkflow: {
      navigationId: 'config', instruction: '管理员检查草稿和版本差异后点击发布。',
      resultGuard: 'AI不得静默发布或覆盖配置版本。', requiredAuditEvents: ['config.version_published.v1'], separationOfDuties: false,
    },
  },
  'inventory.approve': {
    id: 'inventory.approve', name: '人工审批库存差异', description: '人工核对实物、批次、成本和原因后审批库存调整',
    domain: 'inventory', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'inventory.approve',
    aliases: ['审批库存', '批准报损', '确认盘亏'],
    humanWorkflow: {
      navigationId: 'inventory', instruction: '审批人依据实物和凭证复核后人工决定。',
      resultGuard: 'AI不得抹平库存差异或替代实物盘点。', requiredAuditEvents: ['inventory.approval.approved_and_executed.v1', 'inventory.approval.rejected.v1'], separationOfDuties: true,
    },
  },
  'benefit.approve': {
    id: 'benefit.approve', name: '人工审批超额权益', description: '人工核对客户、权益、成本、理由和额度后审批',
    domain: 'benefit', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'benefit.approve',
    aliases: ['审批赠送', '批准权益', '批准赠品'],
    humanWorkflow: {
      navigationId: 'benefits', instruction: '审批人核对额度、累计赠送和原因后人工决定。',
      resultGuard: 'AI不得拆单绕过赠送额度。', requiredAuditEvents: ['benefit.granted.v1', 'benefit.rejected.v1'], separationOfDuties: true,
    },
  },
  'commerce.authorization.approve': {
    id: 'commerce.authorization.approve', name: '人工审批折扣赠送', description: '人工核对商品、折扣、赠送额度和原因后审批经营授权',
    domain: 'commerce', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'commerce.authorization.approve',
    aliases: ['审批折扣', '批准赠送', '经营授权'],
    humanWorkflow: {
      navigationId: 'commerce', instruction: '审批人检查金额、额度和累计风险后人工决定。',
      resultGuard: 'AI不得批准自身发起的经营授权。', requiredAuditEvents: ['order.decide_authorization.v1'], separationOfDuties: true,
    },
  },
  'table.close': {
    id: 'table.close', name: '人工结台', description: '人工核对服务、出品、桌账和未决退款后结台',
    domain: 'table', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'table.close',
    aliases: ['结台', '闭桌', '客人离店'],
    humanWorkflow: {
      navigationId: 'live', instruction: '人工核对款项和未完成事项后点击结台。',
      resultGuard: 'AI不得绕过未决账务或服务事项结台。', requiredAuditEvents: ['table.closed.v1'], separationOfDuties: false,
    },
  },
  'table.transfer': {
    id: 'table.transfer', name: '人工转桌', description: '人工核对目标桌和关联订单、服务、点歌、权益后转桌',
    domain: 'table', executionMode: 'human_workflow', risk: 'high', requiredPermission: 'table.manage',
    aliases: ['转桌', '换桌', '换位置'],
    humanWorkflow: {
      navigationId: 'live', instruction: '人工选择来源桌和目标桌并核对迁移清单。',
      resultGuard: 'AI不得在目标桌冲突或账务不明时强制转桌。', requiredAuditEvents: ['table.transferred.v1'], separationOfDuties: false,
    },
  },
}

function serviceTypeGuide(state: RuntimeState) {
  return state.config.serviceTypes.filter((type) => type.enabled).map((type) => `${type.name}=${type.id}`).join('、')
}

function argumentGuide(definition: CapabilityDefinition, state: RuntimeState): Record<string, string> {
  if (definition.id === 'service.task.create') {
    return { tableCode: '必填，现场桌号', serviceTypeId: `必填，${serviceTypeGuide(state)}`, note: '选填，现场需求补充说明' }
  }
  if (definition.id === 'service.task.schedule') {
    return {
      tableCode: '必填，已开台的现场桌号', serviceTypeId: `必填，${serviceTypeGuide(state)}`,
      delayMinutes: '必填，0表示立即派发，最长1440分钟', assigneeEmployeeId: '必填，员工ID或唯一姓名', note: '选填，执行要求',
    }
  }
  return { ...(definition.argumentGuide ?? {}) }
}

export function defaultAssistantCapabilityPolicies(): AssistantCapabilityPolicyConfig[] {
  return Object.values(definitions).map((definition) => ({
    id: definition.id, enabled: true, aliases: [...definition.aliases],
  }))
}

function capabilityPolicies(state: RuntimeState) {
  return new Map((state.config.assistantCapabilities ?? defaultAssistantCapabilityPolicies()).map((policy) => [policy.id, policy]))
}

export function availableAssistantCapabilities(state: RuntimeState, actorId: string): AssistantToolDescriptor[] {
  const permissions = new Set(effectivePermissionIdsForEmployee(state, actorId))
  const policies = capabilityPolicies(state)
  return Object.values(definitions).flatMap((definition) => {
    const policy = policies.get(definition.id)
    if (policy?.enabled === false || !permissions.has(definition.requiredPermission as StaffPermissionId)) return []
    return [{
      ...definition,
      aliases: [...new Set([...definition.aliases, ...(policy?.aliases ?? [])])],
      argumentGuide: argumentGuide(definition, state),
      humanWorkflow: definition.humanWorkflow ? structuredClone(definition.humanWorkflow) : undefined,
    }]
  })
}

export function availableAssistantExecutableTools(state: RuntimeState, actorId: string) {
  return availableAssistantCapabilities(state, actorId).filter(
    (capability): capability is AssistantToolDescriptor & { id: AssistantServerToolId } => capability.executionMode === 'server_execute',
  )
}

export function assistantCapabilityDefinition(id: AssistantCapabilityId) {
  return definitions[id]
}
