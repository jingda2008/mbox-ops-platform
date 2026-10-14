import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalDomain} from '../lib/mbox/canonical-domain.js';
const old='https://mbox-shanghai-preview-20261013.jingda2008.chatgpt.site';
test('only known legacy marketing routes redirect to corresponding public pages without query secrets',()=>{
 for(const lang of ['zh','en','ru','ja','ko','fr','de']) for(const [path,target] of [[`/${lang}`,`/${lang}/`],[`/${lang}/`,`/${lang}/`],[`/${lang}/index.html`,`/${lang}/`],[`/${lang}/menu`,`/${lang}/menu/`],[`/${lang}/menu/`, `/${lang}/menu/`],[`/${lang}/menu/index.html`,`/${lang}/menu/`]]) for(const method of ['GET','HEAD']){const r=canonicalDomain(new Request(old+path+'?token=private',{method}));assert.equal(r.status,308);assert.equal(r.headers.get('location'),'https://www.shmbox.com'+target)}
});
test('reservation recovery, assets, staff endpoints and writes are never redirected',()=>{
 for(const path of ['/zh/reserve/','/en/reserve/index.html','/api/public/reservation/session','/api/public/reservations/reservation-a','/booking.js','/staff','/unknown','/zh/menu/extra'])for(const method of ['GET','POST','DELETE'])assert.equal(canonicalDomain(new Request(old+path,{method})),null);
 assert.equal(canonicalDomain(new Request('https://www.shmbox.com/zh/')),null);
 assert.equal(canonicalDomain(new Request(old+'/zh/',{method:'POST'})),null);
});
test('sitemap and robots identify the public domain',async()=>{
 assert.equal(canonicalDomain(new Request(old+'/sitemap.xml')).headers.get('location'),'https://www.shmbox.com/sitemap.xml');
 assert.match(await canonicalDomain(new Request(old+'/robots.txt')).text(),/Sitemap: https:\/\/www.shmbox.com\/sitemap.xml/);
});
