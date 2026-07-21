import { describe, expect, it } from 'vitest'
import type { BootstrapResponse } from '../shared/contracts'
import type { VoicePageControl } from './voice-page-controls'
import {
  buildVoiceCommandDictionary,
  canonicalizeVoiceCommand,
  chooseBestVoiceTranscript,
  chooseBestVoiceTranscriptSelection,
  dictionaryBiasPhrases,
  rankVoiceTranscriptSelections,
  type VoiceCommandDictionaryEntry,
} from './voice-command-dictionary'

function bootstrapFixture() {
  return {
    employees: [
      { id: 'employee-secret-id', displayName: 'Tom', initials: 'T', phone: '13800000000' },
      { id: 'employee-duplicate-id', displayName: 'Tom', initials: 'T2' },
      { id: 'employee-jerry', displayName: 'Jerry', initials: 'J' },
      { id: 'employee-tyke', displayName: 'Tyke', initials: 'T' },
      { id: 'employee-zhang', displayName: '张三', initials: 'ZS' },
    ],
    areas: [
      { id: 'area-vip', name: '贵宾卡座区', shortName: '卡座' },
    ],
    tables: [
      { id: 'table-private-id', code: 'A-01', displayName: 'A01桌' },
      { id: 'table-k2', code: 'K2', displayName: '互动02' },
      { id: 'table-l01', code: 'L01', displayName: '休闲01' },
    ],
    products: [
      {
        id: 'product-private-id',
        sku: 'DRINK-001',
        name: '青柠苏打',
        specification: '330毫升',
        categoryName: '酒水',
        tags: ['无酒精'],
        description: '供应商底价属于敏感备注',
      },
    ],
    songState: {
      singers: [
        { id: 'singer-private-id', displayName: 'Jerry', actorId: 'actor-private-id' },
      ],
      songs: [
        { id: 'song-private-id', title: '海阔天空', artist: 'Beyond' },
      ],
      requests: [
        { customerNote: '顾客点歌敏感备注' },
      ],
    },
    config: {
      roles: [
        { id: 'role-private-id', name: '值班经理' },
      ],
      serviceTypes: [
        { id: 'service-private-id', code: 'water', name: '送水', customerReply: '内部回复' },
      ],
      workstations: [
        { id: 'station-private-id', name: '水吧工作站' },
      ],
      assistantCapabilities: [
        { id: 'table.open', enabled: true, aliases: ['安排客人入座'] },
      ],
    },
    draftConfig: {
      roles: [
        { id: 'role-draft-id', name: '值班经理' },
        { id: 'role-host-id', name: '接待' },
      ],
      serviceTypes: [
        { id: 'service-draft-id', code: 'water', name: '送水' },
      ],
      workstations: [
        { id: 'station-draft-id', name: '水吧工作站' },
      ],
    },
    waitlistEntries: [
      { customerName: '隐私客人', contactReference: 'wx-sensitive-contact' },
    ],
    tasks: [
      { note: '服务任务敏感备注' },
    ],
    auditEntries: [
      { details: { token: 'audit-secret-token' } },
    ],
  } as unknown as BootstrapResponse
}

function controlsFixture(): VoicePageControl[] {
  return [
    {
      id: 'assignee-control-id',
      kind: 'select',
      label: '选择负责人',
      context: '服务任务',
      displayName: '服务任务 · 选择负责人',
      zone: 'page',
      disabled: false,
      generatedLabel: false,
      sensitive: false,
      risk: 'normal',
      value: 'assignee-secret-value',
      options: [
        { label: '张三', value: 'employee-secret-id', disabled: false },
        { label: '值班经理', value: 'role-private-id', disabled: false },
      ],
    },
    {
      id: 'pin-control-id',
      kind: 'input',
      label: '经理口令',
      context: '授权',
      displayName: '授权 · 经理口令',
      zone: 'page',
      disabled: false,
      generatedLabel: false,
      sensitive: true,
      risk: 'high',
      value: 'PIN-8899',
    },
  ]
}

function dictionary() {
  return buildVoiceCommandDictionary(bootstrapFixture(), controlsFixture())
}

function findEntry(
  entries: readonly VoiceCommandDictionaryEntry[],
  category: VoiceCommandDictionaryEntry['category'],
  canonical: string,
) {
  const entry = entries.find((item) => item.category === category && item.canonical === canonical)
  expect(entry, `${category}:${canonical} should be in the dictionary`).toBeDefined()
  return entry!
}

describe('buildVoiceCommandDictionary', () => {
  it('collects every requested business category from explicit safe fields', () => {
    const entries = dictionary()

    expect(new Set(entries.map((entry) => entry.category))).toEqual(new Set([
      'command',
      'employee',
      'role',
      'table',
      'area',
      'singer',
      'song',
      'product',
      'service',
      'workstation',
      'control',
      'option',
    ]))
    expect(findEntry(entries, 'employee', 'Tom').boost).toBeGreaterThan(0)
    expect(findEntry(entries, 'role', '接待')).toBeDefined()
    expect(findEntry(entries, 'table', 'A01')).toBeDefined()
    expect(findEntry(entries, 'area', '贵宾卡座区').aliases).toContain('卡座')
    expect(findEntry(entries, 'singer', 'Jerry')).toBeDefined()
    expect(findEntry(entries, 'song', '海阔天空').aliases).toContain('Beyond海阔天空')
    expect(findEntry(entries, 'product', '青柠苏打').aliases).toEqual(expect.arrayContaining([
      'DRINK-001',
      '青柠苏打330毫升',
      '酒水青柠苏打',
      '青柠苏打无酒精',
    ]))
    expect(findEntry(entries, 'product', '酒水')).toBeDefined()
    expect(findEntry(entries, 'service', '送水').aliases).toContain('water')
    expect(findEntry(entries, 'workstation', '水吧工作站')).toBeDefined()
    expect(findEntry(entries, 'control', '服务任务 · 选择负责人').aliases).toContain('选择负责人')
    expect(findEntry(entries, 'option', '张三').aliases).toContain('选择负责人张三')
    expect(findEntry(entries, 'command', '开台')).toBeDefined()
    expect(findEntry(entries, 'command', '安排客人入座')).toBeDefined()
  })

  it('adds pinyin, initials, English-name readings, and table speech variants', () => {
    const entries = dictionary()
    const zhang = findEntry(entries, 'employee', '张三')
    const tom = findEntry(entries, 'employee', 'Tom')
    const jerry = findEntry(entries, 'employee', 'Jerry')
    const tyke = findEntry(entries, 'employee', 'Tyke')
    const table = findEntry(entries, 'table', 'A01')

    expect(zhang.pinyin).toBe('zhang san')
    expect(zhang.initials).toBe('zs')
    expect(tom.aliases).toEqual(expect.arrayContaining(['汤姆', '托姆']))
    expect(jerry.aliases).toEqual(expect.arrayContaining(['杰瑞', '杰里']))
    expect(tyke.aliases).toEqual(expect.arrayContaining(['泰克', '太克']))
    expect(table.aliases).toEqual(expect.arrayContaining([
      'A01桌',
      'A1桌',
      'A零一号桌',
      '诶洞幺号桌',
    ]))
  })

  it('deduplicates entities and aliases across runtime and draft config', () => {
    const entries = dictionary()

    expect(entries.filter((entry) => entry.category === 'employee' && entry.canonical === 'Tom')).toHaveLength(1)
    expect(entries.filter((entry) => entry.category === 'role' && entry.canonical === '值班经理')).toHaveLength(1)
    expect(entries.filter((entry) => entry.category === 'service' && entry.canonical === '送水')).toHaveLength(1)
    for (const entry of entries) {
      expect(new Set(entry.aliases.map((alias) => alias.toLocaleLowerCase('zh-CN'))).size).toBe(entry.aliases.length)
    }
  })

  it('never copies sensitive runtime, customer, control, or option values', () => {
    const serialized = JSON.stringify(dictionary())

    for (const secret of [
      '13800000000',
      '供应商底价属于敏感备注',
      '顾客点歌敏感备注',
      '隐私客人',
      'wx-sensitive-contact',
      '服务任务敏感备注',
      'audit-secret-token',
      'assignee-secret-value',
      'PIN-8899',
      'employee-secret-id',
      'role-private-id',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(findEntry(dictionary(), 'control', '授权 · 经理口令')).toBeDefined()
  })
})

describe('canonicalizeVoiceCommand', () => {
  it('canonicalizes Chinese name readings, table speech, and Chinese homophones', () => {
    expect(canonicalizeVoiceCommand(
      '请让汤姆去诶洞幺号桌，服务类型选宋水',
      dictionary(),
    )).toBe('请让Tom去A01,服务类型选送水')
  })

  it('accepts full pinyin and bounded pinyin initials', () => {
    const entries = dictionary()

    expect(canonicalizeVoiceCommand('请找tangmu去A1桌', entries)).toBe('请找Tom去A01')
    expect(canonicalizeVoiceCommand('请去A01号桌处理', entries)).toBe('请去A01处理')
    expect(canonicalizeVoiceCommand('请找zs处理', entries)).toBe('请找张三处理')
    expect(canonicalizeVoiceCommand('zscore保持原样', entries)).toBe('zscore保持原样')
  })

  it('corrects the speech recognizer letter O to zero inside configured table codes', () => {
    expect(canonicalizeVoiceCommand('AO1开台', dictionary())).toBe('A01开台')
  })

  it('does not rewrite an exact dictionary phrase merely because it is homophonic', () => {
    const entries: VoiceCommandDictionaryEntry[] = [
      { canonical: '送水', category: 'service', aliases: [], pinyin: 'song shui', initials: 'ss', boost: 9 },
      { canonical: '宋水', category: 'employee', aliases: [], pinyin: 'song shui', initials: 'ss', boost: 8 },
    ]

    expect(canonicalizeVoiceCommand('请找宋水', entries)).toBe('请找宋水')
  })

  it('applies aliases once without recursively rewriting the replacement output', () => {
    const entries: VoiceCommandDictionaryEntry[] = [
      { canonical: 'L04', category: 'table', aliases: ['休闲04'], pinyin: 'l04', initials: 'l', boost: 9 },
      { canonical: '大厅休闲区', category: 'area', aliases: ['休闲'], pinyin: 'da ting xiu xian qu', initials: 'dtxxq', boost: 7 },
    ]

    expect(canonicalizeVoiceCommand('休闲04四位客人开台', entries)).toBe('L04四位客人开台')
    expect(canonicalizeVoiceCommand('大厅休闲区04四位客人开台', entries)).toBe('大厅休闲区04四位客人开台')
  })
})

describe('chooseBestVoiceTranscript', () => {
  it('combines confidence with dictionary support and returns canonical text', () => {
    expect(chooseBestVoiceTranscript([
      { transcript: '打开陌生页面', confidence: 0.92 },
      { transcript: '请找汤姆', confidence: 0.68 },
      { transcript: '请找唐木', confidence: 0.62 },
    ], dictionary())).toBe('请找Tom')
  })

  it('uses confidence to break equivalent dictionary matches and accepts array-like results', () => {
    const alternatives: ArrayLike<{ transcript: string; confidence: number }> = {
      0: { transcript: '请找汤姆', confidence: 0.51 },
      1: { transcript: '请找托姆', confidence: 0.84 },
      length: 2,
    }

    expect(chooseBestVoiceTranscript(alternatives, dictionary())).toBe('请找Tom')
    expect(chooseBestVoiceTranscript([], dictionary())).toBe('')
  })

  it('does not create an executable plan from unsupported low-confidence speech', () => {
    expect(chooseBestVoiceTranscriptSelection([
      { transcript: '帮我处理那个事情', confidence: 0.31 },
    ], dictionary())).toMatchObject({
      canonicalized: '帮我处理那个事情',
      safeToPlan: false,
    })
  })

  it('allows a low-confidence exact hotword to continue to the normal confirmation flow', () => {
    expect(chooseBestVoiceTranscriptSelection([
      { transcript: '汤姆', confidence: 0.18 },
    ], dictionary())).toMatchObject({
      canonicalized: 'Tom',
      safeToPlan: true,
    })
  })

  it('returns distinct ranked candidates so noisy table codes can be selected instead of guessed', () => {
    const candidates = rankVoiceTranscriptSelections([
      { transcript: 'A01开台', confidence: 0.72 },
      { transcript: 'AO1开台', confidence: 0.69 },
      { transcript: 'A1开台', confidence: 0.67 },
      { transcript: '打开陌生页面', confidence: 0.9 },
    ], dictionary())

    expect(candidates.map((candidate) => candidate.canonicalized)).toEqual([
      'A01开台',
      '打开陌生页面',
    ])
  })

  it('reranks real noisy-bar hypotheses toward configured tables, employees, and service language', () => {
    expect(chooseBestVoiceTranscript([
      {
        transcript: '五分钟后让汤姆给开二中加水再给艾勒零一桌开台四个人',
        confidence: 0.93794143,
      },
      {
        transcript: '五分钟后让汤姆给开儿桌加水再给艾勒零一桌开台四个人',
        confidence: 0.9300453,
      },
      {
        transcript: '五分钟后让汤姆给开儿捉加水再给艾勒零一桌开台四个人',
        confidence: 0.9213101,
      },
    ], dictionary())).toBe('五分钟后让Tom给K2加水再给L01开台四个人')
  })
})

describe('dictionaryBiasPhrases', () => {
  it('prioritizes spoken store entities and omits technical pinyin/initial tokens', () => {
    const phrases = dictionaryBiasPhrases(dictionary())

    expect(phrases).toEqual(expect.arrayContaining(['张三', '汤姆']))
    expect(phrases.some((phrase) => /诶.*[洞幺].*桌/u.test(phrase))).toBe(true)
    expect(phrases).not.toEqual(expect.arrayContaining(['zhang san', 'zs']))
    expect(phrases.indexOf('A01')).toBeLessThan(phrases.indexOf('青柠苏打'))
    expect(new Set(phrases.map((phrase) => phrase.toLocaleLowerCase('zh-CN'))).size).toBe(phrases.length)
    expect(phrases).not.toContain('PIN-8899')
    expect(dictionaryBiasPhrases(dictionary(), 5)).toHaveLength(5)
    expect(dictionaryBiasPhrases(dictionary(), 0)).toEqual([])
  })

  it('includes configured menu metadata and common operating language in the model hints', () => {
    const phrases = dictionaryBiasPhrases(dictionary(), 5_000)

    expect(phrases).toEqual(expect.arrayContaining([
      'A01',
      'Tom',
      '送水',
      '青柠苏打',
      'DRINK-001',
      '青柠苏打330毫升',
      '酒水',
      '海阔天空',
      '开台',
      '退款申请',
      '五分钟后',
      '安排客人入座',
    ]))
  })

  it('keeps the encoded hint list within the request payload budget', () => {
    const phrases = dictionaryBiasPhrases(dictionary(), 5_000, 120)

    expect(new TextEncoder().encode(JSON.stringify(phrases)).byteLength).toBeLessThanOrEqual(120)
    expect(phrases.length).toBeGreaterThan(0)
  })
})
