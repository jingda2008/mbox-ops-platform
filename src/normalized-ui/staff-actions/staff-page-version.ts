/** A failed version check must not discard the current operating queue. */
export async function hasNewStaffPage():Promise<boolean>{
  const current=document.querySelector<HTMLMetaElement>('meta[name="mbox-build-commit"]')?.content
  if(!current||! /^[0-9a-f]{40}$/.test(current))return false
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000)
  try{
    const response=await fetch(window.location.href,{cache:'no-store',signal:controller.signal})
    if(!response.ok||!response.headers.get('content-type')?.includes('text/html'))return false
    const html=new DOMParser().parseFromString(await response.text(),'text/html')
    const next=html.querySelector<HTMLMetaElement>('meta[name="mbox-build-commit"]')?.content
    return !!next&&/^[0-9a-f]{40}$/.test(next)&&next!==current
  }catch{return false}
  finally{clearTimeout(timer)}
}
