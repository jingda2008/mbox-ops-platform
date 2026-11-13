const $ = id => document.getElementById(id)
const money = value => value === null || value === undefined ? '待核对' : `¥${(Number(value) / 100).toFixed(2)}`
const statuses = { pending: '待确认', confirmed: '已确认', approved: '已审批', disputed: '有异议', cancelled: '已取消' }
let invitation = new URLSearchParams(location.hash.slice(1)).get('invite') || ''
if (location.hash) history.replaceState(null, '', location.pathname)
let state = null, busy = false, epoch = 0, detailId = null, posterUrl = null
const pendingKey = () => state ? `mbox-cooperation-pending:${state.accountRef}` : null
const message = text => { $('message').textContent = text }
function pending() { const key = pendingKey(); return key ? JSON.parse(sessionStorage.getItem(key) || 'null') : null }
function controls() {
  document.querySelectorAll('button').forEach(button => { button.disabled = busy })
  if (state) {
    let unresolved = true
    try { unresolved = !!pending() } catch { message('无法读取上次操作记录，请联系管理员核对后处理。') }
    $('pending').hidden = !unresolved
    $('confirm').disabled = $('dispute').disabled = busy || unresolved
  }
}
async function api(path, body, headers = {}, raw = false) {
  const response = await fetch(`/cooperation/api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-channel-web': '1' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (response.ok && raw) return response.blob()
  let result
  try { result = await response.json() } catch { throw new Error('网络响应不完整，请恢复原操作或刷新核对。') }
  if (!response.ok) {
    const error = new Error(response.status === 401 ? '账号未登录、已过期或已停用，请重新登录。' : response.status === 429 ? '尝试次数较多，请稍后再试。' : result.error?.message || '请求失败，请稍后核对。')
    error.status = response.status; error.code = result.error?.code; error.notCommitted = result.error?.commitDisposition === 'not_committed'
    throw error
  }
  return result
}
function closePoster() {
  if (posterUrl) URL.revokeObjectURL(posterUrl)
  posterUrl = null; $('poster-image').removeAttribute('src'); $('poster-save').removeAttribute('href'); $('poster-preview').hidden = true
}
function clearPrivate() {
  closePoster()
  epoch++; state = null; detailId = null
  for (const id of ['balance', 'batches', 'visits', 'statements', 'detail-body']) $(id).replaceChildren()
  $('reason').value = ''; $('dashboard').hidden = true; $('detail').hidden = true; $('logout').hidden = true; $('auth').hidden = false
}
async function act(fn) {
  if (busy) return
  busy = true; message(''); controls()
  try { await fn() } catch (error) {
    if (error.status === 401) clearPrivate()
    message(error.message || '网络异常，请重试读取；有未确认操作时请先恢复。')
  } finally { busy = false; controls() }
}
function text(tag, value, className) { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node }
function button(label, action) { const node = text('button', label); node.type = 'button'; node.addEventListener('click', () => act(action)); return node }
function offer(rule) { return rule.offer.kind === 'gift' ? `赠 ${rule.offer.productName || '指定商品'} × ${rule.offer.quantity}` : rule.offer.kind === 'credit' ? `减 ${money(rule.offer.amountMinor)}` : `${(10000 - rule.offer.discountBps) / 1000} 折，单券最多优惠 ${money(rule.offer.maximumMinor)}` }
const beijing = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
function renderRows(kind, rows, append = false) {
  const root = $(kind); if (!append) root.replaceChildren()
  for (const row of rows) {
    const card = document.createElement('article'); card.className = kind === 'batches' ? 'card' : 'record'
    if (kind === 'batches') {
      card.append(text('h3', row.rule.title), text('p', offer(row.rule)), text('p', `优惠号码 ${row.offerCode}`), text('p', `领取 ${beijing(row.rule.claimFrom)} 至 ${beijing(row.rule.claimUntil)}`, 'label'), text('p', `已领 ${row.claims} · 已到店 ${row.arrivals} · ${row.acceptingClaims ? '可领取' : '已暂停'}`))
      card.append(button('下载专属推广图', async () => {
        const version = epoch, blob = await api(`poster/${encodeURIComponent(row.id)}`, undefined, {}, true)
        if (version !== epoch) return
        closePoster(); posterUrl = URL.createObjectURL(blob)
        $('poster-image').src = posterUrl; $('poster-save').href = posterUrl; $('poster-save').download = `MBOX-${row.offerCode}.png`; $('poster-preview').hidden = false
        $('poster-save').click(); $('poster-preview').scrollIntoView({behavior:'smooth'})
        message('推广图已生成。手机可长按下方图片保存或转发，也可请 M-BOX 管理员代发原图。')
      }))
    } else if (kind === 'visits') {
      card.append(text('p', `${row.date} · 匿名记录 ${row.visitNumber}`), text('p', `${row.arrived ? '已到店' : '待核实到店'} · ${row.closed ? '本次接待已结束' : '接待中'}`), text('p', `计佣净消费 ${money(row.qualifiedConsumptionMinor)} · 已记佣金 ${money(row.accruedCommissionMinor)}`))
    } else {
      card.append(text('p', `${beijing(row.createdAt)} · ${statuses[row.status] || '处理中'}`), text('p', `本单 ${money(row.amountMinor)} · 已付 ${money(row.paidMinor)}`), button('查看汇总', () => showStatement(row.id)))
    }
    root.append(card)
  }
  if (!root.children.length) root.append(text('p', '暂无记录', 'muted'))
  $(`more-${kind}`).hidden = !state.nextCursors[kind]
}
async function refresh() {
  const version = epoch, data = (await api('partner')).data
  if (version !== epoch) return
  if (state && state.accountRef !== data.accountRef) { clearPrivate(); throw new Error('账号已变化，请重新登录后核对。') }
  state = data; $('auth').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false
  $('balance').replaceChildren()
  for (const [label, value] of [['累计佣金', data.balance.accruedMinor], ['累计已付', data.balance.paidMinor], ['未付余额（含待核对）', data.balance.balanceMinor]]) {
    const node = document.createElement('div'); node.className = 'card'; node.append(text('span', label), text('strong', money(value), 'amount')); $('balance').append(node)
  }
  for (const kind of ['batches', 'visits', 'statements']) renderRows(kind, data[kind])
  controls()
}
async function showStatement(id) {
  const version = epoch, data = (await api(`statement/${encodeURIComponent(id)}`)).data
  if (version !== epoch) return
  detailId = data.statement.id; $('detail-body').replaceChildren(text('p', `结算金额 ${money(data.statement.amountMinor)} · ${statuses[data.statement.status] || '处理中'}`))
  for (const line of data.lines) $('detail-body').append(text('p', `${line.date} · 匿名记录 ${line.visitNumber} · 计佣净额 ${money(line.basisMinor)} · 佣金变动 ${money(line.deltaMinor)}`))
  $('reason').value = ''; $('detail').hidden = false
  $('response').hidden = !state.promoter.canConfirmStatement || !['pending', 'confirmed'].includes(data.statement.status)
  $('confirm').hidden = data.statement.status !== 'pending'
  $('detail').scrollIntoView({ behavior: 'smooth' }); controls()
}
async function respond(dispute) {
  if (pending()) throw new Error('请先恢复上次操作。')
  const reason = $('reason').value.trim() || (dispute ? '' : '已核对汇总金额')
  if (reason.length < 2) throw new Error('请填写至少两个字的异议说明。')
  const command = { key: `channel-${crypto.randomUUID()}`, body: { id: detailId, dispute, reason } }
  // Persist before network IO; storage failures prevent a potentially unrecoverable write.
  sessionStorage.setItem(pendingKey(), JSON.stringify(command))
  await sendCommand(command, false)
}
async function sendCommand(command, recovery) {
  const key = pendingKey(), version = epoch
  try {
    await api('statement-response', command.body, { 'idempotency-key': command.key, ...(recovery ? { 'x-channel-recovery': '1' } : {}) })
    if (version !== epoch) return
    sessionStorage.removeItem(key)
  } catch (error) {
    if (version === epoch && error.notCommitted) sessionStorage.removeItem(key)
    throw error
  }
  await refresh(); await showStatement(command.body.id); message('已保存并核对最新结算状态。')
}
function authMode() {
  $('auth-title').textContent = invitation ? '开通／重置合作账号' : '合作账号登录'
  $('auth-help').textContent = invitation ? '设置账号与至少12位密码。链接仅可使用一次，开通后用此账号登录；重置会退出所有旧登录。' : '由 M-BOX 管理员开通合作账号。忘记密码请联系管理员重新发送开通链接。'
  $('submit-login').textContent = invitation ? '保存账号并登录' : '登录'; $('switch-login').hidden = !invitation
  document.querySelector('[name=password]').autocomplete = invitation ? 'new-password' : 'current-password'
}
$('switch-login').onclick = () => { invitation = ''; authMode() }
$('login').onsubmit = event => {
  event.preventDefault(); void act(async () => {
    const form = new FormData(event.currentTarget), credentials = { username: String(form.get('username')).trim().toLowerCase(), password: String(form.get('password')) }
    if (invitation) {
      try { await api('activate', { ...credentials, token: invitation }) } catch (error) { throw new Error(`${error.message} 若提交后断网，请先选择“已开通，返回登录”用刚设置的账号登录核对，勿重复开通。`) }
      invitation = ''; authMode()
    }
    await api('login', credentials); document.querySelector('[name=password]').value = ''; epoch++; await refresh(); message('已登录合作后台。')
  })
}
$('logout').onclick = () => act(async () => { await api('logout', {}); clearPrivate(); message('已退出登录。') })
$('poster-close').onclick = closePoster
$('refresh').onclick = () => act(refresh)
$('confirm').onclick = () => act(() => respond(false))
$('dispute').onclick = () => act(() => respond(true))
$('recover').onclick = () => act(async () => { const command = pending(); if (command) await sendCommand(command, true) })
for (const kind of ['batches', 'visits', 'statements']) $(`more-${kind}`).onclick = () => act(async () => {
  const version = epoch, cursor = state.nextCursors[kind]
  if (!cursor) return
  const result = await api(`history?kind=${kind}&cursor=${encodeURIComponent(cursor)}`)
  if (version !== epoch) return
  state.nextCursors[kind] = result.meta.nextCursor; renderRows(kind, result.data, true)
})
window.addEventListener('offline', () => message('网络已断开。未确认的结算操作请在恢复网络后点击“恢复原操作”。'))
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state && !busy) void act(refresh) })
window.addEventListener('pageshow', event => { if (event.persisted) { clearPrivate(); void act(refresh) } })
authMode()
if (!invitation) void act(refresh)
