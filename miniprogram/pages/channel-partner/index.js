const { ensureCustomerSession } = require('../../utils/auth')
const { getChannelPartner, getChannelHistory, getChannelPoster, acceptChannelInvitation,respondChannelStatement,getChannelStatement } = require('../../utils/api')
const { commandIdentityScope } = require('../../utils/recoverable-command')
const { customerErrorMessage } = require('../../utils/customer-error')
const amount = value => value == null ? '待核算' : '¥' + (Number(value) / 100).toFixed(2)
function historyItems(kind,items) {
  return items.map(item=>kind==='visits'?Object.assign({},item,{consumptionText:amount(item.qualifiedConsumptionMinor),commissionText:amount(item.accruedCommissionMinor)}):kind==='statements'?Object.assign({},item,{amountText:amount(item.amountMinor),paidText:amount(item.paidMinor)}):item)
}
Page({
  data: { historyBusy:'', token: '', account: null, statementDetail:null, loading: false, busy: false, error: '', notice: '' },
  onShow() { this.load() },
  onHide() { this.generation = (this.generation || 0) + 1 },
  onUnload() { this.generation = (this.generation || 0) + 1 },
  tokenInput(event) { this.setData({ token: event.detail.value }) },
  async load() {
    const generation = this.generation = (this.generation || 0) + 1
    let owner
    this.historyOwner=null
    this.setData({ account: null, historyBusy:'', statementDetail:null, loading: true, error: '' })
    try {
      await ensureCustomerSession(false)
      if(generation!==this.generation)return
      owner=commandIdentityScope()
      const account = await getChannelPartner()
      if (generation !== this.generation || owner !== commandIdentityScope()) return
      if(account.restaurant)account.restaurant=account.restaurant.map(r=>Object.assign({},r,{commissionText:amount(r.commissionMinor)}))
      account.visits = account.visits.map(v => Object.assign({}, v, { consumptionText: amount(v.qualifiedConsumptionMinor), commissionText: amount(v.accruedCommissionMinor) }))
      if(account.finance){account.finance.balances=(account.finance.balances||[]).map(b=>Object.assign({},b,{balanceText:amount(b.balanceMinor),paidText:amount(b.paidMinor),accruedText:amount(b.accruedMinor)}));account.finance.statements=account.finance.statements.map(s=>Object.assign({},s,{amountText:amount(s.amountMinor),paidText:amount(s.paidMinor)}));account.finance.positions=account.finance.positions.map(p=>Object.assign({},p,{amountText:amount(p.commissionMinor),reasonText:(p.reasons||[]).join('、')}))}
      this.historyOwner=owner
      this.setData({ account })
    } catch (error) { if (generation === this.generation && (!owner || owner===commandIdentityScope())) this.setData({ error: customerErrorMessage(error, '请使用门店邀请的本人账号登录') }) }
    finally { if (generation === this.generation) this.setData({ loading: false }) }
  },
  async loadHistory(event) {
    const kind=event.currentTarget.dataset.kind
    if(!['batches','visits','statements'].includes(kind)||this.data.busy||this.data.loading||this.data.historyBusy)return
    const account=this.data.account,cursor=account&&account.nextCursors&&account.nextCursors[kind]
    if(!cursor)return
    if(this.historyOwner!==commandIdentityScope())return this.load()
    const owner=this.historyOwner,generation=this.generation
    this.setData({historyBusy:kind,error:''})
    try {
      const page=await getChannelHistory(kind,cursor)
      if(generation!==this.generation||owner!==commandIdentityScope())return
      if(page.nextCursor===cursor)throw new Error('历史分页未前进，请刷新后重试')
      const previous=kind==='statements'?account.finance.statements:account[kind], ids=new Set(previous.map(item=>item.id))
      const combined=previous.concat(historyItems(kind,page.items.filter(item=>!ids.has(item.id))))
      const updated=Object.assign({},account,{nextCursors:Object.assign({},account.nextCursors,{[kind]:page.nextCursor})})
      if(kind==='statements')updated.finance=Object.assign({},account.finance,{statements:combined})
      else updated[kind]=combined
      this.setData({account:updated})
    }catch(error){if(generation===this.generation&&owner===commandIdentityScope())this.setData({error:customerErrorMessage(error,'历史记录读取失败，请重试')})}
    finally{if(generation===this.generation)this.setData({historyBusy:''})}
  },
  async accept() {
    if (this.writing || !this.data.token.trim()) return
    this.writing = true; this.setData({ busy: true, error: '' })
    const owner = commandIdentityScope(), generation = this.generation
    try { await acceptChannelInvitation(this.data.token.trim()); if (owner !== commandIdentityScope() || generation !== this.generation) return; this.setData({ token: '', notice: '合作账号已绑定，请妥善保管本人账号。' }); await this.load() }
    catch (error) { if (owner === commandIdentityScope() && generation === this.generation) this.setData({ error: customerErrorMessage(error, '邀请绑定未确认，请恢复原操作') }) }
    finally { this.writing = false; this.setData({ busy: false }) }
  },
  async viewStatement(event) {
    const owner=commandIdentityScope(),generation=this.generation
    const request=this.statementRequest=(this.statementRequest||0)+1
    this.setData({statementDetail:null,error:''})
    const current=()=>owner===commandIdentityScope()&&generation===this.generation&&request===this.statementRequest
    try{const detail=await getChannelStatement(event.currentTarget.dataset.id);if(!current())return false
      detail.lines=detail.lines.map(l=>Object.assign({},l,{deltaText:amount(l.deltaMinor),basisText:amount(l.basisMinor),orders:(l.evidence.evidence||[]).map(o=>Object.assign({},o,{paidText:amount(o.paid),refundText:amount(o.refunded),basisText:amount(o.basis)}))}))
      this.setData({statementDetail:detail});return true
    }catch(e){if(current())this.setData({error:customerErrorMessage(e,'结算明细读取失败')});return false}
  },
  async statementResponse(event) {
    if(this.writing)return
    const id=event.currentTarget.dataset.id,dispute=event.currentTarget.dataset.dispute==='1'
    const owner=commandIdentityScope(),generation=this.generation,detail=this.data.statementDetail
    if(!detail||detail.statement.id!==id){
      if(await this.viewStatement(event))this.setData({notice:'请先核对下方结算明细，再确认本单'})
      return
    }
    // Keep the reviewed detail and identity fixed across the native modal wait.
    this.writing=true;this.setData({busy:true,error:''})
    try{
      const dialog=await new Promise(resolve=>wx.showModal({title:dispute?'提交结算争议':'确认结算单',content:dispute?'请填写与原消费记录不符的内容':'请确认已核对本单消费、退款及佣金明细',editable:dispute,success:resolve,fail:()=>resolve({confirm:false})}))
      if(!dialog.confirm||owner!==commandIdentityScope()||generation!==this.generation||detail!==this.data.statementDetail)return
      const reason=dispute?String(dialog.content||'').trim():'已核对本单消费及退款明细，无异议'
      if(reason.length<2){this.setData({error:'请填写具体争议依据'});return}
      await respondChannelStatement(id,dispute,reason)
      if(owner===commandIdentityScope()&&generation===this.generation)await this.load()
    }catch(error){if(owner===commandIdentityScope()&&generation===this.generation)this.setData({error:customerErrorMessage(error,'请恢复原结算确认并核对')})}
    finally{this.writing=false;this.setData({busy:false})}
  },
  async download(event) {
    if (this.writing) return
    this.writing = true; this.setData({ busy: true, error: '', notice: '' })
    const owner = commandIdentityScope(), generation = this.generation
    let path
    try {
      const image = await getChannelPoster(event.currentTarget.dataset.id)
      if (owner !== commandIdentityScope() || generation !== this.generation) return
      path = wx.env.USER_DATA_PATH + '/' + image.filename
      await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath: path, data: image.base64, encoding: 'base64', success: resolve, fail: reject }))
      if (owner !== commandIdentityScope() || generation !== this.generation) return
      await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: path, success: resolve, fail: reject }))
      if (owner === commandIdentityScope() && generation === this.generation) this.setData({ notice: '推广图已保存到相册，可自行发给客户。' })
    } catch (error) { if (generation === this.generation) this.setData({ error: customerErrorMessage(error, '图片未保存，请检查相册权限后重试') }) }
    finally { if (path) wx.getFileSystemManager().unlink({ filePath: path, fail: () => {} }); this.writing = false; if (generation === this.generation) this.setData({ busy: false }) }
  },
})
