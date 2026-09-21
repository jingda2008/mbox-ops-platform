export type ThreeScreenMode='bar'|'kitchen'|'pickup'
export function threeScreenMode(pathname:string,search:string):ThreeScreenMode|null {
  if(pathname!=='/staff/fulfillment')return null
  const mode=new URLSearchParams(search).get('screen')
  return mode==='bar'||mode==='kitchen'||mode==='pickup'?mode:null
}
