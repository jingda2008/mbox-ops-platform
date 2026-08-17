const {
  getActivityRegistrations, updateActivityRegistrationContact,
  getVerifiedPhones, replaceVerifiedPhone, revokeVerifiedPhone,
} = require('../../utils/api')

Page({
  data: {
    contactToolsOpen: false, loadingContacts: false, contactBusy: '', contactMessage: '',
    verifiedPhones: [], activityRegistrations: [], editingRegistrationPublicId: '',
    editingContactValue: '',
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
        })),
      })
    } catch (error) {
      this.setData({ contactMessage: error.message || '联系方式暂时无法读取' })
    } finally { this.setData({ loadingContacts: false }) }
  },

  async replacePhone(event) {
    const code = event && event.detail && event.detail.code
    if (!code) return this.setData({ contactMessage: '您没有授权新的微信手机号，原记录不会改变。' })
    this.setData({ contactBusy: 'phone-replace', contactMessage: '' })
    try {
      await replaceVerifiedPhone(code)
      this.setData({ contactMessage: '已记录新的验证手机号，旧版本保留为不可用历史证据。' })
      await this.loadContactTools()
    } catch (error) { this.setData({ contactMessage: error.message || '手机号未能更换' }) }
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
    } catch (error) { this.setData({ contactMessage: error.message || '手机号未能停用' }) }
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
      this.setData({ contactMessage: '本次报名联系方式已更正，旧版本不再用于联系。', editingRegistrationPublicId: '', editingContactValue: '' })
      await this.loadContactTools()
    } catch (error) { this.setData({ contactMessage: error.message || '报名联系方式未能更正' }) }
    finally { this.setData({ contactBusy: '' }) }
  },
})
