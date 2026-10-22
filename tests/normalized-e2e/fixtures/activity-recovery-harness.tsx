import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ActivityProductionPanel} from '../../../src/normalized-ui/staff-actions/ActivityProductionPanel'
import {ActivityServiceExceptionPanel} from '../../../src/normalized-ui/staff-actions/ActivityServiceExceptionPanel'
import type {ActivityServiceLine,ActivityServiceView,ActivityProductionCommand} from '../../../src/shared/activity-service'
import type {ActivityServiceExceptionCommand} from '../../../src/shared/activity-service-exception'

const line=(owner:string):ActivityServiceLine=>({id:`10000000-0000-4000-8000-${owner==='A'?'000000000001':'000000000002'}`,taskId:'task',registrationPublicId:`reg-${owner}`,mealId:`meal-${owner}`,number:owner==='A'?12:23,location:'A区',productId:'product',name:`${owner}热菜`,station:'kitchen',quantity:5,startedQuantity:3,readyQuantity:2,takenQuantity:0,version:1,status:'active',createdAt:'2026-10-22T10:00:00Z'})
const boards:Record<string,ActivityServiceLine>={A:line('A'),B:line('B')}
const calls:Array<{owner:string;kind:string;key:string;body:unknown}>=[]
const deferred=new Map<string,(result:unknown)=>void>()
let boardGate=false,dropException=false,dropProduction=false
const service=(owner:string):ActivityServiceView=>({registrationPublicId:`reg-${owner}`,activityTitle:'测试活动',partySize:1,maxParticipants:1,reservedSeats:1,admittedCount:1,remainingAdmission:0,includesAdmission:true,paymentStatus:'paid',meal:{id:`meal-${owner}`,number:boards[owner]!.number,status:'open',plaqueState:'issued',location:'A区',lines:[{...boards[owner]!}]}})
const api=(owner:string)=>({
 loadActivityBoard:async()=>{if(boardGate)throw new Error('网络暂时无法读取');return {activityItems:[{...boards[owner]!}],commandScope:(owner==='B'?'c':state.login===1?'a':'b').repeat(64),recoveryNamespace:(owner==='A'?'d':'e').repeat(64),staffSessionId:`20000000-0000-4000-8000-${state.login===1?'000000000001':'000000000002'}`}},
 runActivityProduction:(body:ActivityProductionCommand,key:string)=>{calls.push({owner,kind:'production',body,key});if(dropProduction){dropProduction=false;return Promise.reject(new Error('原取餐回执丢失'))};return new Promise(resolve=>deferred.set(owner,()=>{boards[owner]!.takenQuantity+=body.lines[0]?.quantity??0;boards[owner]!.version++;resolve({receiptId:`receipt-${owner}`,action:body.action,lines:[{...boards[owner]!}]})}))},
 recoverActivityProduction:async(recovery:import('../../../src/shared/activity-production-recovery').ActivityProductionRecovery)=>{calls.push({owner,kind:'recovery',body:recovery.command,key:recovery.idempotencyKey});boards[owner]!.takenQuantity+=recovery.command.lines[0]?.quantity??0;boards[owner]!.version++;return {receiptId:`receipt-${owner}`,action:recovery.command.action,lines:[{...boards[owner]!}]}},
 postEndpoint:async(_url:string,body:ActivityServiceExceptionCommand,options:{idempotencyKey:string})=>{calls.push({owner,kind:'exception',body,key:options.idempotencyKey});if(dropException){dropException=false;boards[owner]!.version++;boards[owner]!.held=body.action==='hold';throw new Error('回执丢失')};return {receiptId:'exception-receipt',action:body.action,lines:[{...boards[owner]!}]}},
})
const apis={A:api('A'),B:api('B')}
let update:()=>void=()=>{}
const state={owner:'A' as 'A'|'B',blocked:false,kind:'production',mount:true,login:1}
Object.assign(window,{activityHarness:{calls,state,render:(changes:Partial<typeof state>)=>{Object.assign(state,changes);update()},gate:(value:boolean)=>{boardGate=value},resolve:(owner:string)=>{deferred.get(owner)?.({});deferred.delete(owner)},dropException:()=>{dropException=true},dropProduction:()=>{dropProduction=true}}})
function App(){const [,setTick]=useState(0);update=()=>setTick(n=>n+1);const [view,setView]=useState(service(state.owner));return <main>
{state.mount&&(state.kind==='production'?<ActivityProductionPanel api={apis[state.owner] as never} station="pickup" scope={`scope-${state.owner}-${state.login}`} active blocked={state.blocked} onCount={()=>{}}/>:<ActivityServiceExceptionPanel key={state.owner} api={apis[state.owner] as never} scope={`employee-${state.owner}`} service={view.registrationPublicId===`reg-${state.owner}`?view:service(state.owner)} disabled={state.blocked} onChanged={async()=>setView(service(state.owner))}/>)}
</main>}
createRoot(document.getElementById('root')!).render(<App/> )
