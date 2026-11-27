import {test as base,expect} from '@playwright/test'

export const test = base.extend<{enableMinimum:()=>Promise<void>}>({
  enableMinimum: async ({page},use) => {
    const path='/api/table-management/dining-day-rules'
    const read=async()=>(await (await page.request.get(path)).json()).data
    const set=async(minimum:boolean)=>{
      const current=await read()
      const response=await page.request.post(path,{data:{...current,minimum},headers:{'idempotency-key':crypto.randomUUID()}})
      expect(response.ok(),await response.text()).toBe(true)
    }
    let changed=false
    try {
      await use(async()=>{
        if(!(await read()).minimum){await set(true);changed=true;await page.reload()}
      })
    } finally {if(changed)await set(false)}
  },
})
