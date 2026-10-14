import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pages from '../data/pages.json' with {type:'json'};

const href='https://beian.miit.gov.cn/#/Integrated/recordQuery';
const record='沪ICP备2023018086号-3';
const link=`<p class="footer-icp"><a class="icp" href="${href}" target="_blank" rel="noopener">${record}</a></p>`;
const langs=['zh','en','ru','ja','ko','fr','de'];

test('shared footer shows the ICP record on every public language page',()=>{
 for(const lang of langs){
  for(const path of [`/${lang}/`,`/${lang}/menu/`]){
   assert.equal(pages[path].split(link).length-1,1,path);
   assert.ok(pages[path].includes(`<footer>`),path);
  }
  for(const file of [`public/${lang}/reserve/index.html`,`aliyun/public-overrides/${lang}/reserve/index.html`]){
   const html=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
   assert.equal(html.split(link).length-1,1,file);
  }
 }
 const source=fs.readFileSync(new URL('../build.py',import.meta.url),'utf8');
 assert.ok(source.includes(link.replace('<p class="footer-icp">','').replace('</p>','')));
 assert.match(source,/footer-icp">\{ICP_RECORD\}<\/p><\/footer>/);
});
