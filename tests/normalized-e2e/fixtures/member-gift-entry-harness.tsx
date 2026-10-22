import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {MemberParticipationCard} from '../../../src/normalized-ui/staff-actions/MemberParticipationCard'
import {MemberGiftRedemptionPanel} from '../../../src/normalized-ui/staff-actions/MemberGiftRedemptionPanel'
import type {MemberGiftCommand,MemberGiftWallet} from '../../../src/shared/member-gift-redemption'
const wallet=(owner:string):MemberGiftWallet=>({employeeId:`employee-${owner}`,customerId:`customer-${owner}`,memberNo:owner,permissions:['loyalty.redemption.fulfill','benefit.cancel'],tables:[{id:'table-'+owner,code:'桌'+owner}],nextCursor:null,items:[{id:'gift-'+owner,title:owner+'原券',type:'gift_product',state:'reserved',quantityAvailable:0,version:1,snackClaim:false,pricePromise:null,products:[{id:'bundle',name:'自选套餐',status:'active',bundleChoiceGroups:[{id:'group',code:'group',name:'任选一款',selectionCount:1,options:[{productId:'cola',code:'cola',name:'可乐',quantity:1,available:true},{productId:'tea',code:'tea',name:'茶',quantity:1,available:true},{productId:'gone',code:'gone',name:'售罄选项',quantity:1,available:false}]}]}],reservations:[{id:'hold-'+owner,tableSessionId:'table-'+owner,quantity:2,tableCode:'桌'+owner,canRedeem:true,expiresAt:'2099-01-01T00:00:00Z'}]}]})
const state={owner:'A',mount:true,parent:false},wallets={A:wallet('A'),B:wallet('B')},calls:Array<{owner:string;command:MemberGiftCommand;key:string}>=[]
let mode='success',resolveLate:(()=>void)|null=null,update=()=>{}
const api=(owner:'A'|'B')=>({lookupMemberParticipation:async()=>({memberNo:owner,displayName:'测试会员',checkedAt:new Date().toISOString(),activitiesVisible:true,activities:[],registrations:[],benefits:[{id:'gift-'+owner,title:owner+'原券',quantity:2,validUntil:null,guidance:'赠品券'}]}),loadMemberGiftWallet:async()=>structuredClone(wallets[owner]),runMemberGiftCommand:async(_employee:string,command:MemberGiftCommand,key:string)=>{
 calls.push({owner,command:structuredClone(command),key})
 if(mode==='lost'){mode='success';throw Error('原回执丢失')}
 if(mode==='not-committed')throw Object.assign(Error('已确认原请求未提交'),{status:409,code:'NATIVE_BUSINESS_NOT_COMMITTED',commitDisposition:'not_committed'})
 if(mode==='late')await new Promise<void>(resolve=>{resolveLate=resolve})
 wallets[owner].items[0]!.reservations=[]
 return {employeeId:'employee-'+owner,customerId:'customer-'+owner,action:command.action,requestKey:key,result:{id:'redemption'}}
}})
const apis={A:api('A'),B:api('B')}
Object.assign(window,{giftHarness:{calls,render:(changes:Partial<typeof state>)=>{Object.assign(state,changes);update()},mode:(value:string)=>{mode=value},resolve:()=>resolveLate?.(),permission:()=>{wallets.A.permissions=[]},single:()=>{wallets.A.items[0]!.products[0]!.bundleChoiceGroups=[]}}})
function App(){const[,tick]=useState(0);update=()=>tick(n=>n+1);return state.mount?(state.parent?<MemberParticipationCard code={state.owner} api={apis[state.owner as 'A'|'B'] as never} onClose={()=>{}}/>:<MemberGiftRedemptionPanel code={state.owner} api={apis[state.owner as 'A'|'B'] as never}/>):null}
createRoot(document.getElementById('root')!).render(<App/> )
