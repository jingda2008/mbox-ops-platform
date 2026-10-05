import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile,mkdir} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {chromium} from 'playwright'
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'artifacts/requirements-v9-20260916/detail-popup')
async function css(file){let s=await readFile(file,'utf8');for(const m of [...s.matchAll(/@import\s+"([^"]+)";/g)])s=s.replace(m[0],await css(resolve(dirname(file),m[1])));return s}
const reset='html,body{margin:0}page,view,scroll-view{display:block}page{width:100%;min-height:100vh}button{box-sizing:border-box;font-family:inherit}scroll-view{overflow-y:auto}image{display:block;object-fit:contain}text{overflow-wrap:anywhere}'
const sizes=[[320,568],[360,640],[390,844],[540,720],[720,540]]
const scaled=(s,w)=>s.replace(/(-?[\d.]+)rpx\b/g,(_,n)=>`${Number(n)*w/750}px`)
test('long bundle keeps full-height hero, reachable close and footer while only body scrolls',async()=>{
 const browser=await chromium.launch({headless:true});await mkdir(out,{recursive:true})
 try{const page=await browser.newPage(),style=await css(root+'/miniprogram/app.wxss')+await css(root+'/miniprogram/pages/order/index.wxss')
 for(const [width,height] of sizes){await page.setViewportSize({width,height});await page.setContent(`<style>${reset}${scaled(style,width)}</style><page><view class="page order-page"><view class="product-detail-mask sheet-mask"><view class="product-detail-sheet is-bundle"><view class="product-detail-header"><text>套餐详情</text><button class="product-detail-close">关闭</button></view><scroll-view class="product-detail-scroll"><view class="product-detail-hero"><image></image></view><view class="product-detail-content"><text class="product-detail-description">${'很长的套餐说明、选项与组成。'.repeat(100)}</text><view class="product-detail-component"><text>${'完整显示的组成名称'.repeat(10)}</text><text>×1</text></view></view></scroll-view><view class="product-detail-footer"><view><text>当前售价</text><text>¥228</text></view><button>确认选择并加入</button></view></view></view></view></page>`)
 const close=page.locator('.product-detail-close'),hero=page.locator('.product-detail-hero'),footer=page.locator('.product-detail-footer'),scroll=page.locator('scroll-view'),before=await close.boundingBox(),image=await hero.boundingBox();assert.ok(before.height>=44&&before.x>=0&&before.x+before.width<=width,'close touch area must be inside viewport');assert.ok(image.height>=width*470/750-1,'bundle image must retain normal hero size');assert.ok((await footer.boundingBox()).y+(await footer.boundingBox()).height<=height+1,'footer inside viewport')
 await scroll.evaluate(n=>n.scrollTop=n.scrollHeight);assert.ok(await scroll.evaluate(n=>n.scrollTop>0),'long content scrolls');assert.deepEqual(await close.boundingBox(),before,'header remains fixed within sheet');assert.equal((await hero.boundingBox()).height,image.height,'scrolling never shrinks image');assert.ok(await close.evaluate(n=>{const r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n}),'close must be topmost and clickable');assert.ok(await page.locator('.product-detail-component text').first().evaluate(n=>n.scrollWidth<=n.clientWidth+1),'long component names wrap');
 }
 }finally{await browser.close()}
})
test('posters share a stable 4:3 frame and keep close reachable across image ratios',async()=>{
 const browser=await chromium.launch({headless:true})
 try {
  const page=await browser.newPage(),style=await css(root+'/miniprogram/components/launch-popup/index.wxss')
  for(const [width,height] of [...sizes,[720,360]]) for(const ratio of [.5,.75,1,4/3]) {
   const posterWidth=Math.min(width*620/750,480),posterHeight=posterWidth*.75
   await page.setViewportSize({width,height})
   await page.setContent(`<style>${reset}${scaled(style,width)}</style><scroll-view class="launch-popup-mask"><view class="launch-popup-stage"><view class="launch-popup-shell"><view class="launch-popup-swiper" style="height:${posterHeight}px"><view class="launch-popup-poster"><view class="launch-popup-hero"><image class="launch-popup-image" style="width:${ratio < .75 ? .75/ratio*100 : 100}%;height:${ratio > .75 ? ratio/.75*100 : 100}%"></image><view class="launch-popup-heading"><text class="launch-popup-title">今日推荐</text></view></view></view></view><view class="launch-popup-pagination"><view class="launch-popup-dot is-current"></view><view class="launch-popup-dot"></view></view><button class="launch-popup-close"><view class="launch-popup-close-ring"></view><view class="launch-popup-close-line launch-popup-close-line--first"></view><view class="launch-popup-close-line launch-popup-close-line--second"></view></button></view></view></scroll-view>`)
   const hero=await page.locator('.launch-popup-hero').boundingBox()
   assert.ok(Math.abs(hero.width-posterWidth)<1,'all poster ratios use the same width')
   assert.ok(Math.abs(hero.height-posterHeight)<1,'frame height stays fixed across image ratios')
   assert.ok(hero.y>=0&&hero.x>=0&&hero.x+hero.width<=width+1,'poster begins inside viewport')
   const picture=await page.locator('.launch-popup-image').boundingBox()
   assert.ok(Math.abs(picture.height/picture.width-ratio)<.01,'cropped images retain original proportions')
   assert.ok(picture.x<=hero.x+1&&picture.y<=hero.y+1&&picture.x+picture.width>=hero.x+hero.width-1&&picture.y+picture.height>=hero.y+hero.height-1,'image fills the frame without gaps')
   const close=page.locator('.launch-popup-close')
   await close.scrollIntoViewIfNeeded()
   const b=await close.boundingBox()
   assert.ok(b.height>=44&&b.width>=44&&b.x>=0&&b.x+b.width<=width+1&&b.y>=0&&b.y+b.height<=height+1,'close remains reachable by scrolling tall posters')
   assert.ok(await page.locator('.launch-popup-close-ring').evaluate(n=>parseFloat(getComputedStyle(n).borderTopLeftRadius)>=22),'close is circular')
   assert.ok(await close.evaluate(n=>{const r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n}),'close is clickable')
   assert.ok(await page.locator('.launch-popup-swiper').evaluate(n=>{const s=getComputedStyle(n);return s.backgroundColor==='rgba(0, 0, 0, 0)'&&parseFloat(s.borderTopWidth)===0&&parseFloat(s.borderTopLeftRadius)===0}),'no surrounding card or frame')
   assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth+1),'no horizontal overflow')
   if(process.env.MBOX_POPUP_EVIDENCE_DIR && ratio===.75 && ((width===390&&height===844)||(width===720&&height===360))) {
    await mkdir(process.env.MBOX_POPUP_EVIDENCE_DIR,{recursive:true})
    await page.screenshot({path:resolve(process.env.MBOX_POPUP_EVIDENCE_DIR,`poster-layout-${width}x${height}.png`)})
   }
  }
 } finally {await browser.close()}
})
