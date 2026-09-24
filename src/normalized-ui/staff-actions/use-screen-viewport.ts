import {useLayoutEffect,useState,type CSSProperties} from 'react'

/** An overlay keyboard can shrink the visual viewport without changing 100dvh.
 * Ignore pinch zoom so magnification remains under the operator's control. */
export function useScreenViewport(){
  const [viewport,setViewport]=useState({height:window.innerHeight,top:0})
  useLayoutEffect(()=>{
    const visual=window.visualViewport
    const update=()=>{if(visual&&Math.abs(visual.scale-1)>.01)return
      setViewport({height:visual?.height??window.innerHeight,top:visual?.offsetTop??0})}
    update();window.addEventListener('resize',update);visual?.addEventListener('resize',update);visual?.addEventListener('scroll',update)
    return()=>{window.removeEventListener('resize',update);visual?.removeEventListener('resize',update);visual?.removeEventListener('scroll',update)}
  },[])
  return {style:{'--staff-screen-height':`${viewport.height}px`,'--staff-screen-top':`${viewport.top}px`} as CSSProperties,short:viewport.height<420}
}
