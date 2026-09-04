const {
  getAlipayNotificationAuthorizations,
  getAlipayMemberServiceNotificationAuthorizations,
} = require('../../utils/api')

const TITLE_NAMES = {
  loyalty_points_credited: '积分到账提醒',
  loyalty_points_reversed: '积分变动提醒',
  loyalty_points_expiring: '积分到期提醒',
  activity_registration_confirmed: '活动报名结果提醒',
  member_benefit_issued: '优惠券到账提醒',
  membership_tier_changed: '会员等级提醒',
}

Page({
  data: { loading: true, error: '', options: [] },
  onShow() { this.load() },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const [loyalty, memberService] = await Promise.all([
        getAlipayNotificationAuthorizations().catch(() => ({ authorizations: [] })),
        getAlipayMemberServiceNotificationAuthorizations().catch(() => ({ authorizations: [] })),
      ])
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
          statusText: banned ? '当前支付宝暂不支持' : usable ? '已准备好' : item.decision === 'granted' ? '下次操作时会再次确认' : '将在相关操作时由支付宝询问',
        }
      })
      this.setData({ loading: false, options })
    } catch (_error) {
      this.setData({ loading: false, options: [] })
    }
  },

})
