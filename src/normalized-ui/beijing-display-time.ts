import {parseInstant} from '../shared/instant-time'

export function beijingDisplayTime(value: unknown): string {
  const instant=parseInstant(value)
  if(!Number.isFinite(instant))return '时间待核对'
  const shifted=new Date(instant+28_800_000)
  return Number.isFinite(shifted.getTime())?shifted.toISOString().slice(0,16).replace('T',' '):'时间待核对'
}
