const runtime = require('../../utils/platform')
const { getMemberCards, submitMemberCardAction, getMemberGiftJobs } = require('../../utils/api')
const { customerErrorMessage } = require('../../utils/customer-error')
const { dateInput } = require('../../utils/format')
const labels = { active: '有效', suspended: '已冻结', withdrawn: '已退出', revoked: '已撤销', pending: '待审核', approved: '已通过', rejected: '未通过' }
function time(value) { const date = new Date(dateInput(value)); return Number.isFinite(date.getTime()) ? new Date(date.getTime() + 28800000).toISOString().slice(0, 16).replace('T', ' ') : '时间待核实' }
Page({
  data: { loading: true, loaded: false, busy: false, error: '', message: '', projects: [], cards: [], applications: [], nextCursors: {}, selectedProject: null, acknowledged: false, activeMember: false, giftJobs: [], giftLoaded: false, giftLoading: false, giftError: '', giftCursor: null },
  onShow() { this.setData({ message: '' }); this.load(); this.loadGifts() },
  onHide() { this.generation = (this.generation || 0) + 1; this.giftGeneration = (this.giftGeneration || 0) + 1 },
  onUnload() { this.generation = (this.generation || 0) + 1; this.giftGeneration = (this.giftGeneration || 0) + 1 },
  async loadGifts(event) {
    const more = !!(event && event.currentTarget && event.currentTarget.dataset.more)
    if (more && (this.data.giftLoading || !this.data.giftCursor)) return
    const generation = this.giftGeneration = (this.giftGeneration || 0) + 1
    this.setData(Object.assign({ giftLoading: true, giftError: '' }, more ? {} : { giftJobs: [], giftLoaded: false, giftCursor: null }))
    try {
      const data = await getMemberGiftJobs(more ? this.data.giftCursor : null)
      if (generation !== this.giftGeneration) return
      const states = { pending: '等待发放', blocked: '待员工核对补发', issued: '已发到优惠券包', cancelled: '已取消发放', duplicate: '已通过同一身份领取' }
      const items = data.items.map(item => Object.assign({}, item, { stateText: states[item.status] || '待核实' }))
      this.setData({ giftJobs: more ? Array.from(new Map((this.data.giftJobs || []).concat(items).map(item => [item.id, item])).values()) : items, giftCursor: data.nextCursor || null, giftLoaded: true, giftLoading: false })
    } catch (error) { if (generation === this.giftGeneration) this.setData({ giftLoading: false, giftError: customerErrorMessage(error, '赠券进度暂未读取，可重试；不影响卡片申请') }) }
  },
  openGiftWallet() { runtime.navigateTo({ url: '/pages/profile-coupons/index' }) },
  loadMore(event) {
    const kind = event.currentTarget.dataset.kind
    if (['projects', 'cards', 'applications'].includes(kind) && this.data.nextCursors[kind] && !this.data.busy) return this.load(kind)
  },
  async load(kind) {
    const more = typeof kind === 'string' && ['projects', 'cards', 'applications'].includes(kind)
    const generation = this.generation = (this.generation || 0) + 1
    if (more) this.setData({ busy: true, error: '' })
    else this.setData({ loading: true, loaded: false, busy: false, error: '', selectedProject: null, acknowledged: false, projects: [], cards: [], applications: [], nextCursors: {}, activeMember: false })
    try {
      const data = await getMemberCards(more ? { [kind]: this.data.nextCursors[kind] } : undefined)
      if (generation !== this.generation) return
      if (more) {
        const nextCursor = (data.nextCursors || {})[kind] || null
        for (const key of ['projects', 'cards', 'applications']) data[key] = key === kind ? Array.from(new Map(this.data[key].concat(data[key]).map(item => [item.id, item])).values()) : this.data[key]
        data.nextCursors = Object.assign({}, this.data.nextCursors, { [kind]: nextCursor })
      }
      const held = new Set(data.cards.filter(card => !card.expired && ['active', 'suspended'].includes(card.status)).map(card => card.project_id))
      const pending = new Set(data.applications.filter(item => item.status === 'pending').map(item => item.project_id))
      this.setData({
        loading: false, loaded: true, busy: false, activeMember: data.activeMember, nextCursors: data.nextCursors || {},
        projects: data.projects.map(item => Object.assign({}, item, { untilText: time(item.available_until), canApply: data.activeMember && item.accepting_applications && !item.has_current_card && !item.has_pending_application && !held.has(item.id) && !pending.has(item.id), buttonText: item.has_current_card || held.has(item.id) ? '已持有' : item.has_pending_application || pending.has(item.id) ? '审核中' : item.accepting_applications ? '查看并申请' : '暂未开放' })),
        cards: data.cards.map(item => Object.assign({}, item, { stateText: item.expired && ['active', 'suspended'].includes(item.status) ? '已到期' : labels[item.status] || '待核实', untilText: time(item.valid_until), canWithdraw: ['active', 'suspended'].includes(item.status) })),
        applications: data.applications.map(item => Object.assign({}, item, { stateText: labels[item.status] || '待核实', requestedText: time(item.requested_at) })),
      })
    } catch (error) { if (generation === this.generation) this.setData({ loading: false, busy: false, error: customerErrorMessage(error, more ? '更多记录未能读取，可再次点击加载更多；已读记录保留' : '卡片暂时无法读取，请重试') }) }
  },
  openProject(event) {
    if (this.data.busy) return
    const project = this.data.projects.find(item => item.id === event.currentTarget.dataset.id)
    if (project && project.canApply) this.setData({ selectedProject: project, acknowledged: false, error: '', message: '' })
  },
  closeProject() { if (!this.data.busy) this.setData({ selectedProject: null, acknowledged: false }) },
  acknowledge(event) { this.setData({ acknowledged: Array.isArray(event.detail.value) && event.detail.value.includes('agree') }) },
  async apply() {
    const project = this.data.selectedProject
    if (!project || !this.data.acknowledged || this.data.busy) return
    await this.execute('apply', project.id, { projectId: project.id, acceptedProjectVersion: project.version }, '申请已提交，等待员工审核；未变更营销授权。')
  },
  async withdraw(event) {
    if (this.data.busy) return
    const generation = this.generation
    const id = event.currentTarget.dataset.id, action = event.currentTarget.dataset.action
    if (!['withdraw-card', 'withdraw-application'].includes(action)) return
    const confirmed = await new Promise(resolve => runtime.showModal({ title: action === 'withdraw-card' ? '退出这张卡？' : '撤回申请？', content: '不会改变会员等级或删除已合法发放的优惠券。', confirmText: '确认', success: result => resolve(!!result.confirm), fail: () => resolve(false) }))
    if (confirmed && generation === this.generation) await this.execute(action, id, {}, action === 'withdraw-card' ? '已退出此卡。' : '申请已撤回。')
  },
  async execute(action, id, input, message) {
    if (this.data.busy) return
    const generation = this.generation
    this.setData({ busy: true, error: '', message: '' })
    try {
      await submitMemberCardAction(action, id, input)
      if (generation !== this.generation) return
      this.setData({ message })
      await this.load()
    } catch (error) { if (generation === this.generation) this.setData({ busy: false, error: customerErrorMessage(error, '结果暂未确认，请刷新核对后重试') }) }
  },
  openMembership() { runtime.switchTab({ url: '/pages/profile/index' }) },
})
