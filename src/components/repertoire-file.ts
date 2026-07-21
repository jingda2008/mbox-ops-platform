import type { RepertoireWriteInput } from '../shared/song-contracts'

export interface RepertoireImportPreview {
  rows: RepertoireWriteInput[]
  errors: string[]
}

const MAX_IMPORT_ROWS = 2000
const MAX_FILE_BYTES = 5 * 1024 * 1024

const headerAliases = {
  title: ['歌曲名称', '歌名', '歌曲', 'title', 'song'],
  artist: ['原唱', '原唱歌手', 'artist'],
  durationSeconds: ['时长秒', '时长(秒)', '时长', 'durationseconds', 'duration'],
  priceYuan: ['价格元', '点歌价格', '价格', 'priceyuan', 'price'],
  enabled: ['是否启用', '可点状态', '状态', 'enabled'],
} as const

function normalizedHeader(value: unknown) {
  return String(value ?? '').trim().replace(/[\s_（）]/g, '').replace(/[()]/g, '').toLocaleLowerCase('zh-CN')
}

function findColumn(headers: unknown[], aliases: readonly string[]) {
  const normalizedAliases = new Set(aliases.map(normalizedHeader))
  return headers.findIndex((header) => normalizedAliases.has(normalizedHeader(header)))
}

function stringCell(value: unknown) {
  return String(value ?? '').trim()
}

function numberCell(value: unknown) {
  if (typeof value === 'number') return value
  const normalized = stringCell(value).replace(/[¥￥,，]/g, '')
  return normalized ? Number(normalized) : Number.NaN
}

function enabledCell(value: unknown) {
  const normalized = stringCell(value).toLocaleLowerCase('zh-CN')
  if (!normalized) return true
  if (['是', '启用', '可点', '上架', 'true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['否', '停用', '不可点', '下架', 'false', '0', 'no', 'n'].includes(normalized)) return false
  return null
}

function repertoireKey(title: string, artist: string) {
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
  return `${normalize(title)}\u0000${normalize(artist)}`
}

export function mapRepertoireRows(values: unknown[][]): RepertoireImportPreview {
  if (values.length === 0) return { rows: [], errors: ['文件里没有可读取的数据'] }
  const headers = values[0] ?? []
  const columns = {
    title: findColumn(headers, headerAliases.title),
    artist: findColumn(headers, headerAliases.artist),
    durationSeconds: findColumn(headers, headerAliases.durationSeconds),
    priceYuan: findColumn(headers, headerAliases.priceYuan),
    enabled: findColumn(headers, headerAliases.enabled),
  }
  const missing = [columns.title < 0 ? '歌曲名称' : '', columns.artist < 0 ? '原唱' : ''].filter(Boolean)
  if (missing.length > 0) return { rows: [], errors: [`缺少必填列：${missing.join('、')}`] }

  const rows: RepertoireWriteInput[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (let index = 1; index < values.length; index += 1) {
    const source = values[index] ?? []
    if (source.every((value) => stringCell(value) === '')) continue
    const line = index + 1
    const title = stringCell(source[columns.title])
    const artist = stringCell(source[columns.artist])
    const durationSeconds = columns.durationSeconds < 0 || stringCell(source[columns.durationSeconds]) === ''
      ? 240
      : numberCell(source[columns.durationSeconds])
    const priceYuan = columns.priceYuan < 0 || stringCell(source[columns.priceYuan]) === ''
      ? 98
      : numberCell(source[columns.priceYuan])
    const enabled = columns.enabled < 0 ? true : enabledCell(source[columns.enabled])

    const lineErrors: string[] = []
    if (!title) lineErrors.push('歌曲名称为空')
    if (!artist) lineErrors.push('原唱为空')
    if (title.length > 120) lineErrors.push('歌曲名称超过120字')
    if (artist.length > 120) lineErrors.push('原唱超过120字')
    if (!Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 1800) lineErrors.push('时长须为30至1800秒整数')
    if (!Number.isFinite(priceYuan) || priceYuan <= 0 || priceYuan > 100_000) lineErrors.push('价格须为0至100000元之间的正数')
    if (enabled === null) lineErrors.push('是否启用只能填写是/否、启用/停用或1/0')
    const key = repertoireKey(title, artist)
    if (seen.has(key)) lineErrors.push('歌曲名称和原唱在文件内重复')
    seen.add(key)
    if (lineErrors.length > 0) {
      errors.push(`第${line}行：${lineErrors.join('；')}`)
      continue
    }
    rows.push({
      title,
      artist,
      durationSeconds,
      priceAmount: Math.round(priceYuan * 100),
      currency: 'CNY',
      enabled: enabled ?? true,
    })
  }

  if (rows.length > MAX_IMPORT_ROWS) errors.unshift(`一次最多导入${MAX_IMPORT_ROWS}首，当前读取到${rows.length}首`)
  if (rows.length === 0 && errors.length === 0) errors.push('文件里没有可导入的歌曲')
  return { rows, errors }
}

export async function parseRepertoireFile(file: File): Promise<RepertoireImportPreview> {
  if (file.size > MAX_FILE_BYTES) throw new Error('文件不能超过5MB')
  const extension = file.name.split('.').pop()?.toLocaleLowerCase() ?? ''
  let values: unknown[][]
  if (extension === 'xlsx') {
    const { readSheet } = await import('read-excel-file/browser')
    values = await readSheet(file)
  } else if (extension === 'csv') {
    const Papa = (await import('papaparse')).default
    values = await new Promise<unknown[][]>((resolve, reject) => {
      Papa.parse<unknown[]>(file, {
        skipEmptyLines: 'greedy',
        complete: (result) => result.errors.length > 0
          ? reject(new Error(`CSV第${(result.errors[0]?.row ?? 0) + 1}行格式错误`))
          : resolve(result.data),
        error: (error) => reject(error),
      })
    })
  } else {
    throw new Error('请选择 .xlsx 或 .csv 文件')
  }
  return mapRepertoireRows(values)
}

export function downloadRepertoireTemplate() {
  const content = '\uFEFF歌曲名称,原唱,时长秒,价格元,是否启用\n后来,刘若英,240,98,是\n海阔天空,Beyond,300,128,是\n'
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'MBOX歌手歌单导入模板.csv'
  anchor.click()
  URL.revokeObjectURL(url)
}
