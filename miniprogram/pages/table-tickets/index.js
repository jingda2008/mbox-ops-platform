const api = require('../../utils/api')
const {money,dateTime,beijingDate,parseInstant} = require('../../utils/format')
const {readWechatPhoneAuthorization} = require('../../utils/wechat-phone')
const {randomId} = require('../../utils/id')
const {isPresentableWechatJsapiAction} = require('../../utils/wechat-payment')

function priceSummary(offer,quantity){
  const count=Number(quantity)
  if (!offer || !Number.isSafeInteger(count) || count<1 || !Number.isSafeInteger(count*offer.priceMinor))return ''
  const points=count*offer.giftPoints
  return count+'桌 · 票款合计 '+money(count*offer.priceMinor)+(points?' · 共赠 '+points+' 积分':'')
}

Page({
  data:{originalOrder:null,reservations:[],eligibleReservations:[],reservationLockId:null,proposals:[],proposalId:null,offers:[],mine:[],selected:null,quantity:'1',agreed:false,member:null,terms:null,phone:null,busy:false,error:''},
  onLoad(query){
    this.offerId=query.id||''
    if(typeof query.quantity==='string' && /^[1-9]\d{0,8}$/.test(query.quantity))this.setData({quantity:query.quantity})
  },
  onShareAppMessage(){
    const o=this.data.selected
    return o?{title:o.name+' · '+o.time,path:'/pages/table-tickets/index?id='+encodeURIComponent(o.id)+'&quantity='+encodeURIComponent(this.data.quantity)}:
      {title:'整桌演出门票',path:'/pages/table-tickets/index'}
  },
  onShow(){this.visible=true;void this.refresh()},
  onHide(){this.visible=false;this.readGeneration=(this.readGeneration||0)+1},
  onUnload(){this.onHide()},
  chooseAnother(){this.setData({summary:priceSummary(this.data.selected,1),originalOrder:null,agreed:false,quantity:'1',proposalId:null})},
  async refresh(){
    const generation=this.readGeneration=(this.readGeneration||0)+1
    try {
      const offers=(await api.getTableTicketOffers()).map(o=>({...o,saleText:o.saleState==='upcoming'?dateTime(o.saleFrom)+' 开售':o.saleState==='ended'?'已停售':'',price:money(o.priceMinor),time:dateTime(o.startsAt)+' — '+dateTime(o.endsAt)}))
      if(generation!==this.readGeneration)return
      const selected=offers.find(o=>o.id===this.offerId)||null
      this.setData({offers,selected,summary:priceSummary(selected,this.data.quantity),agreed:selected?.id===this.data.selected?.id && this.data.agreed})
      const [bootstrap,orders,proposals,reservations]=await Promise.all([api.getMiniBootstrap(),api.getMyTableTickets(),api.getTicketProposals(),api.getTicketReservations()])
      const phones=bootstrap.membership?await api.getVerifiedPhones():[]
      if(generation!==this.readGeneration)return
      this.setData({proposals,reservations,eligibleReservations:this.forOffer(selected,reservations),member:bootstrap.membership||null,terms:bootstrap.membershipTerms||null,phone:phones[0]||null,
        mine:orders.map(o=>({...o,tickets:o.tickets.map(t=>({...t,moveTime:t.move?dateTime(t.move.startsAt)+' — '+dateTime(t.move.endsAt):'',effectiveTime:t.currentShow?dateTime(t.currentShow.startsAt)+' — '+dateTime(t.currentShow.endsAt):'',validThrough:beijingDate(parseInstant(t.expiresAt)-1000)})),total:money(Number(o.totalMinor)),time:dateTime(o.startsAt)}))})
    } catch(e){if(generation===this.readGeneration)this.setData({error:e.message||'读取失败，请刷新'})}
  },
  forOffer(offer,rows){
    return offer?rows.filter(r=>r.areaId===offer.areaId&&parseInstant(r.startsAt)<=parseInstant(offer.startsAt)&&parseInstant(r.endsAt)>=parseInstant(offer.endsAt)):[]
  },
  chooseReservation(e){this.setData({reservationLockId:e.detail.value||null})},
  openProposal(event){
    const p=this.data.proposals.find(v=>v.id===event.currentTarget.dataset.id)
    const item=p&&this.data.offers.find(v=>v.id===p.offerId)
    if(!item){this.setData({error:'票档已变更，请服务员重新选票'});return}
    this.offerId=item.id;this.setData({originalOrder:null,selected:item,summary:priceSummary(item,p.quantity),reservationLockId:null,eligibleReservations:this.forOffer(item,this.data.reservations),quantity:String(p.quantity),proposalId:p.id,agreed:false,error:''})
  },
  select(event){
    this.offerId=event.currentTarget.dataset.id
    const selected=this.data.offers.find(o=>o.id===this.offerId)
    this.setData({originalOrder:null,proposalId:null,reservationLockId:null,eligibleReservations:this.forOffer(selected,this.data.reservations),selected,summary:priceSummary(selected,1),quantity:'1',agreed:false,error:''})
  },
  quantity(event){this.setData({quantity:event.detail.value,summary:priceSummary(this.data.selected,event.detail.value)})},
  agree(event){this.setData({agreed:event.detail.value.includes('yes')})},
  async authorize(event){
    if(this.data.busy)return
    const auth=readWechatPhoneAuthorization(event)
    if(!auth.code){this.setData({error:auth.message});return}
    this.setData({busy:true,error:''})
    try{
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
    try {
      const order=await api.buyTableTickets({offerId:o.id,...(this.data.reservationLockId?{reservationLockId:this.data.reservationLockId}:{}),...(this.data.proposalId?{proposalId:this.data.proposalId}:{}),quantity:Number(quantity),refundVersion:o.refundVersion,
        safetyVersion:o.safetyVersion,termsAcknowledged:true},randomId('table-ticket'))
      this.setData({originalOrder:order.registrationPublicId,agreed:false})
      if(this.visible!==false)await this.payOriginal(order.registrationPublicId)
    }catch(e){this.setData({error:e.message||'请在我的门票中核对原单'})}
    finally{await this.refresh();this.setData({busy:false})}
  },
  async withdraw(event){
    if(this.data.busy)return
    const answer=await new Promise(resolve=>wx.showModal({title:'撤回退票申请',content:'已补收的菜款须退回原收款方式后才解冻本票积分。',success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm)return
    this.setData({busy:true,error:''})
    try{await api.withdrawTicketRefund(event.currentTarget.dataset.ticket);await this.refresh()}catch(e){this.setData({error:e.message})}finally{this.setData({busy:false})}
  },
  async changeShow(event){
    if(this.data.busy)return
    const {id,action}=event.currentTarget.dataset,accept=action==='accept'
    this.setData({busy:true,error:''})
    const answer=await new Promise(resolve=>wx.showModal({title:accept?'确认新场次与桌号':'保留原票安排',content:accept?'确认后切换到所列场次和桌号，原购票赠分及有效期保留。':'门店可继续联系，您也可以从原票申请售后。',success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm){this.setData({busy:false});return}
    try{await api.decideTicketMove(id,accept);await this.refresh()}catch(e){this.setData({error:e.message})}finally{this.setData({busy:false})}
  },
  async confirmUse(event){
    if(this.data.busy)return
    const {id,points}=event.currentTarget.dataset
    this.setData({busy:true,error:''})
    const answer=await new Promise(resolve=>wx.showModal({title:'确认本人授权消费',content:'确认上述菜品使用了本票 '+points+' 分，门店复核后该部分将计入本票已用积分。',success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm){this.setData({busy:false});return}
    try{await api.confirmTicketUse(id);await this.refresh()}catch(e){this.setData({error:e.message})}finally{this.setData({busy:false})}
  },
  async confirmDining(event){
    if(this.data.busy)return
    const {id,amount}=event.currentTarget.dataset
    const answer=await new Promise(resolve=>wx.showModal({title:'确认原菜品补款',content:'本次确认 '+money(Number(amount))+'，由门店在原餐饮单收取。',success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm)return
    this.setData({busy:true,error:''})
    try{await api.confirmTicketDining(id);await this.refresh()}catch(e){this.setData({error:e.message})}finally{this.setData({busy:false})}
  },
  async refund(event){
    if(this.data.busy)return
    const {order,ticket}=event.currentTarget.dataset
    const answer=await new Promise(resolve=>wx.showModal({title:ticket?'申请退这张票':'申请退回未出票款',editable:true,placeholderText:'填写退票原因',success:resolve,fail:()=>resolve({confirm:false})}))
    if(!answer.confirm)return
    const reason=String(answer.content||'').trim()
    if(reason.length<2){this.setData({error:'请填写至少两个字的退票原因'});return}
    this.setData({busy:true,error:''})
    try{await api.refundTableTicket(order,ticket,reason);await this.refresh()}
    catch(e){this.setData({error:e.message||'请核对原退票申请'})}finally{this.setData({busy:false})}
  },
  async resume(event){
    if(this.data.busy)return
    this.setData({busy:true,error:''})
    try{await this.payOriginal(event.currentTarget.dataset.id)}
    catch(e){this.setData({error:e.message||'请刷新原单核对付款结果'})}
    finally{await this.refresh();this.setData({busy:false})}
  },
  async payOriginal(id){
    const state=await api.getActivityRegistrationPayment(id)
    if(this.visible===false)return
    if(!state.allowedActions.includes('start_payment')){if(state.allowedActions.includes('query_payment'))await api.queryActivityRegistrationPayment(id);return}
    const result=await api.startActivityRegistrationPayment(id,'tt-pay-'+id)
    const providerAction=result && (result.providerAction||result)
    if(this.visible===false)return
    if(providerAction && isPresentableWechatJsapiAction(providerAction)){
      try{await new Promise((resolve,reject)=>wx.requestPayment({...providerAction.payload,success:resolve,fail:reject}))}
      finally{await api.queryActivityRegistrationPayment(id)}
    } else await api.queryActivityRegistrationPayment(id)
  },
})
