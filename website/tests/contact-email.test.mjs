import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pages from '../data/pages.json' with {type:'json'};

const email='<a class="contact-email" href="mailto:shmbox@qq.com">shmbox@qq.com</a>';
const langs=['zh','en','ru','ja','ko','fr','de'];

test('contact email sits directly under each displayed phone number',()=>{
 for(const lang of langs){
  const home=pages['/'+lang+'/'];
  assert.equal(home.split(email).length-1,3,lang+' home');
  assert.ok(home.includes('<div class="footer-contact"><a href="tel:+8617621392152">+86 176 2139 2152 ↗</a>'+email), lang+' footer');
  assert.ok(home.includes('<a class="phone" href="tel:+8617621392152">+86 176 2139 2152</a>'+email), lang+' visit');
  assert.match(home, new RegExp('class="button gold event-link" href="tel:\\+8617621392152">[\\s\\S]*?</a>'+email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal(pages['/'+lang+'/menu/'].split(email).length-1,1,lang+' menu');
  for(const file of [`public/${lang}/reserve/index.html`,`aliyun/public-overrides/${lang}/reserve/index.html`]){
   const html=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
   assert.equal(html.split(email).length-1,2,file);
   assert.match(html, /class="text-link" href="tel:\+8617621392152">[^<]*\+86 176 2139 2152 ↗<\/a><a class="contact-email"/);
  }
 }
});
