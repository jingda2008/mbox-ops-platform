import {useEffect,useState} from 'react'
import {hasNewStaffPage} from './staff-actions/staff-page-version'

/** Never reload automatically: a cashier may be entering a real receipt. */
export function CashierPageUpdateNotice({blocked}:{blocked:boolean}) {
  const [available,setAvailable]=useState(false)
  useEffect(()=>{
    let active=true,checking=false
    const check=async()=>{
      if(checking||document.visibilityState==='hidden')return
      checking=true
      try{const newer=await hasNewStaffPage();if(active&&newer)setAvailable(true)}finally{checking=false}
    }
    void check()
    const timer=window.setInterval(()=>void check(),60_000)
    const visible=()=>{void check()}
    window.addEventListener('focus',visible)
    document.addEventListener('visibilitychange',visible)
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible)}
  },[])
  if(!available)return null
  return <section className="cashier-guidance" aria-label="收银页面更新" role="status">
    <strong>有新版收银页面</strong>
    <p>当前页面可能缺少新的收款入口。更新会清空未提交的输入，请先完成当前操作。</p>
    {blocked&&<p>有操作正在提交或结果待核对，请先恢复原操作，核对完成后再更新。</p>}
    <button type="button" className="cashier-secondary-action" disabled={blocked} onClick={()=>{if(!blocked)window.location.reload()}}>更新收银页面</button>
  </section>
}
