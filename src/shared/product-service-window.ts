/** One start-date-based daily interval. End minutes above 1440 mean next day. */
export interface ProductServiceWindow {
  dateFrom: string | null
  dateThrough: string | null
  weekdays: number[]
  saleStartMinute: number
  saleEndMinute: number
  visibleStartMinute: number
  visibleEndMinute: number
}

function date(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new TypeError('供应日期无效')
  return value
}

export function parseProductServiceWindow(value: unknown): ProductServiceWindow | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('供应时段格式无效')
  const w = value as Record<string, unknown>
  if (Object.keys(w).some(key => !['dateFrom','dateThrough','weekdays','saleStartMinute','saleEndMinute','visibleStartMinute','visibleEndMinute'].includes(key))) throw new TypeError('供应时段包含未知字段')
  const dateFrom = date(w.dateFrom), dateThrough = date(w.dateThrough)
  if (dateFrom && dateThrough && dateThrough < dateFrom) throw new TypeError('结束日期不能早于开始日期')
  if (!Array.isArray(w.weekdays) || !w.weekdays.length || w.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(w.weekdays).size !== w.weekdays.length) throw new TypeError('请选择不重复的有效星期')
  const minute = (key: string, max: number) => {
    const value = w[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new TypeError('供应时间无效')
    return value
  }
  const saleStartMinute = minute('saleStartMinute',1439), saleEndMinute = minute('saleEndMinute',2879)
  const visibleStartMinute = w.visibleStartMinute === undefined ? saleStartMinute : minute('visibleStartMinute',1439)
  const visibleEndMinute = w.visibleEndMinute === undefined ? saleEndMinute : minute('visibleEndMinute',2879)
  for (const [start,end] of [[saleStartMinute,saleEndMinute],[visibleStartMinute,visibleEndMinute]]) {
    if (end! <= start! || end! > start! + 1440) throw new TypeError('时段结束须晚于开始且不超过一天；全天请选择全天，跨午夜请选择次日结束')
  }
  if (saleStartMinute < visibleStartMinute || saleEndMinute > visibleEndMinute) throw new TypeError('可售时段必须包含在可见时段内')
  return {dateFrom,dateThrough,weekdays:[...w.weekdays].sort((a,b)=>a-b),saleStartMinute,saleEndMinute,visibleStartMinute,visibleEndMinute}
}

// Reuse only locale machinery, never an evaluated time, rule, or eligibility.
// Bound the cache because store timezones are configuration, not a fixed enum.
const dateFormatters = new Map<string, Intl.DateTimeFormat>()
export function serviceWindowDateParts(now: Date, timeZone: string) {
  let formatter = dateFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
    if (dateFormatters.size >= 16) {
      const oldest = dateFormatters.keys().next().value
      if (oldest !== undefined) dateFormatters.delete(oldest)
    }
    dateFormatters.set(timeZone, formatter)
  }
  return formatter.formatToParts(now)
}

/** Null means unchanged legacy scheduling, not a closed product. */
export function serviceWindowState(window: ProductServiceWindow | null | undefined, now = new Date(), timeZone = 'Asia/Shanghai', kind: 'sale'|'visible' = 'sale') {
  if (!window) return {active:true,until:null as string|null}
  const parts = serviceWindowDateParts(now,timeZone)
  const part = (name: string) => Number(parts.find(item=>item.type===name)?.value)
  const current = part('hour')*60+part('minute')+part('second')/60
  const start = kind==='sale'?window.saleStartMinute:window.visibleStartMinute
  const end = kind==='sale'?window.saleEndMinute:window.visibleEndMinute
  let dayMs = Date.UTC(part('year'),part('month')-1,part('day'))
  let minute = current
  if (end>1440 && current<start) { dayMs-=86_400_000; minute+=1440 }
  const day = new Date(dayMs).toISOString().slice(0,10)
  const weekday = new Date(dayMs).getUTCDay() || 7
  const active = minute>=start && minute<end && (!window.dateFrom||day>=window.dateFrom)
    && (!window.dateThrough||day<=window.dateThrough) && window.weekdays.includes(weekday)
  if (!active) return {active:false,until:null}
  // Resolve the local wall-clock end in the store timezone, including DST.
  const desired = dayMs+end*60_000
  let resolved = desired
  for(let i=0;i<3;i++) {
    const p=serviceWindowDateParts(new Date(resolved),timeZone)
    const n=(key:string)=>Number(p.find(item=>item.type===key)?.value)
    const represented=Date.UTC(n('year'),n('month')-1,n('day'),n('hour'),n('minute'),n('second'))
    const diff=desired-represented
    resolved+=diff
    if(!diff)break
  }
  return {active:true,until:new Date(resolved).toISOString()}
}

export const DEFAULT_PRODUCT_SERVICE_WINDOW: ProductServiceWindow = {
  dateFrom:null,dateThrough:null,weekdays:[1,2,3,4,5,6,7],saleStartMinute:0,saleEndMinute:1440,visibleStartMinute:0,visibleEndMinute:1440,
}
