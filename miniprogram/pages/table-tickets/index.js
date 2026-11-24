const api = require('../../utils/api')
const {money,dateTime,beijingDate,parseInstant} = require('../../utils/format')
const {readWechatPhoneAuthorization} = require('../../utils/wechat-phone')
const {randomId} = require('../../utils/id')
const {isPresentableWechatJsapiAction} = require('../../utils/wechat-payment')

const {publicImageUrl} = require('../../utils/media')

function clearMemberDisplay(){
  return {member:null,phone:null,terms:null,mine:[],proposals:[],proposalId:null,reservations:[],eligibleReservations:[],
    reservationLockId:null,originalOrder:null,agreed:false}
}

function ticketAreaText(area, deskCodes){
  const desks=Array.isArray(deskCodes)?deskCodes.join('、'):''
  return [area,desks].filter(Boolean).join(' · ')
}

function sameTicketNotice(current,previous){
  if(!current || !previous)return false
  const fields=['id','areaText','startsAt','endsAt','priceMinor','giftPoints','validThroughIfPaidToday',
    'eventTermsVersion','safetyVersion','safetySummary','refundVersion','refundSchedule','refundSummary','serviceContact']
  return fields.every(field=>current[field]===previous[field])
}

function priceSummary(offer,quantity){
  const count=Number(quantity)
  if (!offer || !Number.isSafeInteger(count) || count<1 || !Number.isSafeInteger(count*offer.priceMinor))return ''
  const points=count*offer.giftPoints
  return count+'桌 · 票款合计 '+money(count*offer.priceMinor)+(points?' · 共赠 '+points+' 积分':'')
}

Page({
  data:{rulesOpen:false,offersOpen:false,failedCover:'',originalOrder:null,reservations:[],eligibleReservations:[],reservationLockId:null,proposals:[],proposalId:null,offers:[],mine:[],selected:null,quantity:'1',agreed:false,member:null,terms:null,phone:null,busy:false,error:''},
  onLoad(query){
    this.visit=0
    this.offerId=query.id||''
    if(typeof query.quantity==='string' && /^[1-9]\d{0,8}$/.test(query.quantity))this.setData({quantity:query.quantity})
  },
  onShareAppMessage(){
    const o=this.data.selected
    return o?{title:o.name+' · '+o.time,path:'/pages/table-tickets/index?id='+encodeURIComponent(o.id)+'&quantity='+encodeURIComponent(this.data.quantity)}:
      {title:'整桌演出门票',path:'/pages/table-tickets/index'}
  },
  onShow(){this.visible=true;return this.refresh()},
  onHide(){
    this.visible=false
    this.visit+=1
    this.readGeneration=(this.readGeneration||0)+1
    this.setData({...clearMemberDisplay(),error:''})
  },
  currentVisit(visit){return this.visible!==false && visit===this.visit},
  onUnload(){this.onHide()},
  chooseAnother(){this.originalReceipt=null;this.setData({reservationLockId:null,summary:priceSummary(this.data.selected,1),originalOrder:null,agreed:false,quantity:'1',proposalId:null})},
  async refresh(){
    if(this.visible===false)return
    const generation=this.readGeneration=(this.readGeneration||0)+1
    try {
      const offers=(await api.getTableTicketOffers()).map(o=>({...o,areaText:ticketAreaText(o.areaName,o.deskCodes),cover:o.coverUrl?publicImageUrl(o.coverUrl):'',saleText:o.saleState==='upcoming'?dateTime(o.saleFrom)+' 开售':o.saleState==='ended'?'已停售':'',price:money(o.priceMinor),time:dateTime(o.startsAt)+' — '+dateTime(o.endsAt)}))
      if(generation!==this.readGeneration)return
      const selected=offers.find(o=>o.id===this.offerId)||null
      this.setData({offers,selected,summary:priceSummary(selected,this.data.quantity),agreed:Boolean(this.data.agreed && sameTicketNotice(selected,this.data.selected))})
      const [bootstrap,orders,proposals,reservations]=await Promise.all([api.getMiniBootstrap(),api.getMyTableTickets(),api.getTicketProposals(),api.getTicketReservations()])
      const phones=bootstrap.membership?await api.getVerifiedPhones():[]
      if(generation!==this.readGeneration)return
      const memberNo=bootstrap.membership?.memberNo
      let ticketOrders=orders
      const pending=this.returnedPayment
      if(pending){
        if(pending.memberNo===memberNo){
          await api.queryActivityRegistrationPayment(pending.id)
          if(generation!==this.readGeneration)return
          ticketOrders=await api.getMyTableTickets()
          if(generation!==this.readGeneration)return
        }
        if(this.returnedPayment===pending)this.returnedPayment=null
      }
      const switched=this.data.member && this.data.member.memberNo!==memberNo
      const eligible=this.forOffer(this.data.selected,reservations)
      const lockId=this.data.reservationLockId
      const lostLock=lockId && !eligible.some(row=>row.id===lockId)
      if(this.originalReceipt && this.originalReceipt.memberNo!==memberNo)this.originalReceipt=null
      this.setData({proposals,reservations,eligibleReservations:eligible,reservationLockId:switched||lostLock?null:lockId,
        proposalId:switched?null:this.data.proposalId,agreed:switched||lostLock?false:this.data.agreed,originalOrder:this.originalReceipt?.id||null,member:bootstrap.membership||null,terms:bootstrap.membershipTerms||null,phone:phones[0]||null,
        mine:(memberNo?ticketOrders:[]).map(o=>({...o,purchasedAreaText:ticketAreaText(o.purchaseTerms?.area,o.purchaseTerms?.deskCodes),tickets:o.tickets.map(t=>({...t,moveTime:t.move?dateTime(t.move.startsAt)+' — '+dateTime(t.move.endsAt):'',effectiveTime:t.currentShow?dateTime(t.currentShow.startsAt)+' — '+dateTime(t.currentShow.endsAt):'',validThrough:beijingDate(parseInstant(t.expiresAt)-1000)})),total:money(Number(o.totalMinor)),time:dateTime(o.startsAt)}))})
    } catch(e){if(generation===this.readGeneration)this.setData({...clearMemberDisplay(),error:e.message||'读取失败，请刷新'})}
  },
  forOffer(offer,rows){
    return offer?rows.filter(r=>r.areaId===offer.areaId&&parseInstant(r.startsAt)<=parseInstant(offer.startsAt)&&parseInstant(r.endsAt)>=parseInstant(offer.endsAt)):[]
  },
  chooseReservation(e){if(!this.data.busy)this.setData({reservationLockId:e.detail.value||null,agreed:false})},
  openProposal(event){
    const p=this.data.proposals.find(v=>v.id===event.currentTarget.dataset.id)
    const item=p&&this.data.offers.find(v=>v.id===p.offerId)
    if(!item){this.setData({error:'票档已变更，请服务员重新选票'});return}
    if(this.data.busy)return
    this.originalReceipt=null
    this.offerId=item.id;this.setData({originalOrder:null,rulesOpen:false,offersOpen:false,selected:item,summary:priceSummary(item,p.quantity),reservationLockId:null,eligibleReservations:this.forOffer(item,this.data.reservations),quantity:String(p.quantity),proposalId:p.id,agreed:false,error:''})
  },
  select(event){
    if(this.data.busy)return
    this.originalReceipt=null
    this.offerId=event.currentTarget.dataset.id
    const selected=this.data.offers.find(o=>o.id===this.offerId)
    this.setData({originalOrder:null,rulesOpen:false,offersOpen:false,proposalId:null,reservationLockId:null,eligibleReservations:this.forOffer(selected,this.data.reservations),selected,summary:priceSummary(selected,1),quantity:'1',agreed:false,error:''},()=>wx.pageScrollTo({scrollTop:0,duration:180}))
  },
  toggleRules(){this.setData({rulesOpen:!this.data.rulesOpen})},
  toggleOffers(){this.setData({offersOpen:!this.data.offersOpen})},
  coverFailed(event){this.setData({failedCover:event.currentTarget.dataset.src})},
  stepQuantity(event){
    const {selected,quantity,busy,proposalId,reservationLockId}=this.data
    if(!selected || busy || proposalId)return
    const next=Number(quantity)+Number(event.currentTarget.dataset.delta)
    if(!Number.isSafeInteger(next) || next<1 || next>selected.remaining+(reservationLockId?1:0))return
    this.setData({quantity:String(next),summary:priceSummary(selected,next)})
  },
  quantity(event){this.setData({quantity:event.detail.value,summary:priceSummary(this.data.selected,event.detail.value)})},
  agree(event){this.setData({agreed:event.detail.value.includes('yes')})},
  async authorize(event){
    if(this.data.busy)return
    const auth=readWechatPhoneAuthorization(event)
    if(!auth.code){this.setData({error:auth.message});return}
    this.setData({busy:true,error:''})
    const visit=this.visit
    try{
      if(!this.data.member && !this.data.terms)await this.refresh()
      if(!this.currentVisit(visit))return
      if(!this.data.member && !this.data.terms){this.setData({error:'请刷新会员协议后重试'});return}
      if(this.data.member)await api.replaceVerifiedPhone(auth.code)
      else await api.enrollMembership(this.data.terms.version,'mini_community',auth.code)
      await this.refresh()
    }catch(e){this.setData({error:e.message})}finally{this.setData({busy:false})}
  },
  async buy(){
    const {selected:o,quantity,agreed,member,phone}=this.data
    if(this.data.busy||this.data.originalOrder||!o||(o.saleState && o.saleState!=='open')||!agreed||!member||!phone)return
    if(!/^[1-9]\d*$/.test(quantity)||Number(quantity)>o.remaining+(this.data.reservationLockId?1:0)){this.setData({error:'请核对本场可售桌数'});return}
    this.setData({busy:true,error:''})
    const visit=this.visit
    try {
      const order=await api.buyTableTickets({offerId:o.id,...(this.data.reservationLockId?{reservationLockId:this.data.reservationLockId}:{}),...(this.data.proposalId?{proposalId:this.data.proposalId}:{}),quantity:Number(quantity),refundVersion:o.refundVersion,
        safetyVersion:o.safetyVersion,termsAcknowledged:true},randomId('table-ticket'))
      if(!this.data.member || this.data.member.memberNo===member.memberNo){
        this.originalReceipt={memberNo:member.memberNo,id:order.registrationPublicId}
        if(this.data.member)this.setData({originalOrder:order.registrationPublicId,agreed:false})
      }
      if(this.currentVisit(visit) && this.data.member?.memberNo===member.memberNo)await this.payOriginal(order.registrationPublicId,visit)
    }catch(e){if(this.currentVisit(visit))this.setData({error:e.message||'请在我的门票中核对原单'})}
    finally{await this.refresh();this.setData({busy:false})}
  },
  contactStoreForTicket(event){
    const {order:orderId,ticket:ticketId}=event.currentTarget.dataset
    const order=this.data.mine.find(item=>item.registrationPublicId===orderId)
    const ticket=order?.tickets.find(item=>item.id===ticketId)
    if(!order || (ticketId && !ticket))return
    const contact=String(order.purchaseTerms?.serviceContact || order.purchaseContact || '')
    const phone=contact.replace(/[\s()（）－-]/g,'')
    const reference=[order.time,order.name,'购票单号 '+orderId,ticket?'第 '+ticket.number+' 张／共 '+order.quantity+' 张':'未出票',ticket?'票号 '+ticket.id:''].filter(Boolean).join('\n')
    wx.showActionSheet({itemList:['复制购票信息',/^\+?\d{7,15}$/.test(phone)?'拨打本场客服电话':'查看门店联系方式'],success:res=>{
      if(!this.visible || !this.data.mine.some(item=>item.registrationPublicId===orderId))return
      if(res.tapIndex===0)wx.setClipboardData({data:reference})
      else if(/^\+?\d{7,15}$/.test(phone))wx.makePhoneCall({phoneNumber:phone})
      else wx.navigateTo({url:'/pages/profile-contact/index'})
    }})
  },
  async changeShow(event){
    if(this.data.busy)return
    const {id,action}=event.currentTarget.dataset,accept=action==='accept'
    this.setData({busy:true,error:''})
    const visit=this.visit
    const answer=await new Promise(resolve=>wx.showModal({title:accept?'确认新场次与桌号':'保留原票安排',content:accept?'确认后切换到所列场次和桌号，原购票赠分及有效期保留。':'门店可继续联系，您也可以从原票申请售后。',success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm || !this.currentVisit(visit)){this.setData({busy:false});return}
    try{await api.decideTicketMove(id,accept);await this.refresh()}catch(e){this.setData({error:e.message})}finally{this.setData({busy:false})}
  },
  async confirmUse(event){
    if(this.data.busy)return
    const {id,points}=event.currentTarget.dataset
    this.setData({busy:true,error:''})
    const visit=this.visit
    const answer=await new Promise(resolve=>wx.showModal({title:'确认本人授权消费',content:'确认上述菜品使用了本票 '+points+' 分，门店复核后该部分将计入本票已用积分。',success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm || !this.currentVisit(visit)){this.setData({busy:false});return}
    try{await api.confirmTicketUse(id);await this.refresh()}catch(e){this.setData({error:e.message})}finally{this.setData({busy:false})}
  },
  async confirmDining(event){
    if(this.data.busy)return
    const {id,amount,merchant}=event.currentTarget.dataset
    this.setData({busy:true,error:''})
    const visit=this.visit
    const content='顾客应补 '+money(Number(amount))+(merchant!=null?'，门店承担 '+money(Number(merchant)):'')+(Number(amount)>0?'。确认后由收银在原餐单收款。':'。确认后无需付款。')
    const answer=await new Promise(resolve=>wx.showModal({title:'确认原菜品补款',content,success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm || !this.currentVisit(visit)){this.setData({busy:false});return}
    try{
      await api.confirmTicketDining(id)
      await this.refresh()
    }catch(e){
      await this.refresh()
      this.setData({error:e.message||'请在原票核对最新补款明细'})
    }finally{this.setData({busy:false})}
  },
  async resume(event){
    if(this.data.busy)return
    this.setData({busy:true,error:''})
    try{await this.payOriginal(event.currentTarget.dataset.id)}
    catch(e){this.setData({error:e.message||'请刷新原单核对付款结果'})}
    finally{await this.refresh();this.setData({busy:false})}
  },
  async payOriginal(id,visit=this.visit){
    const memberNo=this.data.member?.memberNo
    const state=await api.getActivityRegistrationPayment(id)
    if(!this.currentVisit(visit) || this.data.member?.memberNo!==memberNo)return
    if(!state.allowedActions.includes('start_payment')){if(state.allowedActions.includes('query_payment'))await api.queryActivityRegistrationPayment(id);return}
    const result=await api.startActivityRegistrationPayment(id,'tt-pay-'+id)
    const providerAction=result && (result.providerAction||result)
    if(!this.currentVisit(visit) || this.data.member?.memberNo!==memberNo)return
    if(providerAction && isPresentableWechatJsapiAction(providerAction)){
      try{await new Promise((resolve,reject)=>wx.requestPayment({...providerAction.payload,success:resolve,fail:reject}))}
      finally{
        if(this.currentVisit(visit) && this.data.member?.memberNo===memberNo)await api.queryActivityRegistrationPayment(id)
        else if(memberNo){
          this.returnedPayment={memberNo,id}
          await this.refresh()
        }
      }
    } else await api.queryActivityRegistrationPayment(id)
  },
})
