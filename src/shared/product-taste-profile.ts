export interface ProductTasteProfile { acidity:number|null; sweetness:number|null }

/** Store-rated sensory scale, not sugar content or a measured pH. */
export function productTasteProfile(value:unknown):ProductTasteProfile|null {
  if(value===undefined||value===null)return null
  if(typeof value!=='object'||Array.isArray(value))throw new TypeError('口味评分必须是酸度、甜度对象')
  const record=value as Record<string,unknown>
  if(Object.keys(record).some(key=>!['acidity','sweetness'].includes(key)))throw new TypeError('口味评分包含不支持的字段')
  const level=(key:'acidity'|'sweetness')=>{
    const input=record[key]
    if(input===null||input===undefined)return null
    if(typeof input!=='number'||!Number.isInteger(input)||input<0||input>5)throw new TypeError(`${key==='acidity'?'酸度':'甜度'}须为0至5的整数，未评价请留空`)
    return input
  }
  return {acidity:level('acidity'),sweetness:level('sweetness')}
}

export function publicProductTasteProfile(value:unknown):ProductTasteProfile|null {
  try{return productTasteProfile(value)}catch{return null}
}
