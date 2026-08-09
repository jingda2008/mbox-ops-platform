import { pathToFileURL } from 'node:url'

const VENUE_TIME_ZONE = 'Asia/Shanghai'
const BUSINESS_DAY_ROLLOVER_HOUR = 6

function venueParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VENUE_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

export function loadReferenceTime(now = new Date()) {
  const parts = venueParts(now)
  let date = `${parts.year}-${parts.month}-${parts.day}`
  if (Number(parts.hour) < BUSINESS_DAY_ROLLOVER_HOUR) {
    const previous = new Date(`${date}T00:00:00Z`)
    previous.setUTCDate(previous.getUTCDate() - 1)
    date = previous.toISOString().slice(0, 10)
  }
  return new Date(`${date}T20:00:00+08:00`).toISOString()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${loadReferenceTime()}\n`)
}
