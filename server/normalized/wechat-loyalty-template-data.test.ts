import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  WECHAT_POINTS_CHANGE_TEMPLATE_ID,
  WECHAT_POINTS_EXPIRY_TEMPLATE_ID,
  buildWechatLoyaltyTemplateData,
  maskAccountLabel,
  wechatNotificationFieldMappingError,
  wechatPointsChangeFieldMappings,
  wechatPointsExpiryFieldMappings,
  wechatPointsNotificationPreset,
  type WechatLoyaltyTemplateFacts,
} from '../../src/shared/wechat-loyalty-subscription-templates.js'

const changeFacts: WechatLoyaltyTemplateFacts = {
  notificationType: 'loyalty_points_credited',
  pointsChange: 30,
  pointsAtRisk: 0,
  balanceAfter: 10000,
  eventOccurredAt: '2026-08-16T02:01:00.000Z',
  expiresAt: null,
  storeName: '某某店',
  storeTimeZone: 'Asia/Shanghai',
}

describe('WeChat loyalty subscription template data', () => {
  it('fills every keyword of the points-change template and splits grant from deduction', () => {
    expect(buildWechatLoyaltyTemplateData(wechatPointsChangeFieldMappings, changeFacts)).toEqual({
      thing5: '某某店',
      number2: '30',
      number7: '10000',
      number3: '0',
      number4: '10000',
    })
    expect(buildWechatLoyaltyTemplateData(wechatPointsChangeFieldMappings, {
      ...changeFacts,
      notificationType: 'loyalty_points_reversed',
      pointsChange: -20,
      balanceAfter: 9980,
    })).toEqual({
      thing5: '某某店',
      number2: '0',
      number7: '9980',
      number3: '20',
      number4: '9980',
    })
  })

  it('fills the expiry template with a masked account, a Shanghai time and point text', () => {
    expect(buildWechatLoyaltyTemplateData(wechatPointsExpiryFieldMappings, {
      notificationType: 'loyalty_points_expiring',
      pointsChange: 0,
      pointsAtRisk: 40,
      balanceAfter: null,
      eventOccurredAt: '2021-04-21T01:00:00.000Z',
      expiresAt: '2021-04-21T02:15:00.000Z',
      accountDisplayName: '张三丰',
      memberNo: 'M10086',
      lastMonthConsumedPoints: 0,
      monthExpiringPoints: 40,
      accountPointsBalance: 300,
      storeTimeZone: 'Asia/Shanghai',
    })).toEqual({
      thing1: '张*丰',
      time2: '2021年4月21日 10:15',
      thing3: '0分',
      thing4: '40分',
      thing5: '300分',
    })
  })

  it('keeps number values unsigned, masks names, and falls back when facts are missing', () => {
    expect(maskAccountLabel('张', null)).toBe('张')
    expect(maskAccountLabel('张三', null)).toBe('张*')
    expect(maskAccountLabel('欧阳娜娜', null)).toBe('欧**娜')
    expect(maskAccountLabel('  ', 'mb-3456')).toBe('会员****3456')
    expect(maskAccountLabel(null, null)).toBe('会员')
    expect(buildWechatLoyaltyTemplateData(
      [{ dataKey: 'thing5', valueSource: 'store_name' }],
      { ...changeFacts, storeName: '一二三四五六七八九十一二三四五六七八九十多余' },
    ).thing5).toBe('一二三四五六七八九十一二三四五六七八九十')
    expect(buildWechatLoyaltyTemplateData(
      [{ dataKey: 'thing5', valueSource: 'store_name' }],
      { ...changeFacts, storeName: null },
    ).thing5).toBe('本店')
    expect(buildWechatLoyaltyTemplateData(
      [{ dataKey: 'date2', valueSource: 'expires_at' }],
      {
        ...changeFacts,
        notificationType: 'loyalty_points_expiring',
        expiresAt: '2021-04-21T02:15:00.000Z',
      },
    ).date2).toBe('2021年4月21日')
    expect(() => buildWechatLoyaltyTemplateData(
      [{ dataKey: 'number2', valueSource: 'granted_points' }],
      { ...changeFacts, pointsChange: -3 },
    )).toThrow(/template number value is invalid/)
  })

  it('requires the exact known templates and leaves other template ids on the legacy path', () => {
    const credited = wechatPointsNotificationPreset('loyalty_points_credited')
    expect(credited.templateId).toBe(WECHAT_POINTS_CHANGE_TEMPLATE_ID)
    expect(credited.occurredAtDataKey).toBe('time9')
    expect(credited.fieldMappings.map((field) => field.dataKey)).not.toContain('time9')
    expect(wechatNotificationFieldMappingError(credited)).toBeNull()
    expect(wechatNotificationFieldMappingError({ ...credited, fieldMappings: [] })).toMatch(/必须映射/)
    expect(wechatNotificationFieldMappingError({
      notificationType: 'loyalty_points_expiring',
      templateId: 'store-legacy-template',
      fieldMappings: [],
    })).toBeNull()
    expect(wechatPointsNotificationPreset('loyalty_points_expiring').templateId).toBe(WECHAT_POINTS_EXPIRY_TEMPLATE_ID)
  })

  it('stores the same two template ids in schema 273', () => {
    const sql = readFileSync(new URL('../../database/normalized-migrations/273_wechat_notification_field_mappings.sql', import.meta.url), 'utf8')
    expect(sql).toContain(WECHAT_POINTS_CHANGE_TEMPLATE_ID)
    expect(sql).toContain(WECHAT_POINTS_EXPIRY_TEMPLATE_ID)
    expect(sql).toContain('create_managed_notification_draft')
    expect(sql).toContain("schema_version='273'")
  })
})
