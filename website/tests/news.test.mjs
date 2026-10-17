import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const langs=['zh','en','ru','ja','ko','fr','de'];
const origin='https://www.shmbox.com';
test('news is available as static seven-language HTML with matching alternates and no invented event dates',async()=>{
 for(const lang of langs) for(const suffix of ['news/','news/luckin-daka-show/']){
  const html=await readFile(new URL(`../public/${lang}/${suffix}index.html`,import.meta.url),'utf8');
  assert.ok(html.includes(`<link rel="canonical" href="${origin}/${lang}/${suffix}">`));
  assert.ok(html.includes('index,follow,max-image-preview:large'));
  for(const alternate of langs){
   assert.ok(html.includes(`hreflang="${alternate}" href="${origin}/${alternate}/${suffix}"`));
   assert.ok(html.includes(`value="/${alternate}/${suffix}"`));
  }
  const schema=JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.equal(schema.inLanguage,lang);
  assert.ok(!html.includes('startDate'));
  if(suffix.includes('luckin')){
   assert.equal(schema['@type'],'Article');
   assert.equal(schema.datePublished,'2026-10-17');
   assert.ok(schema.articleBody.length>150);
   assert.ok(html.includes('preload="none"'));
   assert.ok(!html.includes('autoplay'));
   assert.equal(schema.video.contentUrl,origin+'/assets/luckin-daka-show-mbox.mp4');
  }
 }
});
test('news URLs are unique in the sitemap and discoverable without JavaScript from every home',async()=>{
 const xml=await readFile(new URL('../aliyun/public-overrides/sitemap.xml',import.meta.url),'utf8');
 const urls=[...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(x=>x[1]);
 assert.equal(urls.length,new Set(urls).size);
 const pages=JSON.parse(await readFile(new URL('../data/pages.json',import.meta.url),'utf8'));
 for(const lang of langs){
  assert.ok(urls.includes(`${origin}/${lang}/news/`));
  assert.ok(urls.includes(`${origin}/${lang}/news/luckin-daka-show/`));
  assert.equal((pages[`/${lang}/`].match(/id="news"/g)||[]).length,1);
  assert.ok(pages[`/${lang}/`].includes(`href="/${lang}/news/luckin-daka-show/"`));
 }
});
