const CHINESE_NAME_PATTERN = /(?:中文|汉语|漢語|普通话|普通話|mandarin|chinese|xiaoxiao|晓晓|tingting|婷婷|meijia|美佳|huihui|慧慧|yunxi|云希|yunyang|云扬|xiaoyi|晓伊)/i

const CHINESE_SENSITIVE_PATTERN = /(?:密码|密钥|秘钥|口令|验证码|校验码|动态码|短信码|付款码|支付码|收款码|银行卡|信用卡|身份证|安全码)/i
const LATIN_SENSITIVE_PATTERN = /(?:^|[^a-z0-9])(?:pin[\s_-]*code|pin|(?:access|refresh|auth|id)[\s_.-]*token|token|client[\s_.-]*secret|secret[\s_.-]*key|secret|password|passcode|otp|cvv|cvc|api[\s_-]*key|access[\s_-]*key|private[\s_-]*key|authorization|bearer)(?=$|[^a-z0-9])/i

const FAILURE_PATTERN = /(?:失败|错误|拒绝|不能|无法|不可用|无效|未保存|未提交|未执行|没有执行|未完成|未能|异常|请重试|请再说|请重新)/
const SUCCESS_PATTERN = /(?:成功|已完成|已执行|已打开|已关闭|已保存|已提交|已更新|已创建|已选择|已选为|已填写|已切换|已发送|已回到|已向)/
const HUMAN_PREFIX_PATTERN = /^(?:好的?|收到|明白|抱歉|不好意思)[，,。.!！]?/

function normalizedLanguage(voice: SpeechSynthesisVoice) {
  return voice.lang.trim().toLowerCase().replaceAll('_', '-')
}

function chineseLocaleScore(voice: SpeechSynthesisVoice) {
  const language = normalizedLanguage(voice)

  if (/^zh-cn(?:-|$)/.test(language)) return 10_000
  if (/^(?:zh|cmn)-(?:hans-)?cn(?:-|$)/.test(language)) return 9_900
  if (/^(?:zh|cmn)-hans(?:-|$)/.test(language)) return 9_600
  if (/^(?:zh|cmn)-(?:hans-)?sg(?:-|$)/.test(language)) return 9_300
  if (/^(?:zh|cmn)-(?:hant-)?tw(?:-|$)/.test(language)) return 7_600
  if (/^(?:zh|cmn)-(?:hant-)?hk(?:-|$)/.test(language)) return 7_300
  if (/^(?:zh|cmn)(?:-|$)/.test(language)) return 8_800
  if (/^yue(?:-|$)/.test(language)) return 6_800
  if (CHINESE_NAME_PATTERN.test(voice.name)) return 6_000
  return 0
}

function naturalVoiceScore(name: string) {
  if (/(?:natural|自然)/i.test(name)) return 900
  if (/(?:premium|高级)/i.test(name)) return 800
  if (/(?:neural|神经)/i.test(name)) return 700
  if (/(?:enhanced|增强)/i.test(name)) return 500
  return 0
}

function familiarVoiceScore(name: string) {
  if (/(?:xiaoxiao|晓晓)/i.test(name)) return 420
  if (/(?:tingting|婷婷)/i.test(name)) return 380
  if (/(?:meijia|美佳)/i.test(name)) return 360
  if (/google.*(?:普通话|普通話|mandarin|chinese)|(?:普通话|普通話|mandarin|chinese).*google/i.test(name)) return 340
  return 0
}

function voiceScore(voice: SpeechSynthesisVoice, savedVoiceURI: string) {
  if (savedVoiceURI && voice.voiceURI === savedVoiceURI) return 1_000_000

  const localeScore = chineseLocaleScore(voice)
  if (!localeScore) return voice.default ? 50_000 : 0

  return 100_000
    + localeScore
    + naturalVoiceScore(voice.name)
    + familiarVoiceScore(voice.name)
    + (voice.default ? 20 : 0)
    + (voice.localService ? 10 : 0)
}

/**
 * Ranks every available browser voice while keeping non-Chinese voices as a
 * deterministic fallback. The input array is never mutated.
 */
export function rankChineseVoices(
  voices: readonly SpeechSynthesisVoice[],
  savedVoiceURI?: string | null,
): SpeechSynthesisVoice[] {
  const preferredURI = savedVoiceURI?.trim() ?? ''

  return voices
    .map((voice, index) => ({ voice, index, score: voiceScore(voice, preferredURI) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ voice }) => voice)
}

export function selectPreferredChineseVoice(
  voices: readonly SpeechSynthesisVoice[],
  savedVoiceURI?: string | null,
): SpeechSynthesisVoice | null {
  return rankChineseVoices(voices, savedVoiceURI)[0] ?? null
}

function compactFeedback(feedback: string) {
  return feedback
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/页面状态已经变化/g, '页面状态有变化')
    .replace(/请重新说一次(?:命令)?/g, '请再说一次')
    .replace(/刚才的命令没有执行/g, '刚才没有执行')
    .replace(/[，,]?执行结果仍会显示在面板中[。.]?$/g, '。')
}

/**
 * Produces concise spoken copy. An empty string means the feedback must not be
 * spoken because it may expose a credential, verification code, or payment code.
 */
export function naturalizeSpokenFeedback(feedback: string): string {
  const compact = compactFeedback(feedback)
  if (!compact) return ''
  if (CHINESE_SENSITIVE_PATTERN.test(compact) || LATIN_SENSITIVE_PATTERN.test(compact)) return ''
  if (HUMAN_PREFIX_PATTERN.test(compact)) return compact

  const cancelledAsRequested = /已取消/.test(compact) && !/(?:失败|错误|异常)/.test(compact)
  if (cancelledAsRequested) return `好的，${compact}`
  if (FAILURE_PATTERN.test(compact)) return `抱歉，${compact}`
  if (SUCCESS_PATTERN.test(compact)) return `好的，${compact}`
  return compact
}
