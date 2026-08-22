import { useCallback,useEffect,useState,type FormEvent } from 'react'
import type { NormalizedApiClient,StaffAuthView } from '../normalized-api'
import { MediaAssetPicker } from './MediaAssetPicker'
import './activity-operations-panel.css'

type CardStatus='draft'|'published'|'paused'|'retired'
type CardType='activity'|'presale'|'benefit'|'article'|'return_offer'|'show'
interface CardView{
  code:string;type:CardType;title:string;summary:string;imageUrl:string|null;ctaLabel:string
  targetPath:string;priority:number;visibility:'public'|'member'|'segment'
  audienceMemberLevels:string[];audienceLifecycleStages:string[]
  validFrom:string;validUntil:string;status:CardStatus;updatedAt:string
}
interface Draft{
  code:string;type:CardType;title:string;summary:string;imageUrl:string;ctaLabel:string
  targetPath:string;priority:string;visibility:'public'|'member';validFrom:string;validUntil:string;reason:string
}
interface SupportContactView { rolloutState:'disabled'|'pilot'|'enabled'|'shadow'; contact:{phone:string;phoneLabel:string;wecomName:string;wecomQrImageUrl:string|null}|null }
interface SupportDraft { rolloutState:'disabled'|'pilot'|'enabled'; phone:string; phoneLabel:string; wecomName:string; wecomQrImageUrl:string; reason:string }

export function HomeContentManagementPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
  const canView=auth.permissions.includes('community.activity.view')
  const canManage=auth.permissions.includes('community.activity.manage')
  const canPublish=auth.permissions.includes('community.activity.publish')
  const [expanded,setExpanded]=useState(false)
  const [cards,setCards]=useState<CardView[]>([])
  const [selected,setSelected]=useState('')
  const [draft,setDraft]=useState<Draft|null>(null)
  const [busy,setBusy]=useState('')
  const [notice,setNotice]=useState('')
  const [supportDraft,setSupportDraft]=useState<SupportDraft|null>(null)

  const load=useCallback(async()=>{
    setBusy('load')
    try{
      const response=await api.getEndpoint<{data:unknown}>('/api/staff/home-content-cards')
      const next=cardList(response.data);setCards(next)
      if(canManage){
        const support=await api.getEndpoint<{data:unknown}>('/api/staff/customer-experience/support-contact')
        setSupportDraft(toSupportDraft(support.data))
      }
      if(selected){const current=next.find(item=>item.code===selected);if(current)setDraft(toDraft(current))}
    }catch(error){setNotice(message(error,'首页内容暂时无法读取'))}
    finally{setBusy('')}
  },[api,canManage,selected])
  useEffect(()=>{if(expanded&&canView)void load()},[expanded,canView,load])
  if(!canView)return null
  function create(){setSelected('');setDraft(emptyDraft());setNotice('正在建立首页精选内容草稿。未发布前顾客端不可见。')}
  function edit(card:CardView){setSelected(card.code);setDraft(toDraft(card));setNotice(card.status==='published'?'已发布内容需先暂停展示，再修改。':'正在编辑草稿。')}
  function update<K extends keyof Draft>(key:K,value:Draft[K]){setDraft(current=>current===null?null:{...current,[key]:value})}
  async function save(event:FormEvent){
    event.preventDefault();if(!draft||busy)return
    setBusy('save');setNotice('')
    try{
      const body=payload(draft)
      const endpoint=selected?`/api/staff/home-content-cards/${encodeURIComponent(selected)}/draft`:'/api/staff/home-content-cards'
      const response=selected
        ?await api.putEndpoint<unknown>(endpoint,body,{idempotencyKey:key('home-content-update')})
        :await api.postEndpoint<unknown>(endpoint,body,{idempotencyKey:key('home-content-create')})
      const saved=card(response);setSelected(saved.code);setDraft(toDraft(saved));setNotice('草稿已保存，发布前不会出现在小程序首页。');await load()
    }catch(error){setNotice(message(error,'草稿没有保存'))}
    finally{setBusy('')}
  }
  async function action(card:CardView,operation:'publish'|'pause'){
    if(busy)return
    const prompt=operation==='publish'?`确认发布“${card.title}”？到达展示时间后小程序会自动出现。`:`确认暂停“${card.title}”？小程序会立即停止展示。`
    if(!window.confirm(prompt))return
    setBusy(`${operation}:${card.code}`);setNotice('')
    try{
      await api.postEndpoint(`/api/staff/home-content-cards/${encodeURIComponent(card.code)}/${operation}`,{
        reason:operation==='publish'?'管理人员确认内容、链接与展示排期后发布':'管理人员暂停首页展示',
      },{idempotencyKey:key(`home-content-${operation}`)})
      setNotice(operation==='publish'?'内容已发布；无需重新发版。':'内容已暂停展示。');await load()
    }catch(error){setNotice(message(error,operation==='publish'?'内容没有发布':'内容没有暂停'))}
    finally{setBusy('')}
  }
  function updateSupport<K extends keyof SupportDraft>(key:K,value:SupportDraft[K]){setSupportDraft(current=>current===null?null:{...current,[key]:value})}
  async function saveSupport(event:FormEvent){
    event.preventDefault();if(!supportDraft||busy)return
    setBusy('support');setNotice('')
    try{
      await api.putEndpoint('/api/staff/customer-experience/support-contact',{rolloutState:supportDraft.rolloutState,configuration:{phone:supportDraft.phone,phoneLabel:supportDraft.phoneLabel,wecomName:supportDraft.wecomName,wecomQrImageUrl:supportDraft.wecomQrImageUrl||null},reason:supportDraft.reason},{idempotencyKey:key('support-contact-update')})
      setNotice(supportDraft.rolloutState==='enabled'?'门店联系信息已发布到小程序“我的”页面。':'门店联系信息已保存为关闭状态，顾客端不会显示。');await load()
    }catch(error){setNotice(message(error,'门店联系信息没有保存'))}
    finally{setBusy('')}
  }

  return <section className="activity-operations-panel home-content-panel" aria-label="小程序首页精选内容管理">
    <header><div><strong>小程序首页精选内容</strong><small>管理品牌故事、演出预告和精选内容；超嗨活动仍在上方活动工作台编辑发布，首页会自动取已发布活动。</small></div><button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起':'打开内容管理'}</button></header>
    {expanded&&<>
      {notice&&<p className="activity-operations-notice" role="status">{notice}</p>}
      <div className="activity-operations-toolbar"><span>{cards.length} 条内容</span><div>{canManage&&<button type="button" onClick={create}>新建内容草稿</button>}<button type="button" disabled={busy==='load'} onClick={()=>void load()}>刷新</button></div></div>
      <div className="activity-operations-list">{cards.map(item=><button type="button" className={selected===item.code?'is-selected':''} key={item.code} onClick={()=>edit(item)}><strong>{item.title}</strong><span>{status(item.status)} · 顺序 {item.priority}</span><small>{date(item.validFrom)}—{date(item.validUntil)}</small></button>)}</div>
      {draft&&canManage&&<details className="activity-draft-editor" open><summary>{selected?'编辑首页内容草稿':'填写新内容'}</summary><form onSubmit={event=>void save(event)}>
        <fieldset><legend>展示内容</legend>
          <label>内容编号<input required disabled={Boolean(selected)} minLength={3} maxLength={64} value={draft.code} onChange={event=>update('code',event.target.value)} placeholder="mbox-story-1999" /></label>
          <label>内容类型<select value={draft.type} onChange={event=>update('type',event.target.value as CardType)}><option value="article">品牌故事</option><option value="show">演出内容</option><option value="activity">活动内容</option><option value="benefit">会员内容</option><option value="presale">首页弹窗推广 / 预售内容</option><option value="return_offer">回访内容</option></select><small>发布“首页弹窗推广 / 预售内容”后，小程序首页会在会员邀请关闭后展示排序最靠前且仍在有效期内的一条；暂停即可立即撤下。</small></label>
          <label className="wide">标题<input required minLength={2} maxLength={120} value={draft.title} onChange={event=>update('title',event.target.value)} /></label>
          <label className="wide">摘要<textarea required rows={3} minLength={2} maxLength={400} value={draft.summary} onChange={event=>update('summary',event.target.value)} /></label>
          <label className="wide">图片地址<input value={draft.imageUrl} onChange={event=>update('imageUrl',event.target.value)} placeholder="上传后会自动填入站内地址；也可填写已核对的 HTTPS 地址" /></label>
          <div className="wide"><MediaAssetPicker api={api} purpose="home_content" value={draft.imageUrl} onChange={(imageUrl)=>update('imageUrl',imageUrl)} label="上传首页图片" /></div>
        </fieldset>
        <fieldset><legend>操作与排期</legend>
          <label>操作文案<input required maxLength={20} value={draft.ctaLabel} onChange={event=>update('ctaLabel',event.target.value)} /></label>
          <label>打开页面<select value={draft.targetPath} onChange={event=>update('targetPath',event.target.value)}><option value="/pages/home/index">仅在首页阅读</option><option value="/pages/community/index">超嗨活动</option><option value="/pages/reservations/index">预约</option><option value="/pages/order/index">菜单</option><option value="/pages/profile/index">我的会员</option></select></label>
          <label>展示对象<select value={draft.visibility} onChange={event=>update('visibility',event.target.value as Draft['visibility'])}><option value="public">所有顾客</option><option value="member">仅会员</option></select></label>
          <label>展示顺序<input required type="number" min="0" max="10000" value={draft.priority} onChange={event=>update('priority',event.target.value)} /></label>
          <label>开始展示<input required type="datetime-local" value={draft.validFrom} onChange={event=>update('validFrom',event.target.value)} /></label>
          <label>结束展示<input required type="datetime-local" value={draft.validUntil} onChange={event=>update('validUntil',event.target.value)} /></label>
          <label className="wide">编辑原因<input required minLength={2} maxLength={500} value={draft.reason} onChange={event=>update('reason',event.target.value)} placeholder="说明本次内容与排期" /></label>
        </fieldset>
        <div className="activity-draft-actions"><button type="submit" disabled={busy==='save'}>{selected?'保存草稿':'建立草稿'}</button></div>
      </form></details>}
      <div className="activity-operations-list">{cards.map(item=><article key={`action-${item.code}`} className="home-content-action-row"><div><strong>{item.title}</strong><small>{status(item.status)} · {item.visibility==='member'?'仅会员':'所有顾客'}</small></div><div>{item.status==='published'&&canPublish&&<button type="button" onClick={()=>void action(item,'pause')}>暂停展示</button>}{['draft','paused'].includes(item.status)&&canPublish&&<button type="button" onClick={()=>void action(item,'publish')}>发布</button>}</div></article>)}</div>
      {supportDraft&&canManage&&<details className="activity-draft-editor"><summary>顾客联系门店</summary><form onSubmit={event=>void saveSupport(event)}><fieldset><legend>电话与企业微信</legend><label>顾客端状态<select value={supportDraft.rolloutState} onChange={event=>updateSupport('rolloutState',event.target.value as SupportDraft['rolloutState'])}><option value="disabled">暂不展示</option><option value="pilot">试运行展示</option><option value="enabled">正式展示</option></select><small>启用后，“我的”页面显示门店电话和企业微信二维码；不填二维码时仅显示电话。</small></label><label>电话名称<input required minLength={2} maxLength={40} value={supportDraft.phoneLabel} onChange={event=>updateSupport('phoneLabel',event.target.value)} placeholder="门店电话" /></label><label>门店联系电话<input required minLength={6} maxLength={31} value={supportDraft.phone} onChange={event=>updateSupport('phone',event.target.value)} placeholder="如：021-12345678" /></label><label>企业微信名称<input required minLength={2} maxLength={40} value={supportDraft.wecomName} onChange={event=>updateSupport('wecomName',event.target.value)} placeholder="M-BOX 企业微信" /></label><label className="wide">企业微信二维码地址<input value={supportDraft.wecomQrImageUrl} onChange={event=>updateSupport('wecomQrImageUrl',event.target.value)} placeholder="HTTPS 图片地址或站内图片路径" /></label><label className="wide">修改原因<input required minLength={2} maxLength={240} value={supportDraft.reason} onChange={event=>updateSupport('reason',event.target.value)} placeholder="例如：更新值班联系电话和企业微信二维码" /></label></fieldset><p className="recommendation-policy-boundary">小程序会调用原生电话能力；企业微信先展示门店审核后的二维码。直接聊天入口需在微信官方能力完成配置后再接入，不能用任意外链替代。</p><div className="activity-draft-actions"><button type="submit" disabled={busy==='support'}>保存门店联系信息</button></div></form></details>}
    </>}
  </section>
}

function emptyDraft():Draft{const start=new Date();start.setSeconds(0,0);const end=new Date(start.getTime()+30*86400000);return{code:'',type:'article',title:'',summary:'',imageUrl:'',ctaLabel:'查看内容',targetPath:'/pages/home/index',priority:'100',visibility:'public',validFrom:local(start),validUntil:local(end),reason:''}}
function toSupportDraft(value:unknown):SupportDraft{const source=(value&&typeof value==='object'?value:{}) as Partial<SupportContactView>;const contact=source.contact;return{rolloutState:source.rolloutState==='enabled'||source.rolloutState==='pilot'?'enabled':'disabled',phone:contact?.phone??'',phoneLabel:contact?.phoneLabel??'门店电话',wecomName:contact?.wecomName??'M-BOX 企业微信',wecomQrImageUrl:contact?.wecomQrImageUrl??'',reason:'更新顾客端门店联系信息'}}
function toDraft(value:CardView):Draft{return{code:value.code,type:value.type,title:value.title,summary:value.summary,imageUrl:value.imageUrl??'',ctaLabel:value.ctaLabel,targetPath:value.targetPath,priority:String(value.priority),visibility:value.visibility==='member'?'member':'public',validFrom:local(new Date(value.validFrom)),validUntil:local(new Date(value.validUntil)),reason:''}}
function payload(value:Draft){return{code:value.code.trim(),type:value.type,title:value.title.trim(),summary:value.summary.trim(),imageUrl:value.imageUrl.trim()||null,ctaLabel:value.ctaLabel.trim(),targetPath:value.targetPath,priority:Number(value.priority),visibility:value.visibility,audienceMemberLevels:[],audienceLifecycleStages:[],validFrom:new Date(value.validFrom).toISOString(),validUntil:new Date(value.validUntil).toISOString(),reason:value.reason.trim()}}
function cardList(value:unknown){if(!Array.isArray(value))throw new Error('首页内容列表格式无法识别');return value.map(card)}
function card(value:unknown):CardView{if(typeof value!=='object'||value===null||Array.isArray(value))throw new Error('首页内容格式无法识别');const item=value as Record<string,unknown>;return{code:String(item.code),type:item.type as CardType,title:String(item.title),summary:String(item.summary),imageUrl:typeof item.imageUrl==='string'?item.imageUrl:null,ctaLabel:String(item.ctaLabel),targetPath:String(item.targetPath),priority:Number(item.priority),visibility:item.visibility as CardView['visibility'],audienceMemberLevels:Array.isArray(item.audienceMemberLevels)?item.audienceMemberLevels.map(String):[],audienceLifecycleStages:Array.isArray(item.audienceLifecycleStages)?item.audienceLifecycleStages.map(String):[],validFrom:String(item.validFrom),validUntil:String(item.validUntil),status:item.status as CardStatus,updatedAt:String(item.updatedAt)}}
function local(value:Date){const localValue=new Date(value.getTime()-value.getTimezoneOffset()*60000);return localValue.toISOString().slice(0,16)}
function key(scope:string){return`${scope}-${crypto.randomUUID()}`}
function date(value:string){return new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
function status(value:CardStatus){return({draft:'草稿',published:'展示中',paused:'已暂停',retired:'已退役'} as const)[value]}
function message(error:unknown,fallback:string){return error instanceof Error?error.message:fallback}
