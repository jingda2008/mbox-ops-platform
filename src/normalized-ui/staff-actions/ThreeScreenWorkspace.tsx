import {useCallback,useMemo,useState} from 'react'
import {KitchenProductionBoard} from './KitchenProductionBoard'
import {PickupBoard} from './PickupBoard'
import {StaffActionsApi} from './staff-actions-api'
import './three-screen-workspace.css'

import type {ThreeScreenMode} from './three-screen-route'

/** Authenticated dedicated tablet shell. The server still authorizes every read and command. */
export function ThreeScreenWorkspace({mode,employeeId,staffSessionId,onExit,onLoginRequired}:{
  mode:ThreeScreenMode;employeeId:string;staffSessionId:string;onExit:()=>void;onLoginRequired:()=>void
}) {
  const api=useMemo(()=>new StaffActionsApi({staffSessionId}),[staffSessionId])
  const [legacy,setLegacy]=useState<string[]>([])
  const changed=useCallback(async()=>{window.dispatchEvent(new Event('mbox:production-changed'))},[])
  if(mode==='pickup')return <PickupBoard staffSessionId={staffSessionId} onExit={onExit} onLoginRequired={onLoginRequired}/>
  return <section className="three-screen-production" aria-label={mode==='bar'?'酒水制作屏':'后厨制作屏'}>
    <header className="three-screen-toolbar"><button type="button" onClick={onExit}>返回出品</button><strong>{mode==='bar'?'酒水制作':'后厨制作'}</strong>
      {legacy.length>0&&<button type="button" onClick={onExit}>其他待办 {legacy.length}</button>}
    </header>
    <KitchenProductionBoard key={`${staffSessionId}:${mode}`} api={api} employeeId={employeeId} stationCode={mode}
      blocked={false} onChanged={changed} onLegacy={setLegacy} onLoginRequired={onLoginRequired}/>
  </section>
}
