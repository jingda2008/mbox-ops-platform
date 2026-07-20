import { Clock3 } from 'lucide-react'
import { memo, useMemo } from 'react'
import { chinaDateKey, formatChinaDateTime, formatChinaTime } from '../shared/china-time'
import { serverClockOffset, useSecondClock } from './use-second-clock'

export const BeijingClock = memo(function BeijingClock({ serverNow }: { serverNow: string }) {
  const offsetMs = useMemo(() => serverClockOffset(serverNow), [serverNow])
  const clock = useSecondClock(offsetMs)

  return (
    <div className="beijing-clock" title={formatChinaDateTime(clock)}>
      <Clock3 size={15} />
      <span><span className="beijing-clock-date">{chinaDateKey(clock)} </span>北京时间</span>
      <strong>{formatChinaTime(clock, { second: '2-digit' })}</strong>
    </div>
  )
})
