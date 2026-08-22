import { useCallback, useEffect, useState } from 'react'
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
  const load = useCallback(async()=>{
    setBusy(true)
    try {
      const result = await api.getEndpoint<{data:unknown}>('/api/staff/media-assets')
      setAssets(readAssets(result.data).filter((asset)=>asset.purpose===purpose))
    } catch(error) { setMessage(error instanceof Error ? error.message : '图片库暂时无法读取') }
    finally { setBusy(false) }
  },[api,purpose])
  useEffect(()=>{ if(open || value.startsWith('/api/public/media-assets/')) void load() },[load,open,value])
  async function upload(file: File) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { setMessage('请使用 JPG、PNG 或 WebP 图片'); return }
    if (file.size > MAX_IMAGE_BYTES) { setMessage('请先把图片压缩到 200KB 以内再上传'); return }
    setBusy(true);setMessage('')
    try {
      const base64 = await readBase64(file)
      const result = await api.postEndpoint<{data:unknown}>('/api/staff/media-assets', {
        purpose,fileName:file.name,mimeType:file.type,base64,
      }, { idempotencyKey: `media-upload-${crypto.randomUUID()}` })
      const asset = readAsset(result.data)
      setAssets((current)=>[asset,...current.filter((item)=>item.publicId!==asset.publicId)])
      onChange(asset.publicUrl);setMessage('图片已上传并选中；保存草稿后才会被活动或首页引用。')
    } catch(error) { setMessage(error instanceof Error ? error.message : '图片没有上传') }
    finally { setBusy(false) }
  }
  return <div className="media-asset-picker">
    <div className="media-asset-picker-actions">
      <button type="button" onClick={()=>setOpen((current)=>!current)} aria-expanded={open}><ImagePlus size={16} />{label}</button>
      {value !== '' && <button type="button" className="is-text" onClick={()=>onChange('')}>移除已选图片</button>}
    </div>
    {value !== '' && <figure><img src={assets.find((asset)=>asset.publicUrl===value)?.staffUrl ?? value} alt="已选图片预览" /><figcaption>当前选择：保存草稿后才会绑定到内容。</figcaption></figure>}
    {open && <div className="media-asset-library">
      <label className="media-asset-upload"><span>从电脑或手机选择图片（JPG、PNG、WebP，最大 200KB）</span><input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event)=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void upload(file)}} /></label>
      {message !== '' && <p role="status">{message}</p>}
      {busy && <p><LoaderCircle className="is-spinning" size={16} />正在处理图片</p>}
      {!busy && assets.length===0 && <p>还没有可用图片。上传后会在这里保留，方便活动和首页内容复用。</p>}
      <div className="media-asset-grid">{assets.map((asset)=><button type="button" key={asset.publicId} className={value===asset.publicUrl?'is-selected':''} onClick={()=>onChange(asset.publicUrl)}><img src={asset.staffUrl} alt="" /><span>{asset.originalFileName}</span><small>{Math.ceil(asset.byteLength/1024)} KB · {new Date(asset.createdAt).toLocaleDateString('zh-CN')}</small></button>)}</div>
    </div>}
  </div>
}

function readBase64(file: File): Promise<string> { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('图片读取失败'));reader.onload=()=>{const value=typeof reader.result==='string'?reader.result:'';const separator=value.indexOf(',');if(separator<0)reject(new Error('图片格式无法读取'));else resolve(value.slice(separator+1))};reader.readAsDataURL(file)}) }
function readAssets(value:unknown):Asset[]{return Array.isArray(value)?value.flatMap((item)=>{try{return[readAsset(item)]}catch{return[]}}):[]}
function readAsset(value:unknown):Asset{if(typeof value!=='object'||value===null||Array.isArray(value))throw new Error('图片库返回格式无效');const item=value as Record<string,unknown>;if(typeof item.publicId!=='string'||typeof item.publicUrl!=='string'||typeof item.staffUrl!=='string'||typeof item.originalFileName!=='string'||typeof item.mimeType!=='string'||typeof item.byteLength!=='number'||typeof item.createdAt!=='string'||!isPurpose(item.purpose))throw new Error('图片库返回格式无效');return{publicId:item.publicId,publicUrl:item.publicUrl,staffUrl:item.staffUrl,originalFileName:item.originalFileName,mimeType:item.mimeType,byteLength:item.byteLength,createdAt:item.createdAt,purpose:item.purpose}}
function isPurpose(value:unknown):value is Purpose{return value==='community_activity'||value==='home_content'||value==='menu'||value==='performer'||value==='support_contact'}
