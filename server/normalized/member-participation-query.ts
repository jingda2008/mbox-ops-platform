import type { MemberParticipation } from '../../src/shared/member-participation.js'
import { BenefitRepository } from './benefit-repository.js'
import { CustomerRepository, CustomerNotFoundError } from './customer-repository.js'
import { CustomerExperienceRepository } from './customer-experience-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export function readMemberScanCode(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('请扫描会员码或输入完整会员号')
  const memberNo = value.trim().replace(/^MBOX_MEMBER_V1:/i, '').trim()
  if (!memberNo || memberNo.length > 128 || /[\s:/?#]/u.test(memberNo)) {
    throw new TypeError('请使用会员码；点心核销码请在原权益待办办理')
  }
  return memberNo
}

export async function loadMemberParticipation(
  transaction: ScopedTransaction, memberNo: string, activitiesVisible: boolean,
  paymentProviderConfigured: boolean, now = new Date(),
): Promise<MemberParticipation> {
  const { tenantId, storeId } = transaction.scope
  const matched = await transaction.query<{ customer_id: string }>(`
    SELECT customer_id FROM mbox.customer_memberships
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND member_no=$3 AND status='active'
    LIMIT 1
  `, [tenantId, storeId, memberNo])
  if (!matched.rows[0]) throw new CustomerNotFoundError('member')
  const customer = await new CustomerRepository(transaction).resolveCanonical(matched.rows[0].customer_id)
  if (customer.status !== 'active') throw new CustomerNotFoundError('member')
  const experience = new CustomerExperienceRepository(transaction, paymentProviderConfigured)
  const benefits = await new BenefitRepository(transaction).listAvailableForCustomer(customer.id, now.toISOString())
  const activities = activitiesVisible ? await experience.publicActivities(customer.id) : []
  const registrations = activitiesVisible ? await experience.publicActivityRegistrations(customer.id) : []
  const metadata = registrations.length === 0 ? [] : (await transaction.query<{
    public_id: string; status: string; ends_at: string
  }>(`SELECT public_id,status,ends_at::text FROM mbox.community_activities
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=ANY($3::text[])`,
    [tenantId, storeId, [...new Set(registrations.map(item => item.activityPublicId))]])).rows
  return {
    memberNo, displayName: customer.profile.displayName, checkedAt: now.toISOString(), activitiesVisible,
    activities: activities.filter(item => !item.registrationStatus || ['cancelled', 'refunded'].includes(item.registrationStatus))
      .map(item => ({ publicId: item.publicId, title: item.title, startsAt: item.startsAt,
        guidance: item.paymentAvailability === 'blocked' ? item.paymentBlockedReason ?? '当前报名支付不可用'
          : item.remainingCapacity <= 0 ? '名额已满，可在小程序查看候补规则'
            : '符合展示范围，可在小程序查看报名；人数、套餐、资格以提交校验为准' })),
    registrations: registrations.map(item => {
      const activity = metadata.find(row => row.public_id === item.activityPublicId)
      const open = !!activity && ['published', 'full'].includes(activity.status) && Date.parse(activity.ends_at) > now.getTime()
      const readyForCheckIn = open && item.status === 'confirmed' && ['paid', 'not_required'].includes(item.paymentStatus)
      const guidance = !open ? '活动已结束或不可办理，请核对活动记录'
        : readyForCheckIn ? '已确认报名，现场核对本人及人数后可签到'
          : item.status === 'checked_in' ? '已签到；套餐实物交付请另行核对登记'
            : item.status === 'waitlisted' ? '候补中，尚未取得参加名额'
              : ['reserved', 'payment_pending', 'confirmed'].includes(item.status) ? '付款或报名尚未确认，暂不可签到'
                : ({ cancelled: '报名已取消', refunded: '报名已退款', no_show: '已标记未到场' }[item.status] ?? '请核对报名状态')
      return { publicId: item.publicId, activityPublicId: item.activityPublicId, title: item.activityTitle,
        startsAt: item.startsAt, partySize: item.partySize, guidance, readyForCheckIn }
    }),
    benefits: benefits.map(item => {
      const display = item.benefitSnapshot.publicDisplay
      const title = display && typeof display === 'object' && !Array.isArray(display) && typeof display.title === 'string'
        ? display.title : '会员权益'
      return { id: item.id, title, quantity: item.quantityAvailable, validUntil: item.validUntil,
        guidance: item.pricePromise ? '点单结算时选择此券，付款成功后核销'
          : item.benefitType === 'gift_product' ? '请按小程序券面方式申请使用；已申请的领取由有权限员工处理权益待办，以领取规则和库存为准'
            : '当前券有效，请按券面适用范围和对应业务入口办理' }
    }),
  }
}
