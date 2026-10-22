const {
  getActivityRegistrations, updateActivityRegistrationContact,
  getVerifiedPhones, replaceVerifiedPhone, revokeVerifiedPhone,
  getPrivacyPolicy,
} = require('../../utils/api')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')
const { customerErrorMessage } = require('../../utils/customer-error')

function policyParagraphs(content) {
  const source = String(content || '').replace(/\r\n/g, '\n').trim()
  if (!source) return []
  const pieces = []
  for (const block of source.split(/\n{2,}/)) {
    let rest = block.trim()
    while (rest.length > 480) {
      const splitAt = rest.lastIndexOf('\n', 480)
      const cut = splitAt > 160 ? splitAt : 480
      const piece = rest.slice(0, cut).trim()
      if (piece) pieces.push(piece)
      rest = rest.slice(cut).trim()
    }
    if (rest) pieces.push(rest)
  }
  return pieces.map((text, index) => ({ id: `p${index}`, text }))
}

function formatPolicyTime(value) {
  const parsed = Date.parse(String(value || ''))
  if (!Number.isFinite(parsed)) return String(value || '')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(parsed))
  const pick = (type) => (parts.find((part) => part.type === type) || {}).value || ''
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  return `${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}`
}

const REGISTRATION_STATUS_TEXT = {
  reserved: '名额已暂留',
  payment_pending: '待付款处理',
  confirmed: '已报名',
  waitlisted: '候补中',
  checked_in: '已签到',
  no_show: '未到场',
  cancelled: '已取消',
  refunded: '已退款',
  expired: '已失效',
}

Page({
  data: {
    contactToolsOpen: false, loadingContacts: false, contactBusy: '', contactMessage: '',
    verifiedPhones: [], activityRegistrations: [], editingRegistrationPublicId: '',
    editingContactValue: '', policyLoading: true, policy: null, policyParagraphs: [],
    policyEffectiveLabel: '', policyMessage: '',
  },

  onShow() { this.loadPrivacyPolicy() },
  onHide() { this.policyReadGeneration = (this.policyReadGeneration || 0) + 1; this.invalidateContacts() },
  onUnload() { this.policyReadGeneration = (this.policyReadGeneration || 0) + 1; this.invalidateContacts() },
  invalidateContacts() {
    this.contactScope = (this.contactScope || 0) + 1
    this.contactReadGeneration = (this.contactReadGeneration || 0) + 1
    this.setData({ contactToolsOpen: false, loadingContacts: false, contactBusy: '', contactMessage: '',
      verifiedPhones: [], activityRegistrations: [], editingRegistrationPublicId: '', editingContactValue: '' })
  },

  async loadPrivacyPolicy() {
    const generation = this.policyReadGeneration = (this.policyReadGeneration || 0) + 1
    this.setData({ policyLoading: true, policyMessage: '' })
    try {
      const policy = await getPrivacyPolicy()
      if (generation !== this.policyReadGeneration) return
      const readable = Boolean(policy && String(policy.content || '').trim())
      this.setData({
        policyLoading: false,
        policy: readable ? policy : null,
        policyParagraphs: readable ? policyParagraphs(policy.content) : [],
        policyEffectiveLabel: readable ? formatPolicyTime(policy.effectiveAt) : '',
        policyMessage: readable ? '' : '隐私政策暂时无法读取，请稍后重试或联系门店。',
      })
    } catch (error) {
      if (generation !== this.policyReadGeneration) return
      this.setData({
        policyLoading: false,
        policy: null,
        policyParagraphs: [],
        policyEffectiveLabel: '',
        policyMessage: customerErrorMessage(error, '隐私政策暂时无法读取，请稍后重试或联系门店。'),
      })
    }
  },

  toggleContactTools() {
    const open = !this.data.contactToolsOpen
    if (!open) { this.invalidateContacts(); return }
    this.setData({ contactToolsOpen: open, contactMessage: '', editingRegistrationPublicId: '', editingContactValue: '' })
    if (open) this.loadContactTools()
  },

  async loadContactTools() {
    const generation = this.contactReadGeneration = (this.contactReadGeneration || 0) + 1
    this.setData({ loadingContacts: true, contactMessage: '' })
    try {
      const results = await Promise.all([getVerifiedPhones(), getActivityRegistrations()])
      if (generation !== this.contactReadGeneration) return
      this.setData({
        verifiedPhones: Array.isArray(results[0]) ? results[0] : [],
        activityRegistrations: (Array.isArray(results[1]) ? results[1] : []).map((item) => Object.assign({}, item, {
          canUpdateContact: ['reserved', 'payment_pending', 'confirmed', 'waitlisted', 'checked_in'].includes(item.status),
          statusText: REGISTRATION_STATUS_TEXT[item.status] || '状态待确认',
        })),
      })
      return true
    } catch (error) {
      if (generation !== this.contactReadGeneration) return
      this.setData({ contactMessage: customerErrorMessage(error, '联系方式暂时无法读取') })
    } finally { if (generation === this.contactReadGeneration) this.setData({ loadingContacts: false }) }
  },

  onAgreePrivacyAuthorization() {},

  async replacePhone(event) {
    if (this.data.contactBusy) return
    const authorization = readWechatPhoneAuthorization(event)
    if (!authorization.code) return this.setData({ contactMessage: authorization.message })
    const scope = this.contactScope || 0
    this.setData({ contactBusy: 'phone-replace', contactMessage: '' })
    try {
      await replaceVerifiedPhone(authorization.code)
      if (scope !== (this.contactScope || 0)) return
      const refreshed = await this.loadContactTools()
      if (refreshed && scope === (this.contactScope || 0)) this.setData({ contactMessage: '手机号已更新，原手机号不会再用于联系。' })
    } catch (error) { if (scope === (this.contactScope || 0)) this.setData({ contactMessage: customerErrorMessage(error, '手机号未能更换') }) }
    finally { if (scope === (this.contactScope || 0)) this.setData({ contactBusy: '' }) }
  },

  async revokePhone(event) {
    if (this.data.contactBusy) return
    const publicId = event.currentTarget.dataset.publicId
    if (!publicId) return
    const scope = this.contactScope || 0
    this.setData({ contactBusy: publicId })
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '停用验证手机号', content: '停用后不能用它继续找回或合并会员；订单和必要审计记录不会被删除。',
      confirmText: '确认停用', success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }))
    if (scope !== (this.contactScope || 0)) return
    if (!confirmed) { this.setData({ contactBusy: '' }); return }
    this.setData({ contactBusy: publicId, contactMessage: '' })
    try {
      await revokeVerifiedPhone(publicId)
      if (scope !== (this.contactScope || 0)) return
      const refreshed = await this.loadContactTools()
      if (refreshed && scope === (this.contactScope || 0)) this.setData({ contactMessage: '该手机号已停用。' })
    } catch (error) { if (scope === (this.contactScope || 0)) this.setData({ contactMessage: customerErrorMessage(error, '手机号未能停用') }) }
    finally { if (scope === (this.contactScope || 0)) this.setData({ contactBusy: '' }) }
  },

  startActivityContactEdit(event) {
    if (this.data.contactBusy) return
    this.setData({
      editingRegistrationPublicId: event.currentTarget.dataset.publicId || '',
      editingContactValue: '', contactMessage: '',
    })
  },
  cancelActivityContactEdit() { if (!this.data.contactBusy) this.setData({ editingRegistrationPublicId: '', editingContactValue: '' }) },
  onActivityContactInput(event) { if (!this.data.contactBusy) this.setData({ editingContactValue: String(event.detail.value || '').trim() }) },
  async saveActivityContact() {
    if (this.data.contactBusy) return
    const registrationPublicId = this.data.editingRegistrationPublicId
    if (!registrationPublicId) return
    const contactValue = this.data.editingContactValue
    if (!/^1\d{10}$/.test(contactValue)) return this.setData({ contactMessage: '请输入正确的11位手机号。' })
    const scope = this.contactScope || 0
    this.setData({ contactBusy: registrationPublicId, contactMessage: '' })
    try {
      await updateActivityRegistrationContact(registrationPublicId, contactValue)
      if (scope !== (this.contactScope || 0)) return
      this.setData({ editingRegistrationPublicId: '', editingContactValue: '' })
      const refreshed = await this.loadContactTools()
      if (refreshed && scope === (this.contactScope || 0)) this.setData({ contactMessage: '本次报名手机号已更正，原手机号不再用于联系。' })
    } catch (error) { if (scope === (this.contactScope || 0)) this.setData({ contactMessage: customerErrorMessage(error, '报名联系方式未能更正') }) }
    finally { if (scope === (this.contactScope || 0)) this.setData({ contactBusy: '' }) }
  },
})
