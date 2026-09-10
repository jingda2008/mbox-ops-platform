const { getMarketingPreferences, updateMarketingPreferences } = require('../../utils/api')
const { customerErrorMessage } = require('../../utils/customer-error')
const names = { wechat: '微信活动信息', sms: '短信优惠活动', phone: '电话活动邀请' }
function localTime(value) {
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) return '待核对'
  return new Date(instant + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
}
function view(data) {
  const channels = ['wechat', 'sms', 'phone'].map(channel => {
    const grants = data.decisions.filter(item => item.channel === channel && item.decision === 'granted')
    return { channel, name: names[channel], granted: grants.length > 0, stateText: grants.length ? '已记录联系许可' : '未同意营销联系', capabilityText: (data.channels.find(item => item.channel === channel) || {}).ready ? '渠道能力以实际发送时核验为准' : '渠道尚未开通，不代表已能发送' }
  })
  return { revision: data.revision, notices: data.notices, channels }
}
Page({
  data: { loading: true, loaded: false, busy: false, error: '', message: '', revision: 'none', notices: [], channels: [], selectedNotice: null, selectedChannels: [], jointSelected: false, acknowledged: false, canSubmit: false },
  onShow() { this.load() },
  onHide() { this.generation = (this.generation || 0) + 1 },
  onUnload() { this.generation = (this.generation || 0) + 1 },
  async load() {
    const generation = this.generation = (this.generation || 0) + 1
    this.setData({ loading: true, loaded: false, busy: false, error: '', channels: [], notices: [], selectedNotice: null, selectedChannels: [], jointSelected: false, acknowledged: false, canSubmit: false })
    try {
      const data = await getMarketingPreferences()
      if (generation === this.generation) this.setData(Object.assign(view(data), { loading: false, loaded: true, busy: false }))
    } catch (error) { if (generation === this.generation) this.setData({ loading: false, busy: false, error: customerErrorMessage(error, '联系偏好暂未读取，仍可停止全部营销') }) }
  },
  openNotice(event) {
    if (this.data.busy) return
    const notice = this.data.notices.find(item => item.id === event.currentTarget.dataset.id)
    if (!notice) return
    this.setData({ selectedNotice: Object.assign({}, notice, { channelOptions: notice.rule.channels.map(channel => ({ channel, name: names[channel] })), hasOwn: notice.rule.purposes.includes('own_activities'), hasJoint: notice.rule.purposes.includes('mbox_joint_activities'), weekdayText: notice.rule.weekdays.map(day => '一二三四五六日'[day - 1]).join('、'), fromText: localTime(notice.rule.validFrom), untilText: localTime(notice.rule.validUntil), dataText: (notice.rule.dataCategories || []).join('、'), startText: String(Math.floor(notice.rule.contactStartMinute / 60)).padStart(2, '0') + ':' + String(notice.rule.contactStartMinute % 60).padStart(2, '0'), endText: String(Math.floor(notice.rule.contactEndMinute / 60)).padStart(2, '0') + ':' + String(notice.rule.contactEndMinute % 60).padStart(2, '0') }), selectedChannels: [], jointSelected: false, acknowledged: false, canSubmit: false, message: '' })
  },
  chooseChannels(event) {
    const allowed = this.data.selectedNotice ? this.data.selectedNotice.rule.channels : []
    const selectedChannels = Array.isArray(event.detail.value) ? event.detail.value.filter(value => allowed.includes(value)) : []
    const selectedNotice = this.data.selectedNotice
    this.setData({ selectedChannels, selectedNotice: selectedNotice ? Object.assign({}, selectedNotice, { channelOptions: selectedNotice.channelOptions.map(item => Object.assign({}, item, { checked: selectedChannels.includes(item.channel) })) }) : null }); this.checkSubmit()
  },
  chooseJoint(event) { this.setData({ jointSelected: Array.isArray(event.detail.value) && event.detail.value.includes('joint') }); this.checkSubmit() },
  acknowledge(event) { this.setData({ acknowledged: Array.isArray(event.detail.value) && event.detail.value.includes('agree') }); this.checkSubmit() },
  checkSubmit() { const notice = this.data.selectedNotice; this.setData({ canSubmit: !!notice && this.data.acknowledged && this.data.selectedChannels.length > 0 && (notice.hasOwn || (notice.hasJoint && this.data.jointSelected)) }) },
  async submit() {
    const notice = this.data.selectedNotice
    if (!notice || !this.data.canSubmit || this.data.busy) return
    const purposes = (notice.hasOwn ? ['own_activities'] : []).concat(notice.hasJoint && this.data.jointSelected ? ['mbox_joint_activities'] : [])
    const choices = this.data.selectedChannels.flatMap(channel => purposes.map(purpose => ({ channel, purpose, decision: 'granted' })))
    await this.execute('choices', { noticeId: notice.id, expectedRevision: this.data.revision, choices }, '已记录本次选择。未替你订阅微信模板、添加企微、关注公众号或允许提供合作方名单。')
  },
  async stopAll() { await this.execute('stop-all', {}, '已停止全部营销联系许可，会员、卡券、点单及必要交易通知不受影响。') },
  async withdrawChannel(event) { const channel = event.currentTarget.dataset.channel; if (names[channel]) await this.execute('withdraw-channel', { channel }, '已停止该渠道营销联系，其他渠道及会员权益不变。') },
  async execute(action, input, message) {
    if (this.data.busy) return
    const generation = this.generation = (this.generation || 0) + 1
    this.setData({ busy: true, error: '', message: '' })
    try {
      await updateMarketingPreferences(action, input)
      if (generation !== this.generation) return
      const reloadGeneration = this.generation + 1
      await this.load()
      if (this.generation === reloadGeneration) this.setData({ message })
    } catch (error) { if (generation === this.generation) this.setData({ busy: false, error: customerErrorMessage(error, '结果暂未确认，请读取核对后重试') }) }
  },
})
