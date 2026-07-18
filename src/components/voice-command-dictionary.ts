import { pinyin } from 'pinyin-pro'
import type { BootstrapResponse, StoreConfig } from '../shared/contracts'
import type { VoicePageControl } from './voice-page-controls'

export type VoiceCommandCategory =
  | 'employee'
  | 'role'
  | 'table'
  | 'area'
  | 'singer'
  | 'song'
  | 'product'
  | 'service'
  | 'workstation'
  | 'control'
  | 'option'

export interface VoiceCommandDictionaryEntry {
  canonical: string
  category: VoiceCommandCategory
  aliases: string[]
  pinyin: string
  initials: string
  boost: number
}

export interface VoiceTranscriptCandidate {
  transcript: string
  confidence?: number
}

export type VoiceTranscript = string | VoiceTranscriptCandidate

export interface VoiceTranscriptSelection {
  transcript: string
  canonicalized: string
  confidence: number
  dictionarySupport: number
  score: number
  safeToPlan: boolean
}

interface PinyinToken {
  origin: string
  result: string
  first: string
  isZh: boolean
}

interface Replacement {
  form: string
  canonical: string
  boost: number
  rank: number
}

interface ReplacementMatch extends Replacement {
  start: number
  end: number
}

const categoryOrder: readonly VoiceCommandCategory[] = [
  'control',
  'option',
  'table',
  'service',
  'employee',
  'singer',
  'song',
  'product',
  'workstation',
  'role',
  'area',
]

const categoryBoost: Record<VoiceCommandCategory, number> = {
  control: 10,
  option: 9,
  table: 9,
  service: 9,
  employee: 8,
  singer: 8,
  song: 8,
  product: 8,
  workstation: 8,
  role: 7,
  area: 7,
}

const englishNameReadings: Record<string, readonly string[]> = {
  tom: ['汤姆', '托姆'],
  jerry: ['杰瑞', '杰里', '吉瑞'],
  tyke: ['泰克', '太克', '泰科'],
}

const spokenLetters: Record<string, string> = {
  A: '诶',
  B: '比',
  C: '西',
  D: '迪',
  E: '伊',
  F: '艾弗',
  G: '吉',
  H: '艾尺',
  I: '爱',
  J: '杰',
  K: '开',
  L: '艾勒',
  M: '艾姆',
  N: '恩',
  O: '欧',
  P: '屁',
  Q: '丘',
  R: '阿尔',
  S: '艾斯',
  T: '提',
  U: '优',
  V: '维',
  W: '达不溜',
  X: '艾克斯',
  Y: '歪',
  Z: '泽德',
}

const spokenDigits: Record<string, string> = {
  '0': '零',
  '1': '一',
  '2': '二',
  '3': '三',
  '4': '四',
  '5': '五',
  '6': '六',
  '7': '七',
  '8': '八',
  '9': '九',
}

const radioDigits: Record<string, string> = {
  ...spokenDigits,
  '0': '洞',
  '1': '幺',
  '7': '拐',
  '9': '勾',
}

function cleanPhrase(value: string | null | undefined) {
  const phrase = String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  return phrase.length <= 120 ? phrase : ''
}

function comparable(value: string) {
  return cleanPhrase(value)
    .toLocaleLowerCase('zh-CN')
    .replace(/[，。！？、,.!?：:；;（）()【】[\]“”"'`~·/\\_\s-]+/g, '')
}

function phrasePinyin(value: string) {
  return pinyin(cleanPhrase(value), {
    toneType: 'none',
    nonZh: 'consecutive',
    v: true,
  })
    .toLocaleLowerCase('zh-CN')
    .replace(/[^a-z0-9vü]+/g, ' ')
    .trim()
}

function phraseInitials(value: string) {
  const phrase = cleanPhrase(value)
  if (!phrase) return ''
  if (!/[\u3400-\u9fff]/u.test(phrase)) {
    return (phrase.match(/[a-z0-9]+/gi) ?? [])
      .map((part) => part[0]?.toLocaleLowerCase('zh-CN') ?? '')
      .join('')
  }
  return pinyin(phrase, {
    pattern: 'first',
    toneType: 'none',
    separator: '',
    nonZh: 'consecutive',
  })
    .toLocaleLowerCase('zh-CN')
    .replace(/[^a-z0-9]+/g, '')
}

function uniquePhrases(values: readonly string[], canonical = '') {
  const canonicalKey = comparable(canonical)
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const phrase = cleanPhrase(value)
    const key = comparable(phrase)
    if (!phrase || !key || key === canonicalKey || seen.has(key)) return []
    seen.add(key)
    return [phrase]
  })
}

function englishReadingAliases(name: string) {
  const aliases: string[] = []
  for (const [englishName, readings] of Object.entries(englishNameReadings)) {
    const pattern = new RegExp(`\\b${englishName}\\b`, 'gi')
    if (!pattern.test(name)) continue
    for (const reading of readings) aliases.push(name.replace(pattern, reading))
  }
  return aliases
}

function chineseInteger(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 9999) return ''
  if (value === 0) return '零'
  const units = ['', '十', '百', '千']
  const digits = String(value).split('').map(Number)
  let result = ''
  let pendingZero = false
  digits.forEach((digit, index) => {
    const unitIndex = digits.length - index - 1
    if (digit === 0) {
      pendingZero = Boolean(result) && digits.slice(index + 1).some((item) => item !== 0)
      return
    }
    if (pendingZero) result += '零'
    if (!(digit === 1 && unitIndex === 1 && result === '')) result += spokenDigits[String(digit)]
    result += units[unitIndex]
    pendingZero = false
  })
  return result
}

function tableAliases(codeValue: string, displayName: string) {
  const code = cleanPhrase(codeValue).toLocaleUpperCase('zh-CN')
  const aliases = [code, displayName]
  const compactCode = code.replace(/[\s_-]+/g, '')
  const match = compactCode.match(/^([A-Z]*)(\d+)$/)
  if (!match) return uniquePhrases(aliases, displayName)

  const letters = match[1] ?? ''
  const digits = match[2] ?? ''
  const compactNumber = String(Number(digits))
  const letterReading = [...letters].map((letter) => spokenLetters[letter] ?? letter).join('')
  const digitReading = [...digits].map((digit) => spokenDigits[digit] ?? digit).join('')
  const radioReading = [...digits].map((digit) => radioDigits[digit] ?? digit).join('')
  const cardinalReading = chineseInteger(Number(digits))
  const speechLetterCode = compactCode.replaceAll('0', 'O')
  const bases = uniquePhrases([
    compactCode,
    speechLetterCode,
    `${letters}${compactNumber}`,
    `${letters}${digitReading}`,
    `${letters}${radioReading}`,
    `${letters}${cardinalReading}`,
    `${letterReading}${digits}`,
    `${letterReading}${digitReading}`,
    `${letterReading}${radioReading}`,
    `${letterReading}${cardinalReading}`,
  ])
  for (const base of bases) {
    aliases.push(base, `${base}桌`, `${base}号桌`, `${base}桌台`)
  }
  return uniquePhrases(aliases, displayName)
}

function canonicalTableCode(codeValue: string) {
  return cleanPhrase(codeValue).toLocaleUpperCase('zh-CN').replace(/[\s_-]+/g, '')
}

function configSources(data: BootstrapResponse): StoreConfig[] {
  return data.draftConfig ? [data.config, data.draftConfig] : [data.config]
}

export function buildVoiceCommandDictionary(
  data: BootstrapResponse,
  controls: readonly VoicePageControl[] = [],
): VoiceCommandDictionaryEntry[] {
  const entries = new Map<string, VoiceCommandDictionaryEntry>()

  function add(category: VoiceCommandCategory, canonicalValue: string, aliasValues: readonly string[] = []) {
    const canonical = cleanPhrase(canonicalValue)
    const canonicalKey = comparable(canonical)
    if (!canonical || !canonicalKey) return
    const key = `${category}:${canonicalKey}`
    const aliases = uniquePhrases(aliasValues, canonical)
    const existing = entries.get(key)
    if (existing) {
      existing.aliases = uniquePhrases([...existing.aliases, ...aliases], existing.canonical)
      existing.boost = Math.max(existing.boost, categoryBoost[category])
      return
    }
    entries.set(key, {
      canonical,
      category,
      aliases,
      pinyin: phrasePinyin(canonical),
      initials: phraseInitials(canonical),
      boost: categoryBoost[category],
    })
  }

  for (const employee of data.employees) {
    add('employee', employee.displayName, englishReadingAliases(employee.displayName))
  }
  for (const area of data.areas) add('area', area.name, [area.shortName])
  for (const table of data.tables) {
    const canonical = canonicalTableCode(table.code) || cleanPhrase(table.displayName)
    add('table', canonical, [table.displayName, ...tableAliases(table.code, table.displayName)])
  }
  for (const product of data.products) {
    add('product', product.name, [
      product.sku,
      product.specification ? `${product.name}${product.specification}` : '',
    ])
  }
  for (const singer of data.songState.singers) {
    add('singer', singer.displayName, englishReadingAliases(singer.displayName))
  }
  for (const song of data.songState.songs) {
    add('song', song.title, [
      song.artist ? `${song.title}${song.artist}` : '',
      song.artist ? `${song.artist}${song.title}` : '',
    ])
  }
  for (const config of configSources(data)) {
    for (const role of config.roles) add('role', role.name)
    for (const serviceType of config.serviceTypes) add('service', serviceType.name, [serviceType.code])
    for (const workstation of config.workstations) add('workstation', workstation.name)
  }
  for (const control of controls) {
    const canonical = cleanPhrase(control.displayName) || cleanPhrase(control.label)
    add('control', canonical, [control.label, control.displayName, control.context ? `${control.context}${control.label}` : ''])
    for (const option of control.options ?? []) {
      add('option', option.label, [
        `${control.label}${option.label}`,
        `${control.displayName}${option.label}`,
      ])
    }
  }

  return [...entries.values()].sort((left, right) => (
    categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category)
    || left.canonical.localeCompare(right.canonical, 'zh-CN')
  ))
}

function replacementPattern(form: string) {
  const escaped = form
    .split(/[\s_-]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s_-]*')
  const startsWithAscii = /^[a-z0-9]/i.test(form)
  const endsWithAscii = /[a-z0-9]$/i.test(form)
  return new RegExp(`${startsWithAscii ? '(?<![a-z0-9])' : ''}${escaped}${endsWithAscii ? '(?![a-z0-9])' : ''}`, 'giu')
}

function directReplacements(dictionary: readonly VoiceCommandDictionaryEntry[]) {
  const replacements = new Map<string, Replacement>()
  const add = (formValue: string, entry: VoiceCommandDictionaryEntry, rank: number) => {
    const form = cleanPhrase(formValue)
    const key = comparable(form)
    if (!form || !key) return
    const existing = replacements.get(key)
    if (existing && (existing.rank > rank || existing.rank === rank && existing.boost >= entry.boost)) return
    replacements.set(key, { form, canonical: entry.canonical, boost: entry.boost, rank })
  }

  for (const entry of dictionary) {
    add(entry.canonical, entry, 4)
    for (const alias of entry.aliases) add(alias, entry, 3)
    for (const phrase of [entry.canonical, ...entry.aliases]) {
      const fullPinyin = phrasePinyin(phrase)
      if (fullPinyin.length >= 2) add(fullPinyin, entry, 2)
      const initials = phraseInitials(phrase)
      if (initials.length >= 2) add(initials, entry, 1)
    }
  }
  return [...replacements.values()].sort((left, right) => (
    comparable(right.form).length - comparable(left.form).length
    || right.rank - left.rank
    || right.boost - left.boost
  ))
}

function applyDirectReplacements(command: string, dictionary: readonly VoiceCommandDictionaryEntry[]) {
  const source = cleanPhrase(command)
  const protectedSpans = dictionary.flatMap((entry) => {
    const pattern = replacementPattern(entry.canonical)
    return [...source.matchAll(pattern)].flatMap((match) => match.index === undefined ? [] : [{
      start: match.index,
      end: match.index + match[0].length,
      canonical: entry.canonical,
    }])
  })
  const matches: ReplacementMatch[] = []
  for (const replacement of directReplacements(dictionary)) {
    if (comparable(replacement.form) === comparable(replacement.canonical)) continue
    for (const match of source.matchAll(replacementPattern(replacement.form))) {
      if (match.index === undefined) continue
      const start = match.index
      const end = start + match[0].length
      if (protectedSpans.some((span) => (
        start < span.end
        && end > span.start
        && !(span.canonical === replacement.canonical && start <= span.start && end >= span.end)
      ))) continue
      matches.push({ ...replacement, start, end })
    }
  }
  matches.sort((left, right) => (
    left.start - right.start
    || (right.end - right.start) - (left.end - left.start)
    || right.rank - left.rank
    || right.boost - left.boost
  ))

  const selected: ReplacementMatch[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    selected.push(match)
    cursor = match.end
  }
  if (selected.length === 0) return source

  let result = ''
  cursor = 0
  for (const match of selected) {
    result += `${source.slice(cursor, match.start)}${match.canonical}`
    cursor = match.end
  }
  return `${result}${source.slice(cursor)}`
}

function applyHomophoneReplacements(command: string, dictionary: readonly VoiceCommandDictionaryEntry[]) {
  const directPhrases = new Set(
    dictionary.flatMap((entry) => [entry.canonical, ...entry.aliases]).map(comparable).filter(Boolean),
  )
  const homophones = new Map<string, { canonical: string; syllables: string[]; boost: number }>()
  for (const entry of dictionary) {
    for (const phrase of [entry.canonical, ...entry.aliases]) {
      if (!/^[\u3400-\u9fff]{2,12}$/u.test(phrase)) continue
      const syllables = pinyin(phrase, { type: 'array', toneType: 'none', nonZh: 'removed', v: true })
        .map((syllable) => syllable.toLocaleLowerCase('zh-CN'))
      if (syllables.length < 2) continue
      const key = syllables.join(' ')
      const existing = homophones.get(key)
      if (!existing || entry.boost > existing.boost) {
        homophones.set(key, { canonical: entry.canonical, syllables, boost: entry.boost })
      }
    }
  }
  if (homophones.size === 0) return command

  const byFirstSyllable = new Map<string, Array<{ canonical: string; syllables: string[]; boost: number }>>()
  for (const candidate of homophones.values()) {
    const first = candidate.syllables[0]
    if (!first) continue
    const values = byFirstSyllable.get(first) ?? []
    values.push(candidate)
    values.sort((left, right) => right.syllables.length - left.syllables.length || right.boost - left.boost)
    byFirstSyllable.set(first, values)
  }

  const tokens = pinyin(command, {
    type: 'all',
    toneType: 'none',
    nonZh: 'consecutive',
    v: true,
  }) as PinyinToken[]
  const offsets: number[] = []
  let offset = 0
  for (const token of tokens) {
    offsets.push(offset)
    offset += token.origin.length
  }
  const matches: Array<{ start: number; end: number; canonical: string }> = []
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]
    if (!token?.isZh) {
      index += 1
      continue
    }
    const candidates = byFirstSyllable.get(token.result.toLocaleLowerCase('zh-CN')) ?? []
    const match = candidates.find((candidate) => candidate.syllables.every((syllable, syllableIndex) => {
      const current = tokens[index + syllableIndex]
      return current?.isZh && current.result.toLocaleLowerCase('zh-CN') === syllable
    }))
    if (!match) {
      index += 1
      continue
    }
    const endIndex = index + match.syllables.length
    const start = offsets[index] ?? 0
    const end = endIndex < offsets.length ? offsets[endIndex] ?? command.length : command.length
    const original = command.slice(start, end)
    if (!directPhrases.has(comparable(original)) && comparable(original) !== comparable(match.canonical)) {
      matches.push({ start, end, canonical: match.canonical })
    }
    index = endIndex
  }

  let result = command
  for (const match of matches.reverse()) {
    result = `${result.slice(0, match.start)}${match.canonical}${result.slice(match.end)}`
  }
  return result
}

export function canonicalizeVoiceCommand(
  command: string,
  dictionary: readonly VoiceCommandDictionaryEntry[],
) {
  if (!cleanPhrase(command) || dictionary.length === 0) return cleanPhrase(command)
  return applyHomophoneReplacements(applyDirectReplacements(command, dictionary), dictionary)
}

function dictionarySupportScore(
  transcript: string,
  canonicalized: string,
  dictionary: readonly VoiceCommandDictionaryEntry[],
) {
  const normalized = comparable(transcript)
  const transcriptPinyin = comparable(phrasePinyin(transcript))
  const asciiParts = new Set(transcript.toLocaleLowerCase('zh-CN').match(/[a-z][a-z0-9]*/g) ?? [])
  let best = comparable(transcript) === comparable(canonicalized) ? 0 : 22
  for (const entry of dictionary) {
    const forms = uniquePhrases([entry.canonical, ...entry.aliases])
    for (const form of forms) {
      const normalizedForm = comparable(form)
      if (!normalizedForm) continue
      if (normalized === normalizedForm) best = Math.max(best, 50 + entry.boost * 2)
      else if (normalizedForm.length >= 2 && normalized.includes(normalizedForm)) {
        best = Math.max(best, 24 + entry.boost * 1.5)
      }
      const formPinyin = comparable(phrasePinyin(form))
      if (formPinyin.length >= 4 && transcriptPinyin.includes(formPinyin)) {
        best = Math.max(best, 18 + entry.boost * 1.5)
      }
      const initials = phraseInitials(form)
      if (initials.length >= 2 && asciiParts.has(initials)) best = Math.max(best, 28 + entry.boost * 1.5)
    }
  }
  return best
}

function normalizedConfidence(confidence: number | undefined) {
  if (confidence === undefined || !Number.isFinite(confidence)) return 0.5
  return Math.min(1, Math.max(0, confidence))
}

export function chooseBestVoiceTranscriptSelection(
  transcripts: readonly VoiceTranscript[] | ArrayLike<VoiceTranscript>,
  dictionary: readonly VoiceCommandDictionaryEntry[],
): VoiceTranscriptSelection | null {
  const candidates = Array.from(transcripts).flatMap((candidate, index) => {
    const transcript = cleanPhrase(typeof candidate === 'string' ? candidate : candidate.transcript)
    if (!transcript) return []
    const confidence = normalizedConfidence(typeof candidate === 'string' ? undefined : candidate.confidence)
    const canonicalized = canonicalizeVoiceCommand(transcript, dictionary)
    const dictionarySupport = dictionarySupportScore(transcript, canonicalized, dictionary)
    return [{
      transcript,
      canonicalized,
      confidence,
      dictionarySupport,
      index,
      score: confidence * 100 + dictionarySupport,
      safeToPlan: confidence >= 0.65
        || dictionarySupport >= 45
        || confidence >= 0.45 && dictionarySupport >= 24,
    }]
  })
  candidates.sort((left, right) => (
    right.score - left.score
    || right.confidence - left.confidence
    || left.index - right.index
  ))
  const best = candidates[0]
  if (!best) return null
  return {
    transcript: best.transcript,
    canonicalized: best.canonicalized,
    confidence: best.confidence,
    dictionarySupport: best.dictionarySupport,
    score: best.score,
    safeToPlan: best.safeToPlan,
  }
}

export function chooseBestVoiceTranscript(
  transcripts: readonly VoiceTranscript[] | ArrayLike<VoiceTranscript>,
  dictionary: readonly VoiceCommandDictionaryEntry[],
) {
  return chooseBestVoiceTranscriptSelection(transcripts, dictionary)?.canonicalized ?? ''
}

export function dictionaryBiasPhrases(
  dictionary: readonly VoiceCommandDictionaryEntry[],
  maximum = 256,
) {
  if (maximum <= 0) return []
  const phrases: string[] = []
  const seen = new Set<string>()
  const entries = [...dictionary].sort((left, right) => right.boost - left.boost)
  for (const entry of entries) {
    for (const phrase of [entry.canonical, ...entry.aliases, entry.pinyin, entry.initials]) {
      const clean = cleanPhrase(phrase)
      const key = comparable(clean)
      if (!clean || !key || seen.has(key)) continue
      seen.add(key)
      phrases.push(clean)
      if (phrases.length >= maximum) return phrases
    }
  }
  return phrases
}
