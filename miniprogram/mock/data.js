const now = new Date().toISOString()

const developmentBootstrap = {
  serverNow: now,
  store: { id: 'mbox-lujiazui', name: 'M-Box 陆家嘴店（开发数据）', businessDate: '2026-07-14', timezone: 'Asia/Shanghai' },
  tables: [{ id: 'table-l01', code: 'L01', displayName: '休闲01（开发数据）', status: 'occupied', primaryEmployeeId: 'emp-lin', guestCount: 4 }],
  employees: [{ id: 'emp-lin', displayName: '林经理（开发数据）' }],
  config: {
    serviceTypes: [
      { id: 'water', code: 'water', name: '加水', icon: 'water', enabled: true },
      { id: 'ice', code: 'ice', name: '冰块 / 柠檬', icon: 'ice', enabled: true },
      { id: 'order', code: 'order', name: '协助点单', icon: 'order', enabled: true },
      { id: 'bill', code: 'bill', name: '买单协助', icon: 'bill', enabled: true },
      { id: 'complaint', code: 'complaint', name: '投诉', icon: 'complaint', enabled: true },
      { id: 'custom-request', code: 'CUSTOM_REQUEST', name: '个性化需求', icon: 'order', enabled: true },
    ],
  },
  tasks: [],
  orderDomain: { orders: [], tableLedgerEntries: [] },
  songState: { tableSessions: [], performanceSessions: [], singers: [], songs: [], repertoire: [], requests: [] },
}

const developmentMember = {
  member: {
    id: 'member-amy',
    displayName: 'Amy（开发数据）',
    phoneMasked: '138****2108',
    level: 'gold',
    serviceAccountBound: true,
    wecomBound: false,
  },
  benefits: [
    { id: 'dev-benefit-1', name: '精酿赠饮（开发数据）', description: '仅用于界面联调，不可核销', kind: 'product_gift', remainingQuantity: 1, validUntil: '2026-12-31T23:59:59+08:00', status: 'available' },
  ],
}

module.exports = { developmentBootstrap, developmentMember }
