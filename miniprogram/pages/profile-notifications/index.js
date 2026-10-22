const {
  getOfficialPointsNotifications, setOfficialPointsNotifications,
  getWechatNotificationAuthorizations,
  getWechatMemberServiceNotificationAuthorizations,
} = require('../../utils/api')
const { customerErrorMessage } = require('../../utils/customer-error')

const TITLE_NAMES = {
  loyalty_points_credited: '积分到账提醒',
  loyalty_points_reversed: '积分变动提醒',
  loyalty_points_expiring: '积分到期提醒',
  activity_registration_confirmed: '活动报名结果提醒',
  member_benefit_issued: '优惠券到账提醒',
  membership_tier_changed: '会员等级提醒',
}

Page({
  data: { loading: true, error: '', options: [], official: null, saving: false },
  onShow() { this.load() },
  onHide() { this.loadGeneration = (this.loadGeneration || 0) + 1 },
  onUnload() { this.loadGeneration = (this.loadGeneration || 0) + 1 },

  async load() {
    const generation = this.loadGeneration = (this.loadGeneration || 0) + 1
    this.setData({ loading: true, saving: false, error: '', options: [], official: null })
    try {
      const errors = []
      const [loyalty, memberService, official] = await Promise.all([
        getWechatNotificationAuthorizations().catch((error) => { errors.push(`积分提醒：${customerErrorMessage(error, '读取失败')}`); return { authorizations: [] } }),
        getWechatMemberServiceNotificationAuthorizations().catch((error) => { errors.push(`会员提醒：${customerErrorMessage(error, '读取失败')}`); return { authorizations: [] } }),
        getOfficialPointsNotifications().catch((error) => { errors.push(`公众号积分提醒：${customerErrorMessage(error, '读取失败')}`); return null }),
      ])
      if (generation !== this.loadGeneration) return
      const options = [
        ...(loyalty.authorizations || []).map((item) => ({ ...item, apiKind: 'loyalty' })),
        ...(memberService.authorizations || []).map((item) => ({ ...item, apiKind: 'member_service' })),
      ].map((item) => {
        const usable = item.usesRemaining > 0
        const banned = item.platformResult === 'ban'
        return {
          policyId: item.policyId,
          policyKey: `${item.apiKind}:${item.policyId}`,
          apiKind: item.apiKind,
          notificationType: item.notificationType,
          policyVersion: item.policyVersion,
          templateId: item.templateId,
          authorizationVersion: item.authorizationVersion,
          title: TITLE_NAMES[item.notificationType] || '服务提醒',
          statusText: banned ? '当前微信暂不支持' : usable ? '已准备好' : item.decision === 'granted' ? '下次操作时会再次确认' : '将在相关操作时由微信询问',
        }
      })
      this.setData({ loading: false, options, official, error: errors.join('；') })
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.setData({ loading: false, options: [], official: null, error: customerErrorMessage(error, '提醒设置暂时无法读取') })
    }
  },

  async changeOfficial(event) {
    if (this.data.saving || !this.data.official || !this.data.official.accountId) return
    const enabled = !!event.detail.value
    const generation = this.loadGeneration
    this.setData({ saving: true })
    try { await setOfficialPointsNotifications({ accountId: this.data.official.accountId, enabled }); if (generation === this.loadGeneration) await this.load() }
    catch (error) {
      if (generation !== this.loadGeneration) return
      const reloading = this.loadGeneration + 1
      await this.load()
      if (this.loadGeneration === reloading) this.setData({ error: customerErrorMessage(error, '保存未确认，请重新读取核对') })
    }
    finally { if (generation === this.loadGeneration) this.setData({ saving: false }) }
  },
})
