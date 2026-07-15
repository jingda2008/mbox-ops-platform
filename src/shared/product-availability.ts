import type { MenuProduct } from './contracts.js'

export type ProductAvailabilityState = 'available' | 'sold_out' | 'scheduled' | 'hidden'

export interface ProductAvailability {
  state: ProductAvailabilityState
  orderable: boolean
  label: string
}

function timeMinutes(value: string) {
  const [hours, minutes] = value.split(':').map(Number)
  return hours! * 60 + minutes!
}

function localMinutes(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hours = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minutes = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return hours * 60 + minutes
}

export function productAvailability(
  product: MenuProduct,
  now = new Date(),
  timeZone = 'Asia/Shanghai',
): ProductAvailability {
  if (!product.enabled) return { state: 'hidden', orderable: false, label: '已下架' }
  if (product.soldOut) {
    return { state: 'sold_out', orderable: false, label: product.soldOutReason?.trim() || '暂时售罄' }
  }
  if (product.availableFrom && product.availableUntil) {
    const current = localMinutes(now, timeZone)
    const start = timeMinutes(product.availableFrom)
    const end = timeMinutes(product.availableUntil)
    const withinWindow = start < end
      ? current >= start && current < end
      : current >= start || current < end
    if (!withinWindow) {
      return {
        state: 'scheduled',
        orderable: false,
        label: `供应时间 ${product.availableFrom}-${product.availableUntil}`,
      }
    }
  }
  return { state: 'available', orderable: true, label: '在售' }
}
