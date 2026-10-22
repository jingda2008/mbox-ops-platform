import type {ActivityProductionCommand,ActivityProductionResult} from '../../shared/activity-service'
import type {ActivityProductionBoard} from '../../shared/activity-production-recovery'
import {DurableStaffCommand} from '../durable-staff-command'
import type {StaffActionsApiPort} from './staff-actions-api'
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>
type Origin={staffSessionId:string;commandScope:string}

/** Only a server-derived same-employee/device namespace can discover an old login. */
export function activityProductionJournal(api:StaffActionsApiPort,station:'bar'|'kitchen'|'pickup',fallback:string,board:ActivityProductionBoard|null,storage?:StoragePort) {
  const pointer=station==='pickup'&&board?.recoveryNamespace?`mbox.activity-pickup-origin.v1:${board.recoveryNamespace}`:null
  let origin:Origin|null=null
  if(pointer){
    if(!storage)throw new Error('设备无法保留原取餐记录，请恢复存储后继续')
    const raw=storage.getItem(pointer)
    if(raw){try{const value=JSON.parse(raw) as Origin;if(typeof value.staffSessionId!=='string'||!/^[0-9a-f-]{36}$/i.test(value.staffSessionId)||typeof value.commandScope!=='string'||!/^[a-f0-9]{64}$/.test(value.commandScope))throw new Error();origin=value}catch{throw new Error('原取餐登录记录损坏，请交由领班核对，不要重新取餐')}}
  }
  const create=(old:Origin|null)=>new DurableStaffCommand<ActivityProductionCommand,ActivityProductionResult>(
    `activity-production:${station}:${old?.commandScope??board?.commandScope??fallback}`,
    (body,key)=>old&&old.commandScope!==board?.commandScope
      ?api.recoverActivityProduction!({...old,idempotencyKey:key,command:body})
      :api.runActivityProduction!(body,key),storage,true)
  let journal=create(origin)
  // A crash after successful readback may leave the pointer after its journal was cleared.
  if(pointer&&origin&&!journal.pending()){storage!.removeItem(pointer);origin=null;journal=create(null)}
  const selectedOrigin=origin
  return {journal,previousLogin:!!origin&&origin.commandScope!==board?.commandScope,
    remember(){
      if(!pointer)return
      const value=selectedOrigin??{staffSessionId:board?.staffSessionId,commandScope:board?.commandScope}
      if(!value.staffSessionId||!value.commandScope)throw new Error('请重新读取当前取餐岗位后再操作')
      const raw=JSON.stringify(value);storage!.setItem(pointer,raw)
      if(storage!.getItem(pointer)!==raw)throw new Error('原取餐登录记录未能保存，请恢复存储后继续')
    },
    acknowledge(){if(pointer&& !journal.pending())storage!.removeItem(pointer)},
  }
}
