import {useEffect,useState} from 'react'

export function ScreenFullscreenButton(){
  const [active,setActive]=useState(false),[failed,setFailed]=useState(false)
  useEffect(()=>{const changed=()=>setActive(!!document.fullscreenElement);changed();document.addEventListener('fullscreenchange',changed);return()=>document.removeEventListener('fullscreenchange',changed)},[])
  if(typeof document==='undefined'||!document.fullscreenEnabled)return null
  return <button type="button" title={failed?'浏览器暂时无法进入全屏，可使用浏览器菜单重试':undefined} onClick={()=>{
    setFailed(false)
    const action=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen()
    void action.catch(()=>setFailed(true))
  }}>{active?'退出全屏':failed?'重试全屏':'全屏'}</button>
}
