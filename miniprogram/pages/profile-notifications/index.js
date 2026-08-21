const {
  getWechatNotificationAuthorizations,
  recordWechatNotificationAuthorization,
  getNotificationConsent,
  recordNotificationConsent,
} = require('../../utils/api')

const TITLE_NAMES = {
  loyalty_points_credited: '积分到账提醒',
  loyalty_points_reversed: '积分变动提醒',
  loyalty_points_expiring: '积分到期提醒',
}

Page({
  data: { loading: true, error: '', notice: '', options: [], busyId: '' },
  onShow() { this.load() },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const data = await getWechatNotificationAuthorizations()
      const options = (data.authorizations || []).map((item) => {
        const usable = item.usesRemaining > 0
        const banned = item.platformResult === 'ban'
        return {
          policyId: item.policyId,
          notificationType: item.notificationType,
          policyVersion: item.policyVersion,
          templateId: item.templateId,
          authorizationVersion: item.authorizationVersion,
          title: TITLE_NAMES[item.notificationType] || '服务提醒',
          statusText: banned ? '系统已限制' : usable ? '本周期已开启' : item.decision === 'granted' ? '可再次开启' : '尚未开启',
          actionText: banned ? '不可用' : usable ? '已开启' : '开启提醒',
          disabled: banned || usable,
          raw: item,
        }
      })
      this.setData({ loading: false, options })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '提醒设置暂时无法读取' })
    }
  },

  async enableOption(event) {
    const policyId = event.currentTarget.dataset.id
    const option = this.data.options.find((item) => item.policyId === policyId)
    if (!option || option.disabled || this.data.busyId) return
    if (typeof wx.requestSubscribeMessage !== 'function') {
      return this.setData({ error: '当前基础库暂不支持订阅消息' })
    }
    this.setData({ busyId: policyId, error: '', notice: '' })
    try {
      const result = await new Promise((resolve, reject) => wx.requestSubscribeMessage({
        tmplIds: [option.templateId],
        success: resolve,
        fail: reject,
      }))
      const platformResult = result[option.templateId]
      if (!['accept', 'reject', 'ban'].includes(platformResult)) {
        this.setData({ notice: '未完成选择，可稍后再试' })
        return
      }
      await recordWechatNotificationAuthorization({
        notificationType: option.notificationType,
        policyId: option.policyId,
        policyVersion: option.policyVersion,
        templateId: option.templateId,
        expectedVersion: option.authorizationVersion,
        platformResult,
      })
      this.setData({ notice: platformResult === 'accept' ? '已开启提醒' : '已记录你的选择' })
      await this.load()
    } catch (error) {
      this.setData({ error: error.message || '暂时无法开启提醒' })
    } finally {
      this.setData({ busyId: '' })
    }
  },

  async declineAll() {
    this.setData({ notice: '已记录：暂不接收提醒。之后仍可在此重新开启。' })
    try {
      const consent = await getNotificationConsent()
      if (!consent || !consent.available || !consent.templateId) return
      await recordNotificationConsent({
        expectedVersion: Number(consent.consentVersion || 0),
        authorizationContext: 'service',
        platformResult: 'reject',
        platformEventReference: `decline-${Date.now()}`,
      })
    } catch (_error) {
      // Local choice still stands when policy is unavailable.
    }
  },
})
