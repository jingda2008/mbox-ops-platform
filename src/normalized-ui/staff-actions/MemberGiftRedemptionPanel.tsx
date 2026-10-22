import {useEffect,useMemo,useRef,useState} from 'react'
import type {MenuBundleUnitSelection} from '../../shared/contracts'
import type {MemberGiftCommand,MemberGiftReceipt,MemberGiftWallet} from '../../shared/member-gift-redemption'
import {DurableStaffCommand} from '../durable-staff-command'
import type {StaffActionsApiPort} from './staff-actions-api'
import {GiftBundleChoices,giftChoicesComplete} from './GiftBundleChoices'

type Draft={productId:string;bundleSelections:MenuBundleUnitSelection[]}
export function MemberGiftRedemptionPanel({code,api}:{code:string;api:StaffActionsApiPort}){
  const owner=useMemo(()=>({api,code}),[api,code]),current=useRef(owner);current.current=owner
  const [state,setState]=useState<{owner:typeof owner;data:MemberGiftWallet}|null>(null)
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0)
  const [tables,setTables]=useState<Record<string,string>>({}),[drafts,setDrafts]=useState<Record<string,Draft>>({})
  const active=useRef(false),flight=useRef(false)
  const data=state?.owner===owner?state.data:null
  useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
  async function read(cursor?:string){
    if(!api.loadMemberGiftWallet)throw new Error('当前版本暂不支持赠品办理')
    const latest=await api.loadMemberGiftWallet(code,cursor)
    if(!active.current||current.current!==owner)return
    setState(previous=>({owner,data:cursor&&previous?.owner===owner?{...latest,items:[...new Map([...previous.data.items,...latest.items].map(item=>[item.id,item])).values()]}:latest}))
  }
  useEffect(()=>{
    let alive=true;setState(null);setError('');setNotice('');setTables({});setDrafts({});setBusy(false);flight.current=false
    void api.loadMemberGiftWallet?.(code).then(data=>{if(alive)setState({owner,data})}).catch(reason=>{if(alive)setError(message(reason))})
    return()=>{alive=false}
  },[api,code,owner])
  const command=useMemo(()=>data&&api.runMemberGiftCommand?new DurableStaffCommand<MemberGiftCommand,MemberGiftReceipt>(
    `member-gift:${data.employeeId}:${data.customerId}`,(body,key)=>api.runMemberGiftCommand!(data.employeeId,body,key),undefined,true):null,[api,data?.employeeId,data?.customerId])
  let pending:ReturnType<NonNullable<typeof command>['pending']>=null,storageError=''
  try{pending=command?.pending()??null}catch(reason){storageError=message(reason)}
  async function run(input?:MemberGiftCommand){
    if(!command||!data||flight.current||storageError)return
    const prior=command.pending(),action=input??prior?.body
    if(!action)return
    if(action.action==='cancel'&&!data.permissions.includes('benefit.cancel'))return
    if(action.action!=='cancel'&&!data.permissions.includes('loyalty.redemption.fulfill'))return
    flight.current=true;setBusy(true);setError('');setNotice('')
    try{
      await (input?command.submit(input):command.recover())
      await command.refresh(()=>read())
      if(active.current&&current.current===owner)setNotice(action.action==='redeem'?'原券已核销，所选商品已进入出品。':action.action==='cancel'?'原暂留已取消，未生成出品。':'已暂留一份，请核对商品后确认出品。')
    }catch(reason){if(active.current&&current.current===owner)setError(message(reason))}
    finally{if(active.current&&current.current===owner){flight.current=false;setBusy(false);setRevision(value=>value+1)}}
  }
  void revision
  const locked=busy||!!pending||!!storageError
  const gifts=data?.items.filter(item=>item.type==='gift_product'&&!item.pricePromise&&!item.snackClaim)??[]
  return <section aria-label="办理会员赠品券"><p>按本人当前桌台办理。固定价券在顾客订单结算使用；此处只办理免费赠品。</p>
    {(error||storageError)&&<p role="alert">{error||storageError}</p>}{notice&&<p role="status">{notice}</p>}
    {!data&&!error&&<p>正在读取原券与桌台…</p>}
    {pending&&<p>原操作结果尚待核对，暂不能新增或更改选款。<button type="button" disabled={busy||!!storageError} onClick={()=>void run()}>恢复原操作</button></p>}
    {data&&!data.permissions.includes('loyalty.redemption.fulfill')&&<p>当前账号没有权益核销权限，请由负责桌台的有权限员工办理。</p>}
    {data&&gifts.length===0&&<p>本页没有免费赠品券。</p>}
    {data&&gifts.map(item=><article key={item.id}><strong>{item.title} · 可用 {item.quantityAvailable} 份</strong>
      {item.quantityAvailable>0&&item.state==='available'&&data.permissions.includes('loyalty.redemption.fulfill')&&<div>
        {data.tables.length? <><label>当前桌台<select aria-label={`${item.title}桌台`} disabled={locked} value={tables[item.id]??data.tables[0]!.id} onChange={event=>setTables(value=>({...value,[item.id]:event.target.value}))}>{data.tables.map(table=><option key={table.id} value={table.id}>{table.code}</option>)}</select></label>
          <button type="button" disabled={locked} onClick={()=>void run({action:'reserve',body:{customerId:data.customerId,benefitId:item.id,tableSessionId:tables[item.id]??data.tables[0]!.id,quantity:1,expectedVersion:item.version}})}>暂留一份</button></>:<p>会员尚未加入您负责的当前桌台，请先按原入座流程确认。</p>}
      </div>}
      {item.reservations.map(reservation=>{
        const draft=drafts[reservation.id],product=item.products.find(product=>product.id===(draft?.productId??(item.products.length===1?item.products[0]!.id:'')))
        const groups=product?.bundleChoiceGroups??[],selections=draft?.bundleSelections??[]
        const canRedeem=reservation.canRedeem&&product?.status==='active'&&giftChoicesComplete(groups,reservation.quantity,selections)
        return <div key={reservation.id}><p>{reservation.tableCode} · 已暂留 {reservation.quantity} 份{!reservation.canRedeem?'（暂留已到期，请刷新）':''}</p>
          {item.products.length>1?<label>本次商品<select disabled={locked} value={product?.id??''} onChange={event=>setDrafts(value=>({...value,[reservation.id]:{productId:event.target.value,bundleSelections:[]}}))}><option value="">请选择原券指定商品</option>{item.products.map(product=><option key={product.id} value={product.id} disabled={product.status!=='active'}>{product.name}</option>)}</select></label>:<p>{product?.name??'原券商品暂不可用'}</p>}
          {product&&groups.length>0&&<GiftBundleChoices groups={groups} quantity={reservation.quantity} value={selections} disabled={locked} onChange={bundleSelections=>setDrafts(value=>({...value,[reservation.id]:{productId:product.id,bundleSelections}}))}/>}
          <button type="button" disabled={locked||!canRedeem||!data.permissions.includes('loyalty.redemption.fulfill')} onClick={()=>product&&void run({action:'redeem',body:{customerId:data.customerId,benefitId:item.id,tableSessionId:reservation.tableSessionId,reservationId:reservation.id,quantity:reservation.quantity,selectedProductId:product.id,...(groups.length?{bundleSelections:selections}:{})}})}>确认核销并出品</button>
          {data.permissions.includes('benefit.cancel')&&<button type="button" disabled={locked} onClick={()=>void run({action:'cancel',body:{customerId:data.customerId,benefitId:item.id,tableSessionId:reservation.tableSessionId,reservationId:reservation.id,quantity:reservation.quantity,reason:'现场核对取消原券暂留'}})}>取消本次暂留</button>}
        </div>
      })}
    </article>)}
    <button type="button" disabled={busy} onClick={()=>void read().catch(reason=>setError(message(reason)))}>刷新原券与桌台</button>
    {data?.nextCursor&&<button type="button" disabled={locked} onClick={()=>void read(data.nextCursor!).catch(reason=>setError(message(reason)))}>加载更多原券</button>}
  </section>
}
function message(reason:unknown){return reason instanceof Error?reason.message:'原兑换结果未确认，请恢复原操作'}
