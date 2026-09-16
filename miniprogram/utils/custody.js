const { dateInput } = require('./format')
const states = { stored: '存放中', collected: '已取出', archived: '已归档', voided: '已作废' }
const events = { stored: '存酒登记', restored: '余酒再存', collected: '取酒交接', collection_closed: '取酒处理完成', archived: '存酒归档', expiry_changed: '有效期调整', code_requested: '申请取酒核验', code_verified: '取酒核验通过', code_rejected: '取酒核验未通过', printed: '生成存酒凭证' }
function time(value) {
  if (!value) return '未登记'
  const date = new Date(dateInput(value))
  return Number.isNaN(date.getTime()) ? '待核实' : new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
}
function quantity(value) {
  if (value === null || value === undefined || value === '') return '未登记'
  return String(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}
function presentOrder(order) {
  const expired = order.status === 'stored' && new Date(dateInput(order.expires_at)).getTime() <= Date.now()
  return Object.assign({}, order, { statusText: expired ? '已到期 · 待门店处理' : states[order.status] || '状态待核实', tone: expired ? 'warning' : order.status === 'stored' ? 'active' : 'muted', remainingText: quantity(order.remaining_quantity), originalText: quantity(order.original_quantity), storedText: time(order.stored_at), expiryText: time(order.expires_at) })
}
function presentDetail(data) {
  const order = presentOrder(data.order)
  const fields = order.extra_fields || {}
  const definitions = Array.isArray(order.extra_field_snapshot) ? order.extra_field_snapshot : []
  order.extraRows = definitions.map(field => ({ key: field.key, label: field.label, value: fields[field.key] || '未填写' }))
  for (const key of Object.keys(fields)) if (!definitions.some(field => field.key === key)) order.extraRows.push({ key, label: key, value: fields[key] })
  order.valueText = order.declared_value_minor == null ? '未登记' : '¥' + (Number(order.declared_value_minor) / 100).toFixed(2)
  return { order,
    deposits: (data.deposits || []).map(d => Object.assign({}, d, { quantityText: quantity(d.quantity), timeText: time(d.recorded_at), photoPath: '', photoError: '', photoLoading: false })),
    collections: (data.collections || []).map(c => Object.assign({}, c, { quantityText: quantity(c.quantity), returnedText: quantity(c.returned_quantity), timeText: time(c.collected_at), statusText: { collected: '已取出，待登记余酒', restored: '已登记再存', archived: '已处理完成' }[c.status] || '待核实' })),
    events: (data.events || []).map((e, index) => Object.assign({}, e, { key: index, title: events[e.event_type] || '存酒记录更新', quantityText: e.quantity == null ? '' : quantity(e.quantity), timeText: time(e.occurred_at) })).reverse(),
  }
}
module.exports = { presentOrder, presentDetail }
