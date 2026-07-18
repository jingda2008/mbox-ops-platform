import { describe, expect, it } from 'vitest'
import {
  naturalizeSpokenFeedback,
  rankChineseVoices,
  selectPreferredChineseVoice,
} from './voice-speech'

function voice(
  name: string,
  lang: string,
  overrides: Partial<SpeechSynthesisVoice> = {},
): SpeechSynthesisVoice {
  return {
    default: false,
    lang,
    localService: false,
    name,
    voiceURI: `voice://${name}`,
    ...overrides,
  }
}

describe('rankChineseVoices', () => {
  it('always puts an available saved voiceURI first', () => {
    const saved = voice('Saved English Voice', 'en-US', { voiceURI: 'saved://voice' })
    const naturalChinese = voice('Microsoft Xiaoxiao Online (Natural)', 'zh-CN')

    expect(rankChineseVoices([naturalChinese, saved], 'saved://voice')).toEqual([saved, naturalChinese])
  })

  it('ignores a missing saved voiceURI and selects the best current Chinese voice', () => {
    const generic = voice('Chinese voice', 'zh-CN')
    const premium = voice('Chinese Premium', 'zh-CN')
    const natural = voice('Microsoft Xiaoxiao Online (Natural)', 'zh-CN')

    expect(rankChineseVoices([generic, premium, natural], 'removed://voice')).toEqual([
      natural,
      premium,
      generic,
    ])
  })

  it('prefers mainland Mandarin locale before quality labels from other Chinese locales', () => {
    const taiwanPremium = voice('Meijia Premium', 'zh-TW')
    const mainlandGeneric = voice('System Chinese', 'zh-CN')
    const hongKongNatural = voice('Hong Kong Natural', 'zh-HK')

    expect(rankChineseVoices([taiwanPremium, hongKongNatural, mainlandGeneric])).toEqual([
      mainlandGeneric,
      taiwanPremium,
      hongKongNatural,
    ])
  })

  it('recognizes common mainland language aliases and underscore separators', () => {
    const english = voice('English', 'en-US', { default: true })
    const simplified = voice('Mandarin A', 'zh_Hans_CN')
    const cmn = voice('Mandarin B', 'cmn-CN')

    expect(rankChineseVoices([english, simplified, cmn])).toEqual([simplified, cmn, english])
  })

  it('recognizes familiar Chinese voice names even when browser locale metadata is poor', () => {
    const englishDefault = voice('English', 'en-US', { default: true })
    const googleMandarin = voice('Google 普通话（中国大陆）', '')

    expect(selectPreferredChineseVoice([englishDefault, googleMandarin])).toBe(googleMandarin)
  })

  it('uses familiar names as a stable quality tie-breaker', () => {
    const meijia = voice('Meijia', 'zh-CN')
    const tingting = voice('Tingting', 'zh-CN')
    const xiaoxiao = voice('Xiaoxiao', 'zh-CN')
    const google = voice('Google 普通话（中国大陆）', 'zh-CN')

    expect(rankChineseVoices([google, meijia, tingting, xiaoxiao])).toEqual([
      xiaoxiao,
      tingting,
      meijia,
      google,
    ])
  })

  it('falls back to the browser default and then preserves source order', () => {
    const first = voice('First English', 'en-US')
    const defaultVoice = voice('Browser default', 'en-GB', { default: true })
    const last = voice('Last English Natural', 'en-AU')

    expect(rankChineseVoices([first, defaultVoice, last])).toEqual([defaultVoice, first, last])
  })

  it('keeps equal-score voices stable and does not mutate the source array', () => {
    const first = voice('Chinese A', 'zh-CN')
    const second = voice('Chinese B', 'zh-CN')
    const source = [first, second]

    expect(rankChineseVoices(source)).toEqual([first, second])
    expect(source).toEqual([first, second])
  })
})

describe('selectPreferredChineseVoice', () => {
  it('returns the first ranked voice or null when none are available', () => {
    const natural = voice('Microsoft Xiaoxiao Online (Natural)', 'zh-CN')
    expect(selectPreferredChineseVoice([voice('English', 'en-US'), natural])).toBe(natural)
    expect(selectPreferredChineseVoice([])).toBeNull()
  })

  it('treats a blank saved URI as absent', () => {
    const first = voice('Chinese A', 'zh-CN')
    const second = voice('Chinese Natural', 'zh-CN')
    expect(selectPreferredChineseVoice([first, second], '   ')).toBe(second)
  })
})

describe('naturalizeSpokenFeedback', () => {
  it('adds a concise human acknowledgement without changing success meaning', () => {
    expect(naturalizeSpokenFeedback('已打开现场桌台。')).toBe('好的，已打开现场桌台。')
    expect(naturalizeSpokenFeedback('保存成功。')).toBe('好的，保存成功。')
  })

  it('keeps failures explicit and empathetic', () => {
    expect(naturalizeSpokenFeedback('保存失败，请重试。')).toBe('抱歉，保存失败，请重试。')
    expect(naturalizeSpokenFeedback('该选项当前不可用。')).toBe('抱歉，该选项当前不可用。')
  })

  it('treats a requested cancellation as an acknowledged result, not a failure', () => {
    expect(naturalizeSpokenFeedback('已取消，刚才的命令没有执行。')).toBe('好的，已取消，刚才没有执行。')
  })

  it('shortens known UI boilerplate while retaining its meaning', () => {
    expect(naturalizeSpokenFeedback(' 页面状态已经变化，请重新说一次命令。 ')).toBe(
      '抱歉，页面状态有变化，请再说一次。',
    )
    expect(naturalizeSpokenFeedback('语音播报已关闭，执行结果仍会显示在面板中。')).toBe(
      '好的，语音播报已关闭。',
    )
  })

  it('does not add duplicate conversational prefixes', () => {
    expect(naturalizeSpokenFeedback('抱歉，操作失败。')).toBe('抱歉，操作失败。')
    expect(naturalizeSpokenFeedback('好的，已保存。')).toBe('好的，已保存。')
  })

  it.each([
    '员工 PIN：1234',
    '密码已填写：mbox-2026',
    '接口密钥是 abc123',
    'access_token=secret-value',
    'accessToken=abc.def',
    'clientSecret=private-value',
    '验证码 839201 已发送',
    '请展示付款码 621234',
    'Authorization: Bearer abc.def',
    '信用卡安全码为 123',
  ])('blocks sensitive feedback instead of speaking it: %s', (feedback) => {
    expect(naturalizeSpokenFeedback(feedback)).toBe('')
  })

  it('does not mistake ordinary words containing short Latin fragments for secrets', () => {
    expect(naturalizeSpokenFeedback('spinning class 已创建。')).toBe('好的，spinning class 已创建。')
    expect(naturalizeSpokenFeedback('tokenization 任务正在处理。')).toBe('tokenization 任务正在处理。')
  })

  it('normalizes whitespace and leaves neutral or in-progress meaning unchanged', () => {
    expect(naturalizeSpokenFeedback('  正在处理，  请稍候。  ')).toBe('正在处理， 请稍候。')
    expect(naturalizeSpokenFeedback('')).toBe('')
    expect(naturalizeSpokenFeedback('   ')).toBe('')
  })
})
