import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import {StaffScanPanel} from '../../../src/normalized-ui/staff-actions/StaffScanPanel'
import type {ActivityServiceView} from '../../../src/shared/activity-service'
const initial:ActivityServiceView={registrationPublicId:'b06-registration',activityTitle:'体验核对活动',packageName:'固定套餐',hasMeal:true,partySize:2,maxParticipants:5,reservedSeats:5,admittedCount:0,remainingAdmission:5,includesAdmission:true,paymentStatus:'paid',meal:null}
const calls:unknown[]=[]
const state={mode:'verify',returned:false}
let render=()=>{}
const api={postEndpoint:async(url:string,body:unknown,options:unknown)=>{
 if(url.endsWith('/scan'))return {...initial,...(state.returned?{admittedCount:5,remainingAdmission:0,meal:{id:'meal',number:18,status:'open',plaqueState:'returned',location:'A区',lines:[]}}:{})}
 calls.push({url,body,options});return initial
}}
Object.assign(window,{b06:{calls,set:(value:Partial<typeof state>)=>{Object.assign(state,value);render()}}})
function App(){const [,tick]=useState(0);render=()=>tick(n=>n+1);const permissions=state.mode==='verify'?['community.activity.verify']:[];return <StaffScanPanel key={state.mode+String(state.returned)} api={api as never} auth={{session:{id:'session-b06'},employee:{id:'employee-b06'},permissions} as never}/>}
createRoot(document.getElementById('root')!).render(<App/> )
