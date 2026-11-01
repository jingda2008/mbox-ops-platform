import {createRoot} from 'react-dom/client'
import {ParticipantMovementSheet} from '../../../src/normalized-ui/staff-actions/ParticipantMovementSheet'
import type {StaffActionsApiPort} from '../../../src/normalized-ui/staff-actions/staff-actions-api'
import type {StaffActionTable,StaffTableParticipant} from '../../../src/normalized-ui/staff-actions/types'
import '../../../src/normalized-ui/staff-actions/staff-actions-panel.css'

type Movement=Parameters<StaffActionsApiPort['previewParticipantMovement']>[0]
declare global {interface Window {mergeHarness:{previews:Movement[];moves:Movement[];blocked:boolean}}}
window.mergeHarness={previews:[],moves:[],blocked:false}
const table=(code:string,count:number):StaffActionTable=>({id:code,code,displayName:code,areaId:'area',areaName:'测试区',capacity:3,status:'available',assignedToActor:true,activeSession:{id:`session-${code}`,guestCount:count,capacityAtOpen:3,guestCartWritesFrozen:false,status:'open',openedAt:'2026-11-02T00:00:00Z',latestMood:null,financialState:'paid',orderCount:0,unpaidOrderCount:0,pendingPaymentCount:0,refundAttentionCount:0,refundedAmountMinor:0,netCollectedAmountMinor:0}})
const source=table('SRC',2),target=table('DST',1)
const participants:StaffTableParticipant[]=Array.from({length:3},(_,i)=>({publicId:`person-${i}`,customerPublicId:`customer-${i}`,role:'companion',confirmationState:'confirmed',identityLevel:'identified',seatLabel:null,locationStartedAt:'2026-11-02T00:00:00Z'}))
const api={loadTableParticipants:async()=>participants,previewParticipantMovement:async(input:Movement)=>{
  window.mergeHarness.previews.push(input)
  return {...input,selectedParticipantCount:input.participantPublicIds.length,targetCapacity:3,projectedGuestCount:1+input.movedGuestCount,requiresCapacityOverride:false,roleAdjustments:[],blockers:window.mergeHarness.blocked?[{code:'ORDER_UNSETTLED',count:1,label:'仍有未结订单',resolution:'请先结清'}]:[],finalRevalidationRequired:true,accountingBoundary:'历史订单与支付不迁移'}
},moveParticipants:async(input:Movement)=>{window.mergeHarness.moves.push(input)}} as unknown as StaffActionsApiPort
createRoot(document.getElementById('root')!).render(<ParticipantMovementSheet api={api} table={source} allTables={[source,target]} onClose={()=>{}} onDone={message=>{document.getElementById('result')!.textContent=message}}/>)
