/** Automatic trading-day opening; reservation hours are an independent policy. */
export const BUSINESS_DAY_OPENING_TIME = '11:00:00'

export function businessOperatingHoursLabel(cutoff: string): string {
  return `${BUSINESS_DAY_OPENING_TIME.slice(0, 5)}—次日${cutoff.slice(0, 5)}`
}
