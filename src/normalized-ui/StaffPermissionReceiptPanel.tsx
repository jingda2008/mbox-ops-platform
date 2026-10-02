import { useState } from 'react'
import type { NormalizedApiClient } from '../normalized-api'
import type { StaffPermissionDeploymentResult } from '../shared/normalized-contracts'
import { permissionReceiptIntents, StaffPermissionRecovery } from './staff-permission-recovery'

/** No form and no new requests: this surface only recovers an existing original intent. */
export function StaffPermissionReceiptPanel({api,employeeId}:{api:NormalizedApiClient;employeeId:string}) {
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  let intents: ReturnType<typeof permissionReceiptIntents>=[]
  try { intents=permissionReceiptIntents(employeeId,localStorage) } catch { return null }
  const original=intents[0]
  if (!original && !notice) return null
  const recover=async()=>{
    if (!original || busy) return
    setBusy(true)
    try {
      const recovery=new StaffPermissionRecovery(original.scopeKey,employeeId,localStorage)
      await recovery.execute(null,intent=>api.postEndpoint<StaffPermissionDeploymentResult>('/api/staff-access/deploy',{...intent.body,receiptOnly:true},{idempotencyKey:intent.key,timeoutMs:20_000}))
      setNotice('原权限发布已确认，原请求已解除。当前账号不会恢复已移交的管理权限。')
    } catch { setNotice('尚未确认原权限发布，请保留原请求并再次核对。') }
    finally { setBusy(false) }
  }
  return <section className="staff-access-state" role="status"><strong>权限移交结果</strong><p>{notice || '有一项原权限发布待核对。这里只读取原回执。'}</p>{original && <button disabled={busy} onClick={()=>void recover()}>{busy?'正在核对':'核对原权限发布'}</button>}</section>
}
