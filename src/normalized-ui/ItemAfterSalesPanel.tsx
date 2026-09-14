import './item-after-sales.css'
import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import type {ItemAfterSalesWorkspace} from '../shared/item-after-sales'
import {ItemAfterSalesApi} from './item-after-sales-api'
import {AssistedOrderSheet} from './staff-actions/AssistedOrderSheet'
import {StaffActionsApi,StaffActionsApiError} from './staff-actions/staff-actions-api'

const money=(value:number)=>(value/100).toFixed(2)
const noticePhase=(phase?:string|null)=>({request:'申请阶段',payment_resolved:'付款核对后',approved:'审批通过',rejected:'审批拒绝',withdrawn:'申请撤回',resume:'恢复原商品',physical:'实物处理'}[phase??'']??'历史通知')
const statusName=(value:string,held:number,stopped:number)=>({requested:'待审核 / 核对',approved:'已批准，处理中',rejected:held?'已拒绝，仍暂停':stopped?'已拒绝，商品已停止':'已拒绝，已恢复原商品',withdrawn:held?'已撤回，仍暂停':stopped?'已撤回，商品已停止':'已撤回，已恢复原商品',completed:'已完成'}[value]??value)
export function ItemAfterSalesPanel({itemId,employeeId,onClose,onChanged,initialCaseId}:{initialCaseId?:string;itemId:string;employeeId:string;onClose():void;onChanged():void}){
  const dialog=useRef<HTMLDialogElement>(null)
  useEffect(()=>{const element=dialog.current,previous=document.activeElement;element?.showModal();return()=>{element?.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true})}},[])
  useEffect(()=>{
    const viewport=window.visualViewport
    const resize=()=>{dialog.current?.style.setProperty('--after-sales-viewport-height',`${viewport?.height??window.innerHeight}px`);dialog.current?.style.setProperty('--after-sales-viewport-top',`${viewport?.offsetTop??0}px`)}
    resize();viewport?.addEventListener('resize',resize);viewport?.addEventListener('scroll',resize);window.addEventListener('resize',resize)
    return()=>{viewport?.removeEventListener('resize',resize);viewport?.removeEventListener('scroll',resize);window.removeEventListener('resize',resize)}
  },[])
  const api=useMemo(()=>new ItemAfterSalesApi(employeeId),[employeeId])
  const staffApi=useMemo(()=>new StaffActionsApi(),[employeeId])
  const [replacementCase,setReplacementCase]=useState<{caseId:string;previousOrderId?:string}|null>(null)
  useEffect(()=>{if(!replacementCase)return;const previous=document.activeElement;return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true})}},[replacementCase])
  const [data,setData]=useState<ItemAfterSalesWorkspace|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const initialCaseRevealed=useRef(false)
  useEffect(()=>{if(!data||!initialCaseId||initialCaseRevealed.current)return;const target=[...dialog.current!.querySelectorAll<HTMLElement>('[data-case-id]')].find(element=>element.dataset.caseId===initialCaseId),region=dialog.current?.querySelector<HTMLElement>('[data-dialog-scroll]');if(target&&region){region.scrollTop=target.offsetTop-region.offsetTop;initialCaseRevealed.current=true}},[data,initialCaseId])
  const [needsRefresh,setNeedsRefresh]=useState(true)
  const readGeneration=useRef(0),actionBusy=useRef(false)
  const currentWorkspace=useRef('');currentWorkspace.current=`${employeeId}:${itemId}`
  const [funding,setFunding]=useState<Record<string,Record<string,string>>>({})
  const [cashConfirmed,setCashConfirmed]=useState<Record<string,boolean>>({})
  const [quantity,setQuantity]=useState('1'),[reason,setReason]=useState('客人临时不要了'),[received,setReceived]=useState<Record<string,boolean>>({}),[physicalQuantity,setPhysicalQuantity]=useState<Record<string,string>>({})
  const [redeliveryForm,setRedeliveryForm]=useState(false),[redeliveryCount,setRedeliveryCount]=useState('1'),[redeliveryReason,setRedeliveryReason]=useState('原实物仍在，重新送至客人'),[originalGoodsAvailable,setOriginalGoodsAvailable]=useState(false),[deliveredCounts,setDeliveredCounts]=useState<Record<string,string>>({})
  const [remakeForm,setRemakeForm]=useState<{taskId:string;maximum:number}|null>(null),[remakeCount,setRemakeCount]=useState('1'),[remakeReason,setRemakeReason]=useState('出品损坏，需要重新制作'),[originalGoodsLost,setOriginalGoodsLost]=useState(false)
  const [revision,setRevision]=useState<{caseId:string;quantity:string;reason:string}|null>(null)
  const read=useCallback(async()=>{const workspace=`${employeeId}:${itemId}`,generation=++readGeneration.current,value=await api.read(itemId);if(currentWorkspace.current===workspace&&readGeneration.current===generation){setData(value);setNeedsRefresh(false)}},[api,employeeId,itemId])
  useEffect(()=>{let active=true;setData(null);setNeedsRefresh(true);void read().catch(error=>{if(active)setError(error.message)});return()=>{active=false;readGeneration.current++}},[read])
  const [refreshDelayed,setRefreshDelayed]=useState(false)
  useEffect(()=>{
    let active=true,inFlight=false
    const refresh=async()=>{
      if(!active||inFlight||document.visibilityState==='hidden'||actionBusy.current||api.pending(itemId))return
      inFlight=true
      try{await read();if(active)setRefreshDelayed(false)}catch{if(active&&!actionBusy.current)setRefreshDelayed(true)}finally{inFlight=false}
    }
    // One visible product only. No write, reload, payment retry or hidden polling.
    const timer=setInterval(()=>void refresh(),10_000)
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh)
    return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)}
  },[api,itemId,read])
  const run=async(work:()=>Promise<unknown>)=>{
    if(actionBusy.current)return
    actionBusy.current=true;readGeneration.current++
    setBusy(true);setError('');setNotice('')
    let committed=false
    try{await work();committed=true;setNeedsRefresh(true);setNotice('处理结果已确认，正在更新商品');onChanged();await read();setNotice('商品处理进度已更新')}
    catch(error){
      setError(committed?'操作已经成功，最新商品状态暂未读回。请刷新商品状态，不用再次提交。':error instanceof Error?error.message:'结果待确认，请恢复原操作')
      if(error instanceof StaffActionsApiError&&error.code==='QUANTITY_BATCH_NOT_ENABLED'){
        setNeedsRefresh(true)
        try{await read()}catch{/* Keep the original facts and explicit refresh entry. */}
      }
    }
    finally{actionBusy.current=false;setBusy(false)}
  }
  const action=(caseId:string,name:string,body:Record<string,unknown>)=>run(()=>api.act(itemId,`/api/commerce/item-after-sales/${caseId}/${name}`,{...body,reason}))
  const available=data?.units.length?data.units.filter(unit=>!unit.heldByCaseId&&!unit.stoppedByCaseId&&!unit.operationallyStopped).length:data?.item.quantity??0
  const pending=api.pending(itemId)
  const locked=busy||!!pending||needsRefresh
  return <dialog ref={dialog} aria-label="商品停止与退款" className="staff-item-after-sales" onCancel={event=>{event.preventDefault();event.stopPropagation();if(replacementCase)setReplacementCase(null);else onClose()}}>
    <header><h3>{data?`${data.item.tableCode} · ${data.item.name}`:'商品处理'}</h3><button type="button" onClick={onClose}>关闭商品处理</button></header>
    <div className="staff-item-after-sales-body" data-dialog-scroll>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {refreshDelayed&&<p role="status" data-action-reveal="off">状态更新暂时延迟，可刷新查看；原处理结果保留。</p>}
    {!pending&&<button disabled={busy} onClick={()=>{setBusy(true);setError('');void read().then(()=>setNotice('商品状态已更新')).catch(()=>setError('最新商品状态暂未读回，请稍后再刷新')).finally(()=>setBusy(false))}}>刷新商品状态</button>}
    {pending&&<p>上次处理结果待确认。<button disabled={busy} onClick={()=>void run(()=>api.recover(itemId))}>恢复上次商品处理</button></p>}
    {!data?<p>正在读取原订单…</p>:<>
      <p>原订单 {data.item.quantity} 份 · {data.item.includedInBundle?'计费包含在原套餐内，不另收费':<>单价 ¥{money(data.item.unitPriceMinor)} · 原成交 ¥{money(data.item.originalAmountMinor)}</>}</p>
      <label>处理原因<select value={reason} disabled={locked} onChange={event=>setReason(event.target.value)}>
        <option>客人临时不要了</option><option>重复点单</option><option>商品售罄无法提供</option><option>出品问题协商处理</option><option>客人确认继续保留商品</option><option>实物已收回并核对</option>
      </select></label>
      {data.quantityEntryUnavailableReason&&<p>{data.quantityEntryUnavailableReason}</p>}
      {data.canRequest&&available>0&&<form onSubmit={event=>{event.preventDefault();void run(()=>api.act(itemId,'/api/commerce/item-after-sales/requests',{orderItemId:itemId,quantity:Number(quantity),reason}))}}>
        <label>本次停止份数<input type="number" min="1" max={available} required value={quantity} disabled={locked} onChange={event=>setQuantity(event.target.value)}/></label>
        <button disabled={locked}>{data.item.includedInBundle?'停止所选套餐商品':'停止 / 申请退款'}</button>
        <p>{data.item.includedInBundle?'处理所选份数，套餐其余商品继续。保留商品按下单时单点原价重算；未付未制作直接停止，已付由另一位有权人员审核一次。原单价缺失时先暂停待核对。':'仅处理所选份数。未付且未制作直接停止减账；未付已制作先暂停，按原免收权限确认。已付款由另一位有权人员审核一次。'}</p>
      </form>}
      {data.item.bundle&&<p>套餐组成行不另收费；退菜后按保留商品的原单点价计算差额，不按组成行的零元计算退款。</p>}
      {data.canManageRemake&&data.originalKdsTaskId&&(data.firstRemakeAvailableQuantity??0)>0&&<button disabled={locked} onClick={()=>{setRemakeCount('1');setOriginalGoodsLost(false);setRemakeForm({taskId:data.originalKdsTaskId!,maximum:data.firstRemakeAvailableQuantity!})}}>按份重新制作</button>}
      {data.remakes?.map((batch,index)=><article key={batch.id} aria-label="重做批次"><h4>重做第 {index+1} 批 · {batch.total} 份</h4>
        <p>{batch.reason}</p><p>未制作 {batch.unmade} · 制作中 {batch.started} · 待送 {batch.ready} · 已送 {batch.delivered} · 已结束 {batch.cancelled} 份{batch.held>0?`；其中暂停 ${batch.held} 份`:''}。</p>
        {data.canManageRemake&&batch.successorAvailableQuantity>0&&<button disabled={locked} onClick={()=>{setRemakeCount('1');setOriginalGoodsLost(false);setRemakeForm({taskId:batch.taskId,maximum:batch.successorAvailableQuantity})}}>本批按份再次制作</button>}
      </article>)}
      {data.canManageRemake&&remakeForm&&<form aria-label="按份重做" onSubmit={event=>{event.preventDefault();void run(async()=>{await api.act(itemId,`/api/commerce/kds/${remakeForm.taskId}/remake`,{quantity:Number(remakeCount),originalGoodsLost,reasonCode:'production_remake',reason:remakeReason});setRemakeForm(null)})}}>
        <label>本次重做份数<input type="number" min="1" max={remakeForm.maximum} required disabled={locked} value={remakeCount} onChange={event=>setRemakeCount(event.target.value)}/></label>
        <label>重做原因<input minLength={2} maxLength={500} required disabled={locked} value={remakeReason} onChange={event=>setRemakeReason(event.target.value)}/></label>
        <label><input type="checkbox" checked={originalGoodsLost} disabled={locked} onChange={event=>setOriginalGoodsLost(event.target.checked)}/>需要重新制作，无法直接补送这批原实物</label>
        <p>原单不再收费；只安排本次份数，新用材料单独记录。其余商品继续。</p>
        <button disabled={locked||!originalGoodsLost}>确认本次重做</button><button type="button" disabled={locked} onClick={()=>setRemakeForm(null)}>收起重做</button>
      </form>}
      {data.canRequestRedelivery&&<button disabled={locked} onClick={()=>setRedeliveryForm(value=>!value)}>原实物补送</button>}
      {data.canRequestRedelivery&&redeliveryForm&&<form onSubmit={event=>{event.preventDefault();void run(()=>api.act(itemId,'/api/commerce/item-after-sales/redeliveries',{orderItemId:itemId,quantity:Number(redeliveryCount),reason:redeliveryReason,originalGoodsAvailable}))}}>
        <label>补送份数<input type="number" min="1" max={data.redeliveryAvailableQuantity} required disabled={locked} value={redeliveryCount} onChange={event=>setRedeliveryCount(event.target.value)}/></label>
        <label>补送原因<input type="text" minLength={2} maxLength={1000} required disabled={locked} value={redeliveryReason} onChange={event=>setRedeliveryReason(event.target.value)}/></label>
        <label><input type="checkbox" disabled={locked} checked={originalGoodsAvailable} onChange={event=>setOriginalGoodsAvailable(event.target.checked)}/>原实物仍在且可交付，无需重新制作</label>
        <p>重新安排服务员送达，原金额和库存不变。</p>
        <button disabled={locked||!originalGoodsAvailable}>安排原实物补送</button>
      </form>}
      {data.redeliveries?.map(task=>{
        const available=task.pendingQuantity-task.pausedQuantity,count=deliveredCounts[task.id]??String(available)
        const active=['pending','acknowledged','in_progress'].includes(task.status)
        return <article key={task.id} aria-label="原实物补送任务"><h4>原实物补送 · {task.selectedQuantity} 份 · {task.status==='completed'?'已完成':task.status==='cancelled'||task.status==='expired'?'已结束':'待送达'}</h4>
          <p>{task.reason}；待补送 {task.pendingQuantity} · 其中暂停 {task.pausedQuantity} · 已补送 {task.deliveredQuantity} · 已取消 {task.cancelledQuantity} 份。</p>
          {data.canConfirmRedelivery&&active&&available>0&&<form onSubmit={event=>{event.preventDefault();void run(()=>api.act(itemId,`/api/commerce/item-after-sales/redeliveries/${task.id}/complete`,{quantity:Number(count),reason:'确认所选份数原实物已实际补送给客人'}))}}>
            <label>本次实际补送份数<input type="number" min="1" max={available} required disabled={locked} value={count} onChange={event=>setDeliveredCounts(value=>({...value,[task.id]:event.target.value}))}/></label>
            <button disabled={locked}>确认原实物已补送</button>
          </form>}
          {!data.canConfirmRedelivery&&active&&<p>请由负责取送的同事在待办中核对实际补送份数。</p>}
          {data.canCancelRedelivery&&active&&<button disabled={locked} onClick={()=>void run(()=>api.act(itemId,`/api/commerce/item-after-sales/redeliveries/${task.id}/cancel`,{reason:'现场确认取消本次补送，原商品和退款保持原处理'}))}>取消本次补送</button>}
          {task.pausedQuantity>0&&<p>暂停份数先处理原申请，确认继续原商品后才可补送。</p>}
        </article>
      })}
      {data.cases.map(current=>{
        const held=data.units.filter(unit=>unit.heldByCaseId===current.caseId&&(unit.productionState!=='unmade'||current.canDisposeHeldUnmade))
        const count=physicalQuantity[current.caseId]??String(held.length)
        const selectedUnits=held.slice(0,Number(count))
        const selection=selectedUnits.map(unit=>unit.id)
        const returnBlocked=selectedUnits.find(unit=>unit.returnEligibility?.canReturn===false)?.returnEligibility?.reason
        const releaseOnly=selectedUnits.length>0&&selectedUnits.every(unit=>unit.returnEligibility?.releaseOnly)
        const returnKnown=selectedUnits.length>0&&selectedUnits.every(unit=>unit.returnEligibility?.canReturn===true)
        const shares=data.fundingSources.map(source=>({paymentId:source.paymentId,amountMinor:cents(funding[current.caseId]?.[source.paymentId]??'')})).filter(value=>value.amountMinor!==0)
        const fundingValid=!current.requiresFundingChoice||shares.every(value=>value.amountMinor!==null)&&shares.reduce((sum,value)=>sum+(value.amountMinor??0),0)===current.amountMinor
        const validCount=Number.isSafeInteger(Number(count))&&Number(count)>0&&Number(count)<=held.length
        return <article key={current.caseId} data-case-id={current.caseId} aria-label={current.caseId===initialCaseId?'所选原售后单':undefined}>
          <h4>{current.businessDate} · {current.selectedQuantity} 份 · {current.revisedByCaseId?'已修改，原记录保留':current.closedByOrderCancellationId?'原整单已取消':statusName(current.status,current.heldQuantity,current.stoppedQuantity)}</h4>
          {current.replacementOrder&&<p>换品新单：{current.replacementOrder.publicId}（{current.replacementOrder.status==='cancelled'?'已取消':'已建立，请在本桌订单处理'}）。旧申请与新单分别结算；修改或撤回旧申请不会更改新单。</p>}
          {current.canReplace&&data.item.tableSessionId&&<button disabled={locked} onClick={()=>setReplacementCase({caseId:current.caseId,previousOrderId:current.replacementOrder?.orderId})}>{current.replacementOrder?'重新换品，另开新单':'换商品，另开新单'}</button>}
          {current.revisesCaseId&&<p>修改后的申请，按本次商品份数和原成交金额重新审核一次。</p>}
          {current.revisedByCaseId&&<p>新申请已接续处理。{current.heldQuantity>0?`另有 ${current.heldQuantity} 份仍暂停，确认客人保留后可继续原商品。`:'本记录不再接受审核，也未自动恢复商品。'}</p>}
          <p>{current.reason} · {current.closedByOrderCancellationId?'已随原整单取消，不另计算单品退款':<>{current.pricing?'本次退款':'原成交金额'} {current.amountMinor===null?'待核对':`¥${money(current.amountMinor)}`}</>}</p>
          {current.pricing&&<p>{current.pricing.policy==='broken_bundle'?'套餐已按保留商品的下单时单点原价重算':'按实际可退余额处理'}；本次退款 ¥{money(current.pricing.refundAmountMinor)}，处理后订单应收 ¥{money(current.pricing.effectiveAmountMinor)}。退回金额不超过实际付款扣除已退和处理中退款的余额；不自动收取补款。</p>}
          <p>实物：暂停 {current.heldQuantity} · 已停止 {current.stoppedQuantity} 份；资金：{current.status==='rejected'?(current.kind==='unpaid_stop'?'停止未获同意，未免收':'退款已拒绝，未退钱'):current.status==='withdrawn'?(current.kind==='unpaid_stop'?'申请已撤回，未免收':'申请已撤回，未退钱'):current.moneyComplete?(current.kind==='unpaid_stop'?'已免收所选原款，无退款':'已处理完成'):current.unpaidPaymentChanged?'原付款已有新记录，待核对':current.kind==='unpaid_stop'?'未付款，待停止核对':current.awaitingCashPayout?'待确认现金实际退付':current.refundFailed?'退款失败，待处理':current.refundNeedsReview?'渠道结果待核对':'处理中 / 待审核'}。</p>
          {current.unconfirmedNoticeCount>0&&<section aria-label="岗位通知待确认">
            <p>还有 {current.unconfirmedNoticeCount} 条岗位通知待知悉；出纸不代表岗位已看到，必要时直接联系岗位。</p>
            {current.notices.map(item=><p key={item.id}>{item.stationCode==='kitchen'?'后厨':'吧台'}：{item.instruction} · {noticePhase(item.phase)} {new Date(item.createdAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'})} · {item.printState==='attention'?'打印异常，请联系岗位':item.printState==='printed'?'打印程序已报完成，待岗位知悉':'等待打印，仍可直接联系岗位'}</p>)}
            {data.canAcknowledgeNotices&&current.notices.length>0&&<button disabled={locked} onClick={()=>void run(()=>api.act(itemId,`/api/commerce/item-after-sales/${current.caseId}/notice-ack`,{noticeIds:current.notices.map(item=>item.id),reason:'已联系所示岗位核实通知内容，岗位已知悉'}))}>已联系所示岗位，确认知悉</button>}
          </section>}
          {current.refunds.filter(refund=>refund.canRetry).map(refund=><button key={refund.id} disabled={locked} onClick={()=>void run(()=>api.act(itemId,`/api/commerce/item-after-sales/${current.caseId}/refund-retry`,{refundId:refund.id,reason:'仅重试已核实失败的原付款退款，沿用原审核'}))}>重试已确认失败的{refund.provider==='cash'?'现金':refund.provider==='postar'?'线上':'原渠道'}退款 ¥{money(refund.amountMinor)}</button>)}
          {data.canExecuteRefund&&current.refunds.filter(refund=>refund.provider==='cash'&&['approved','processing'].includes(refund.status)).map(refund=><div key={refund.id}>
            <label><input type="checkbox" disabled={locked} checked={cashConfirmed[refund.id]??false} onChange={event=>setCashConfirmed(value=>({...value,[refund.id]:event.target.checked}))}/>现金 ¥{money(refund.amountMinor)} 已实际退给客人</label>
            <button disabled={locked||!cashConfirmed[refund.id]} onClick={()=>void run(()=>api.act(itemId,`/api/refunds/${refund.id}/manual-result`,{succeeded:true}))}>登记现金已退</button>
          </div>)}
          {current.unpaidPaymentChanged&&<p>原付款记录已变化，不能继续按未付款免收。{current.canRevise?'可修改原申请，按最新原款重新核对；所选商品保持暂停。':'请核对原付款及原申请，所选商品保持暂停。'}</p>}
          {current.paymentAllocationReview&&<p>原付款分摊或部分付款退菜金额待核对；所选商品继续暂停，尚未发起退款。</p>}
          {current.canResolveUnpaid&&<button disabled={locked} onClick={()=>void run(()=>api.act(itemId,`/api/commerce/item-after-sales/${current.caseId}/resolve-unpaid`,{reason:'原付款已确认未收，继续原停止处理'}))}>原付款已确认未收，继续停止减账</button>}
          {current.inventoryReviewQuantity>0&&<p>有 {current.inventoryReviewQuantity} 份库存原记录待核对，未自动回库。</p>}
          {current.requiresFundingChoice&&<fieldset disabled={locked}><legend>按原付款确认退回金额（合计 ¥{money(current.amountMinor!)}）</legend>
            {data.fundingSources.filter(source=>source.availableMinor>0).map(source=><label key={source.paymentId}>{providerName(source.provider)} · 本单可退 ¥{money(source.availableMinor)}
              <input type="text" inputMode="decimal" aria-label={`${providerName(source.provider)}退回金额`} value={funding[current.caseId]?.[source.paymentId]??''} onChange={event=>setFunding(value=>({...value,[current.caseId]:{...value[current.caseId],[source.paymentId]:event.target.value}}))}/>
            </label>)}
          </fieldset>}
          {current.canApprove&&<button disabled={locked||!fundingValid} onClick={()=>void action(current.caseId,'decision',{decision:'approved',...(current.requiresFundingChoice?{funding:shares}:{})})}>{current.kind==='unpaid_stop'?'确认停止并免收':'批准'} ¥{money(current.amountMinor!)}</button>}
          {current.canReject&&<button disabled={locked} onClick={()=>void action(current.caseId,'decision',{decision:'rejected'})}>{current.kind==='unpaid_stop'?'拒绝停止':'拒绝退款'}</button>}
          {current.canWithdraw&&<button disabled={locked} onClick={()=>void action(current.caseId,'decision',{decision:'withdrawn'})}>撤回申请</button>}
          {current.canRevise&&<>
            <button disabled={locked} onClick={()=>setRevision({caseId:current.caseId,quantity:String(current.selectedQuantity),reason:current.reason})}>修改申请</button>
            {revision?.caseId===current.caseId&&<form onSubmit={event=>{event.preventDefault();void run(()=>api.act(itemId,`/api/commerce/item-after-sales/${current.caseId}/revision`,{quantity:Number(revision.quantity),reason:revision.reason}))}}>
              <label>修改后份数<input type="number" required min="1" max={available+current.heldQuantity} disabled={locked} value={revision.quantity} onChange={event=>setRevision({...revision,quantity:event.target.value})}/></label>
              <label>修改原因<input type="text" required minLength={2} maxLength={1000} disabled={locked} value={revision.reason} onChange={event=>setRevision({...revision,reason:event.target.value})}/></label>
              <p>修改后按原成交事实重新计算，旧申请不再接受审核。减少的份数仍暂停，需明确确认继续。</p>
              <button disabled={locked}>保存修改，重新申请</button><button type="button" disabled={locked} onClick={()=>setRevision(null)}>取消修改</button>
            </form>}
          </>}
          {current.resumeUnavailableReason&&<p>{current.resumeUnavailableReason}</p>}
          {current.canResume&&<button disabled={locked} onClick={()=>void action(current.caseId,'resume',{})}>确认继续原商品</button>}
          {(current.canDisposeMade??current.status==='approved')&&held.length>0&&(data.canReceive||data.canRecordUsed)&&<fieldset disabled={locked}>
            <legend>{current.canDisposeHeldUnmade?'剩余商品的实际去向':'已制作商品的实际去向'}</legend>
            {['rejected','withdrawn'].includes(current.status)&&<p>原桌次已结束；退款决定保持，仅核对实物去向。</p>}
            <label>本批实物份数<input type="number" min="1" max={held.length} value={count} onChange={event=>setPhysicalQuantity(value=>({...value,[current.caseId]:event.target.value}))}/></label>
            {data.canReceive&&returnBlocked&&<p role="note">库存记录待核对：{returnBlocked}{current.moneyComplete?' 退款已完成，不用再次退款。':''}请按实物事实处理，不要为清除待办登记损耗。</p>}
            {data.canReceive&&!returnKnown&&!returnBlocked&&<p>退库资格暂未核实，请刷新商品状态或联系库存负责人。</p>}
            {data.canReceive&&returnKnown&&<><label><input type="checkbox" checked={received[current.caseId]??false} onChange={event=>setReceived(value=>({...value,[current.caseId]:event.target.checked}))}/> {releaseOnly?'确认新批尚未制作，停止并释放预留':'已实际收回且未开封'}</label><button disabled={!validCount||!received[current.caseId]} onClick={()=>void action(current.caseId,'physical',{unitIds:selection,disposition:'returned_unopened',unopenedReceived:true})}>{releaseOnly?'确认停止并释放新批预留':'确认收回入库'}</button></>}
            {data.canRecordUsed&&<button disabled={!validCount} onClick={()=>void action(current.caseId,'physical',{unitIds:selection,disposition:'used_loss',unopenedReceived:false})}>已消耗，不回库</button>}
          </fieldset>}
        </article>
      })}
      {!data.cases.length&&<p>该商品暂无售后申请。</p>}
    </>}
    </div>
    {replacementCase&&data?.item.tableSessionId&&<AssistedOrderSheet key={`${replacementCase.caseId}:${replacementCase.previousOrderId??'first'}`} api={staffApi} mode="paid" replacementCaseId={replacementCase.caseId} replacementPreviousOrderId={replacementCase.previousOrderId}
      table={{code:data.item.tableCode,activeSession:{id:data.item.tableSessionId,guestCount:data.item.guestCount??1}}}
      onClose={()=>{setReplacementCase(null);setNeedsRefresh(true);void read().catch(()=>setError('请刷新原商品，核对换品新单是否已建立'))}}
      onSubmitted={message=>{setNotice(message);onChanged();void read().catch(()=>setNeedsRefresh(true))}}/>}
  </dialog>
}

function cents(value:string):number|null{if(!value.trim())return 0;if(!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))return null;const [whole,fraction='']=value.trim().split('.');const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));return Number.isSafeInteger(result)?result:null}
function providerName(provider:string){return ({cash:'现金',postar:'线上原路',wechat:'微信',physical_pos:'POS',external_manual:'线下原工具'}[provider]??'原付款')}
