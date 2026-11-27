const api = require('../../utils/api')
const {redirectToMembershipLogin} = require('../../utils/membership-gate')
const {customerErrorMessage} = require('../../utils/customer-error')
const {money,dateTime,beijingDate,beijingDateTime,parseInstant} = require('../../utils/format')
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

function presentOrders(orders, historyFirst) {
  const now = Date.now()
  const result = orders.map(order => {
    let nextAdmission = Infinity
    const tickets = order.tickets.map(ticket => {
      const show = ticket.currentShow || order
      if (ticket.doorCode && !ticket.refundStatus && !ticket.deskClosed && parseInstant(show.endsAt) > now) {
        const start = parseInstant(show.startsAt)
        if (Number.isFinite(start)) nextAdmission = Math.min(nextAdmission, start)
      }
      return {...ticket, moveTime: ticket.move ? dateTime(ticket.move.startsAt) + ' — ' + dateTime(ticket.move.endsAt) : '',
        effectiveTime: ticket.currentShow ? dateTime(show.startsAt) + ' — ' + dateTime(show.endsAt) : '',
        validThrough: beijingDate(parseInstant(ticket.expiresAt) - 1000)}
    })
    return {...order, cashDueTime:order.paymentDueAt?dateTime(order.paymentDueAt):'', purchasedAreaText: ticketAreaText(order.purchaseTerms?.area, order.purchaseTerms?.deskCodes), tickets, nextAdmission, total: money(Number(order.totalMinor)), time: dateTime(order.startsAt)}
  })
  if (historyFirst) result.sort((a,b) => a.nextAdmission === b.nextAdmission ? 0 : a.nextAdmission - b.nextAdmission)
  return result.map(({nextAdmission, ...order}) => order)
}

function priceSummary(offer,quantity){
  const count=Number(quantity)
  if (!offer || !Number.isSafeInteger(count) || count<1 || !Number.isSafeInteger(count*offer.priceMinor))return ''
  const points=count*offer.giftPoints
  return count+'桌 · 票款合计 '+money(count*offer.priceMinor)+(points?' · 共赠 '+points+' 积分':'')
}

Page({
  data:{offerMissing:false, historyFirst:false, catalogLoading:true, proposalLoading:false, historyLoading:true, historyError:'', identityError:'', proposalError:'', catalogError:'', purchaseError:'', purchaseReady:false, rulesOpen:false,offersOpen:false,failedCover:'',originalOrder:null,reservations:[],eligibleReservations:[],reservationLockId:null,proposals:[],proposalId:null,offers:[],mine:[],selected:null,quantity:'1',agreed:false,member:null,terms:null,phone:null,busy:false,error:''},
  onLoad(query){
    this.visit=0
    this.offerId=query.id||''
    this.setData({historyFirst:query.view==='mine' && !this.offerId})
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
  chooseAnother(){
    if(this.data.busy || this.data.historyLoading || this.data.historyError)return
    this.originalReceipt=null
    this.setData({reservationLockId:null,summary:priceSummary(this.data.selected,1),originalOrder:null,agreed:false,quantity:'1',proposalId:null})
  },
  loginForTickets(){ redirectToMembershipLogin('/pages/table-tickets/index?view=mine') },
  retryRead(){this.setData({error:''});return this.refresh()},
  async refresh(){
    if(this.visible===false)return
    const generation=this.readGeneration=(this.readGeneration||0)+1
    const current=()=>generation===this.readGeneration
    this.setData({mine:[],proposals:[],historyLoading:true, loginRequired:false, proposalLoading:true, catalogLoading:true, purchaseReady:false, historyError:'', identityError:'', proposalError:'', catalogError:'', purchaseError:''})
    await Promise.all([this.readCatalog(current), this.readMember(current)])
  },
  async readCatalog(current){
    try {
      const offers=(await api.getTableTicketOffers()).map(o=>({...o,areaText:ticketAreaText(o.areaName,o.deskCodes),cover:o.coverUrl?publicImageUrl(o.coverUrl):'',saleText:o.saleState==='upcoming'?dateTime(o.saleFrom)+' 开售':o.saleState==='ended'?'已停售':'',price:money(o.priceMinor),time:dateTime(o.startsAt)+' — '+dateTime(o.endsAt)}))
      if(!current())return
      const selected=offers.find(o=>o.id===this.offerId)||null
      const eligible=this.forOffer(selected,this.data.reservations)
      const lostLock=this.data.purchaseReady && this.data.reservationLockId && !eligible.some(row=>row.id===this.data.reservationLockId)
      this.setData({catalogLoading:false,offerMissing:Boolean(this.offerId && !selected),offers,selected,eligibleReservations:eligible,...(lostLock?{reservationLockId:null}:{}),
        summary:priceSummary(selected,this.data.quantity),agreed:Boolean(!lostLock && sameTicketNotice(selected,this.data.selected) && this.data.agreed)})
    } catch(e){if(current())this.setData({catalogLoading:false,offerMissing:false,offers:[],selected:null,agreed:false,catalogError:'可售票档暂时无法读取，请刷新重试。'})}
  },
  async readMember(current){
    let bootstrap
    try {bootstrap=await api.getMiniBootstrap()} catch(e){
      if(current())this.setData({...clearMemberDisplay(),historyLoading:false,loginRequired:['AUTH_REQUIRED','CUSTOMER_AUTHENTICATION_REQUIRED'].includes(e?.code) || e?.statusCode===401,identityError:customerErrorMessage(e,'暂时无法确认会员身份，请刷新重试')})
      return
    }
    if(!current())return
    const member=bootstrap.membership || null
    const memberNo=member?.memberNo
    if(this.originalReceipt && this.originalReceipt.memberNo!==memberNo)this.originalReceipt=null
    if(this.returnedPayment && this.returnedPayment.memberNo!==memberNo)this.returnedPayment=null
    const switched=this.data.member && this.data.member.memberNo!==memberNo
    this.setData({...(switched?clearMemberDisplay():{}),member,terms:bootstrap.membershipTerms || null,originalOrder:this.originalReceipt?.id || null})
    if(!memberNo){this.setData({historyLoading:false,proposalLoading:false});return}
    await Promise.all([this.readOwnedTickets(current), this.readProposals(current), this.readPurchaseDetails(current)])
  },
  async readOwnedTickets(current){
    try {
      const orders=await api.getMyTableTickets()
      if(!current())return
      this.setData({mine:presentOrders(orders,this.data.historyFirst),historyLoading:Boolean(this.returnedPayment)})
    } catch(e){
      if(current())this.setData({mine:[],historyLoading:false,historyError:customerErrorMessage(e,'购票记录暂时无法读取，请刷新重试')})
      return
    }
    const pending=this.returnedPayment
    if(!pending)return
    try {
      await api.queryActivityRegistrationPayment(pending.id)
      if(!current())return
      const orders=await api.getMyTableTickets()
      if(!current())return
      this.setData({mine:presentOrders(orders,this.data.historyFirst),historyLoading:false})
      if(this.returnedPayment===pending)this.returnedPayment=null
    } catch(e){if(current())this.setData({historyLoading:false,historyError:'原单付款结果待确认，请刷新核对。'})}
  },
  async readProposals(current){
    try {
      const proposals=await api.getTicketProposals()
      if(current())this.setData({proposals,proposalLoading:false,proposalError:''})
    } catch(e){if(current())this.setData({proposals:[],proposalLoading:false,proposalError:'服务员代选信息暂时无法读取。'})}
  },
  retryProposals(){
    if(this.data.proposalLoading || !this.data.member)return
    const generation=this.readGeneration
    this.setData({proposalLoading:true})
    return this.readProposals(()=>generation===this.readGeneration)
  },
  async readPurchaseDetails(current){
    try {
      const [reservations,phones]=await Promise.all([api.getTicketReservations(),api.getVerifiedPhones()])
      if(!current())return
      const eligible=this.forOffer(this.data.selected,reservations)
      const lostLock=!this.data.catalogLoading && this.data.reservationLockId && !eligible.some(row=>row.id===this.data.reservationLockId)
      this.setData({reservations,eligibleReservations:eligible,phone:phones[0] || null,purchaseReady:true,
        ...(lostLock?{reservationLockId:null,agreed:false}:{})})
    } catch(e){if(current())this.setData({purchaseReady:false,purchaseError:'购票所需的联系方式或订桌信息暂时无法读取，请刷新重试。'})}
  },
  forOffer(offer,rows){
    return offer?rows.filter(r=>r.areaId===offer.areaId&&parseInstant(r.startsAt)<=parseInstant(offer.startsAt)&&parseInstant(r.endsAt)>=parseInstant(offer.endsAt)):[]
  },
  chooseReservation(e){if(!this.data.busy)this.setData({reservationLockId:e.detail.value||null,agreed:false})},
  openProposal(event){
    const p=this.data.proposals.find(v=>v.id===event.currentTarget.dataset.id)
    const item=p&&this.data.offers.find(v=>v.id===p.offerId)
    if(this.data.catalogLoading || this.data.catalogError)return
    if(!item){this.setData({error:'票档已变更，请服务员重新选票'});return}
    if(this.data.busy)return
    this.originalReceipt=null
    this.offerId=item.id;this.setData({offerMissing:false,historyFirst:false,originalOrder:null,rulesOpen:false,offersOpen:false,selected:item,summary:priceSummary(item,p.quantity),reservationLockId:null,eligibleReservations:this.forOffer(item,this.data.reservations),quantity:String(p.quantity),proposalId:p.id,agreed:false,error:''},()=>wx.pageScrollTo({scrollTop:0,duration:180}))
  },
  select(event){
    if(this.data.busy)return
    this.originalReceipt=null
    this.offerId=event.currentTarget.dataset.id
    const selected=this.data.offers.find(o=>o.id===this.offerId)
    this.setData({offerMissing:false,originalOrder:null,rulesOpen:false,offersOpen:false,proposalId:null,reservationLockId:null,eligibleReservations:this.forOffer(selected,this.data.reservations),selected,summary:priceSummary(selected,1),quantity:'1',agreed:false,error:''},()=>wx.pageScrollTo({scrollTop:0,duration:180}))
  },
  viewOriginalOrder(){
    if(!this.data.originalOrder)return
    const index=this.data.mine.findIndex(order=>order.registrationPublicId===this.data.originalOrder)
    wx.pageScrollTo({selector:index<0?'#ticket-history':'#ticket-order-'+index,duration:180})
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
    const {busy,member,terms,phone,selected,quantity,agreed,reservationLockId,proposalId}=this.data
    if(busy || this.visible===false || this.data.historyLoading || this.data.catalogLoading || !selected || phone || (!member && !terms))return
    const auth=readWechatPhoneAuthorization(event,'未授权手机号。想继续购票，点下方按钮重新授权即可。')
    if(!auth.code){this.setData({error:auth.message});return}
    this.setData({busy:true,error:''})
    const visit=this.visit
    let memberNo
    try{
      if(member){
        await api.replaceVerifiedPhone(auth.code)
        memberNo=member.memberNo
      }else{
        const result=await api.enrollMembership(terms.version,'mini_community',auth.code)
        memberNo=result?.membership?.memberNo
      }
      if(!this.currentVisit(visit))return
      await this.refresh()
    }catch(e){
      if(this.currentVisit(visit))this.setData({error:customerErrorMessage(e,'暂时无法确认会员信息，请刷新后查看')})
      return
    }finally{this.setData({busy:false})}

    if(!agreed || !this.currentVisit(visit))return
    if(!memberNo || this.data.member?.memberNo!==memberNo){
      this.setData({agreed:false,error:'请核对当前会员后再购票。'})
      return
    }
    if(!member && this.data.eligibleReservations.length && !reservationLockId){
      this.setData({agreed:false,error:'你在这个时段已有订桌，请先选择沿用原桌或另购一桌。'})
      return
    }
    if(this.data.selected?.id===selected.id && this.data.quantity===quantity &&
      this.data.reservationLockId===reservationLockId && this.data.proposalId===proposalId)await this.buy()
  },
  async buy(){
    const {selected:o,quantity,agreed,member,phone}=this.data
    if(this.data.busy||!this.data.purchaseReady||this.data.catalogLoading||this.data.historyLoading||this.data.historyError||(this.data.proposalId && (this.data.proposalLoading || this.data.proposalError))||this.data.originalOrder||!o||(o.saleState && o.saleState!=='open')||!agreed||!member||!phone)return
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
    }catch(e){if(this.currentVisit(visit))this.setData({error:customerErrorMessage(e,'请在「我的门票」查看购票记录，避免重复付款')})}
    finally{await this.refresh();this.setData({busy:false})}
  },
  contactStoreForTicket(event){
    const {order:orderId,ticket:ticketId}=event.currentTarget.dataset
    const order=this.data.mine.find(item=>item.registrationPublicId===orderId)
    const ticket=order?.tickets.find(item=>item.id===ticketId)
    if(!order || (ticketId && !ticket))return
    const contact=String(order.purchaseTerms?.serviceContact || order.purchaseContact || '')
    const phone=contact.replace(/[\s()（）－-]/g,'')
    const visit=this.visit
    wx.showActionSheet({itemList:['复制购票信息',/^\+?\d{7,15}$/.test(phone)?'拨打本场客服电话':'查看门店联系方式'],success:res=>{
      const currentOrder=this.data.mine.find(item=>item.registrationPublicId===orderId)
      const currentTicket=currentOrder?.tickets.find(item=>item.id===ticketId)
      if(!this.visible || !this.currentVisit(visit) || !currentOrder || (ticketId && !currentTicket))return
      if(res.tapIndex===0){
        const originalTime=[beijingDateTime(currentOrder.startsAt,'') || currentOrder.time, beijingDateTime(currentOrder.endsAt,'')].filter(Boolean).join(' — ')
        const show=currentTicket?.currentShow
        const reference=[
          currentOrder.name,
          '当前场次 '+(show ? [show.title,[beijingDateTime(show.startsAt,''),beijingDateTime(show.endsAt,'')].filter(Boolean).join(' — ')].filter(Boolean).join(' · ') : originalTime),
          show && '原购场次 '+originalTime,
          currentTicket && ('桌号 '+(currentTicket.deskClosed?'已清台':currentTicket.tableName || '待安排')),
          '购票单号 '+orderId,
          currentTicket?'第 '+currentTicket.number+' 张／共 '+currentOrder.quantity+' 张':'未出票',
          currentTicket && '票号 '+currentTicket.id,
        ].filter(Boolean).join('\n')
        wx.setClipboardData({data:reference})
      }
      else if(/^\+?\d{7,15}$/.test(phone))wx.makePhoneCall({phoneNumber:phone})
      else wx.navigateTo({url:'/pages/profile-contact/index'})
    }})
  },
  async changeShow(event){
    if(this.data.busy)return
    const {id,action}=event.currentTarget.dataset,accept=action==='accept'
    this.setData({busy:true,error:''})
    const visit=this.visit
    const answer=await new Promise(resolve=>wx.showModal({title:accept?'确认新场次与桌号':'保留原票安排',content:accept?'确认后切换到所列场次和桌号，原购票赠分及有效期保留。':'如需调整安排，请联系门店。',success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm || !this.currentVisit(visit)){this.setData({busy:false});return}
    try{await api.decideTicketMove(id,accept);await this.refresh()}catch(e){this.setData({error:customerErrorMessage(e,'暂时无法确认改期结果，请刷新门票查看安排')})}finally{this.setData({busy:false})}
  },
  async confirmUse(event){
    if(this.data.busy)return
    const {id,points}=event.currentTarget.dataset
    this.setData({busy:true,error:''})
    const visit=this.visit
    const answer=await new Promise(resolve=>wx.showModal({title:'确认本人授权消费',content:'确认上述菜品使用了本票 '+points+' 分，门店复核后该部分将计入本票已用积分。',success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm || !this.currentVisit(visit)){this.setData({busy:false});return}
    try{await api.confirmTicketUse(id);await this.refresh()}catch(e){this.setData({error:customerErrorMessage(e,'暂时无法确认积分使用情况，请刷新门票查看')})}finally{this.setData({busy:false})}
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
      this.setData({error:customerErrorMessage(e,'请在这张票的详情中核对最新补款明细')})
    }finally{this.setData({busy:false})}
  },
  async resume(event){
    if(this.data.busy)return
    this.setData({busy:true,error:''})
    try{await this.payOriginal(event.currentTarget.dataset.id)}
    catch(e){this.setData({error:customerErrorMessage(e,'请刷新购票记录核对付款结果')})}
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
