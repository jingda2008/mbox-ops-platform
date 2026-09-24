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
  onHide() { this.policyReadGeneration = (this.policyReadGeneration || 0) + 1 },
  onUnload() { this.policyReadGeneration = (this.policyReadGeneration || 0) + 1 },

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
    this.setData({ contactToolsOpen: open, contactMessage: '', editingRegistrationPublicId: '', editingContactValue: '' })
    if (open) this.loadContactTools()
  },

  async loadContactTools() {
    this.setData({ loadingContacts: true, contactMessage: '' })
    try {
      const results = await Promise.all([getVerifiedPhones(), getActivityRegistrations()])
      this.setData({
        verifiedPhones: Array.isArray(results[0]) ? results[0] : [],
        activityRegistrations: (Array.isArray(results[1]) ? results[1] : []).map((item) => Object.assign({}, item, {
          canUpdateContact: ['reserved', 'payment_pending', 'confirmed', 'waitlisted', 'checked_in'].includes(item.status),
          statusText: REGISTRATION_STATUS_TEXT[item.status] || '状态待确认',
        })),
      })
    } catch (error) {
      this.setData({ contactMessage: customerErrorMessage(error, '联系方式暂时无法读取') })
    } finally { this.setData({ loadingContacts: false }) }
  },

  onAgreePrivacyAuthorization() {},

  async replacePhone(event) {
    const authorization = readWechatPhoneAuthorization(event)
    if (!authorization.code) return this.setData({ contactMessage: authorization.message })
    this.setData({ contactBusy: 'phone-replace', contactMessage: '' })
    try {
      await replaceVerifiedPhone(authorization.code)
      this.setData({ contactMessage: '手机号已更新，原手机号不会再用于联系。' })
      await this.loadContactTools()
    } catch (error) { this.setData({ contactMessage: customerErrorMessage(error, '手机号未能更换') }) }
    finally { this.setData({ contactBusy: '' }) }
  },

  async revokePhone(event) {
    const publicId = event.currentTarget.dataset.publicId
    if (!publicId) return
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '停用验证手机号', content: '停用后不能用它继续找回或合并会员；订单和必要审计记录不会被删除。',
      confirmText: '确认停用', success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }))
    if (!confirmed) return
    this.setData({ contactBusy: publicId, contactMessage: '' })
    try {
      await revokeVerifiedPhone(publicId)
      this.setData({ contactMessage: '该手机号已停用。' })
      await this.loadContactTools()
    } catch (error) { this.setData({ contactMessage: customerErrorMessage(error, '手机号未能停用') }) }
    finally { this.setData({ contactBusy: '' }) }
  },

  startActivityContactEdit(event) {
    this.setData({
      editingRegistrationPublicId: event.currentTarget.dataset.publicId || '',
      editingContactValue: '', contactMessage: '',
    })
  },
  cancelActivityContactEdit() { this.setData({ editingRegistrationPublicId: '', editingContactValue: '' }) },
  onActivityContactInput(event) { this.setData({ editingContactValue: String(event.detail.value || '').trim() }) },
  async saveActivityContact() {
    const registrationPublicId = this.data.editingRegistrationPublicId
    const contactValue = this.data.editingContactValue
    if (!/^1\d{10}$/.test(contactValue)) return this.setData({ contactMessage: '请输入正确的11位手机号。' })
    this.setData({ contactBusy: registrationPublicId, contactMessage: '' })
    try {
      await updateActivityRegistrationContact(registrationPublicId, contactValue)
      this.setData({ contactMessage: '本次报名手机号已更正，原手机号不再用于联系。', editingRegistrationPublicId: '', editingContactValue: '' })
      await this.loadContactTools()
    } catch (error) { this.setData({ contactMessage: customerErrorMessage(error, '报名联系方式未能更正') }) }
    finally { this.setData({ contactBusy: '' }) }
  },
})
