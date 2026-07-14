import {
  CakeSlice,
  ClipboardList,
  Droplets,
  MessageSquareWarning,
  ReceiptText,
  Snowflake,
  type LucideIcon,
} from 'lucide-react'
import type { ServiceTypeConfig } from '../shared/contracts'

const icons: Record<ServiceTypeConfig['icon'], LucideIcon> = {
  water: Droplets,
  ice: Snowflake,
  order: ClipboardList,
  bill: ReceiptText,
  complaint: MessageSquareWarning,
  birthday: CakeSlice,
}

export function ServiceIcon({ icon, size = 20 }: { icon: ServiceTypeConfig['icon']; size?: number }) {
  const Icon = icons[icon]
  return <Icon aria-hidden="true" size={size} strokeWidth={1.9} />
}
