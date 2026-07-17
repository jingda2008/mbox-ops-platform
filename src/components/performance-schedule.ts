export function moveLocalDatetimeToBusinessDate(value: string, previousBusinessDate: string, nextBusinessDate: string) {
  if (!value || !previousBusinessDate || !nextBusinessDate) return value
  const currentDate = value.slice(0, 10)
  const dayOffset = dateOrdinal(currentDate) - dateOrdinal(previousBusinessDate)
  return `${dateFromOrdinal(dateOrdinal(nextBusinessDate) + dayOffset)}${value.slice(10)}`
}

function dateOrdinal(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return Math.floor(Date.UTC(year!, month! - 1, day!) / 86_400_000)
}

function dateFromOrdinal(value: number) {
  return new Date(value * 86_400_000).toISOString().slice(0, 10)
}
