import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, LoaderCircle } from 'lucide-react'
import type { NormalizedApiClient } from '../normalized-api'

const MAX_IMAGE_BYTES = 200 * 1024

type Purpose = 'community_activity' | 'home_content' | 'menu' | 'performer' | 'support_contact'
interface Asset { publicId:string;purpose:Purpose;originalFileName:string;mimeType:string;byteLength:number;publicUrl:string;staffUrl:string;createdAt:string }

export function MediaAssetPicker({ api, purpose, value, onChange, label = '上传并选择图片' }: {
  api: NormalizedApiClient
  purpose: Purpose
  value: string
  onChange(value: string): void
  label?: string
}) {
  const [assets,setAssets] = useState<Asset[]>([])
  const [open,setOpen] = useState(false)
  const [busy,setBusy] = useState(false)
  const [message,setMessage] = useState('')
  const [previewFailed,setPreviewFailed] = useState(false)
  const [nextCursor,setNextCursor] = useState<string|null>(null)
  const loadVersion=useRef(0)
  // A selected private asset has a known staff URL; opening the editor must
  // not download the entire library just to display one existing selection.
  const privateId=value.match(/^\/api\/public\/media-assets\/(MA[A-F0-9]{32})$/)?.[1]
  const previewUrl=privateId?`/api/staff/media-assets/${privateId}?size=thumbnail`:value
  useEffect(()=>setPreviewFailed(false),[previewUrl])
  const load = useCallback(async(before?:string)=>{
    const version=++loadVersion.current
    setBusy(true)
    try {
      const params=new URLSearchParams({purpose,limit:'12',...(before?{before}:{})})
      const result = await api.getEndpoint<{data:unknown;meta?:{nextCursor?:string|null}}>(`/api/staff/media-assets?${params}`)
      if(version!==loadVersion.current)return
      const items=readAssets(result.data).filter(asset=>asset.purpose===purpose)
      setAssets(current=>before?[...current,...items.filter(item=>!current.some(old=>old.publicId===item.publicId))]:items)
      setNextCursor(result.meta?.nextCursor??null)
      setMessage('')
    } catch(error) { if(version===loadVersion.current)setMessage(error instanceof Error ? error.message : '图片库暂时无法读取') }
    finally { if(version===loadVersion.current)setBusy(false) }
  },[api,purpose])
  useEffect(()=>{
    setAssets([]);setNextCursor(null)
    if(open)void load()
    return()=>{loadVersion.current++}
  },[load,open])
  async function upload(file: File) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { setMessage('请使用 JPG、PNG 或 WebP 图片'); return }
    if (file.size > MAX_IMAGE_BYTES) { setMessage('请先把图片压缩到 200KB 以内再上传'); return }
    const version=loadVersion.current
    setBusy(true);setMessage('')
    try {
      const base64 = await readBase64(file)
      const result = await api.postEndpoint<unknown>('/api/staff/media-assets', {
        purpose,fileName:file.name,mimeType:file.type,base64,
      }, { idempotencyKey: `media-upload-${crypto.randomUUID()}` })
      if(version!==loadVersion.current)return
      const asset = readAsset(result)
      setAssets((current)=>[asset,...current.filter((item)=>item.publicId!==asset.publicId)])
      onChange(asset.publicUrl);setMessage('图片已上传并选中；保存当前内容后才会正式绑定。')
    } catch(error) { if(version===loadVersion.current)setMessage(error instanceof Error ? error.message : '图片没有上传') }
    finally { if(version===loadVersion.current)setBusy(false) }
  }
  return <div className="media-asset-picker">
    <div className="media-asset-picker-actions">
      <button type="button" onClick={()=>setOpen((current)=>!current)} aria-expanded={open}><ImagePlus size={16} />{label}</button>
      {value !== '' && <button type="button" className="is-text" onClick={()=>onChange('')}>移除已选图片</button>}
    </div>
    {value !== '' && <figure><>{previewUrl&&!previewFailed?<img src={previewUrl} alt="已选图片预览" decoding="async" onError={()=>setPreviewFailed(true)}/>:<p role="status">图片预览未读取成功，已保存地址不会被清除。</p>}</><figcaption>当前选择；更换图片后请保存商品或内容，使修改生效。</figcaption></figure>}
    {open && <div className="media-asset-library">
      <label className="media-asset-upload"><span>从电脑或手机选择图片（JPG、PNG、WebP，最大 200KB）</span><input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event)=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void upload(file)}} /></label>
      {message !== '' && <p role="status">{message}</p>}
      {busy && <p><LoaderCircle className="is-spinning" size={16} />正在处理图片</p>}
      {!busy && assets.length===0 && <p>还没有可用图片。上传后会在这里保留，方便活动和首页内容复用。</p>}
      <div className="media-asset-grid">{assets.map((asset)=><button type="button" key={asset.publicId} className={value===asset.publicUrl?'is-selected':''} onClick={()=>onChange(asset.publicUrl)}><img src={`${asset.staffUrl}?size=thumbnail`} alt="" loading="lazy" decoding="async" width="160" height="100" /><span>{asset.originalFileName}</span><small>{Math.ceil(asset.byteLength/1024)} KB · {new Date(asset.createdAt).toLocaleDateString('zh-CN')}</small></button>)}</div>
      {nextCursor && <button type="button" disabled={busy} onClick={()=>void load(nextCursor)}>加载更多图片</button>}
    </div>}
  </div>
}

function readBase64(file: File): Promise<string> { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('图片读取失败'));reader.onload=()=>{const value=typeof reader.result==='string'?reader.result:'';const separator=value.indexOf(',');if(separator<0)reject(new Error('图片格式无法读取'));else resolve(value.slice(separator+1))};reader.readAsDataURL(file)}) }
function readAssets(value:unknown):Asset[]{return Array.isArray(value)?value.flatMap((item)=>{try{return[readAsset(item)]}catch{return[]}}):[]}
function readAsset(value:unknown):Asset{if(typeof value!=='object'||value===null||Array.isArray(value))throw new Error('图片库返回格式无效');const item=value as Record<string,unknown>;if(typeof item.publicId!=='string'||typeof item.publicUrl!=='string'||typeof item.staffUrl!=='string'||typeof item.originalFileName!=='string'||typeof item.mimeType!=='string'||typeof item.byteLength!=='number'||typeof item.createdAt!=='string'||!isPurpose(item.purpose))throw new Error('图片库返回格式无效');return{publicId:item.publicId,publicUrl:item.publicUrl,staffUrl:item.staffUrl,originalFileName:item.originalFileName,mimeType:item.mimeType,byteLength:item.byteLength,createdAt:item.createdAt,purpose:item.purpose}}
function isPurpose(value:unknown):value is Purpose{return value==='community_activity'||value==='home_content'||value==='menu'||value==='performer'||value==='support_contact'}
