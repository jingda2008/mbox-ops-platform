import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
const code=fs.readFileSync(new URL('../public/language.js',import.meta.url),'utf8');
async function resolve({saved,langs=['en-US'],path='/',geo='ja',fail=false}){let result,called=0;await vm.runInNewContext(code,{navigator:{languages:langs},location:{pathname:path,search:'?from=qr',hash:'#booking',replace:x=>result=x},localStorage:{getItem:()=>saved},fetch:async()=>{called++;if(fail)throw Error();return {json:async()=>({language:geo})}},AbortSignal});return {result,called};}
test('explicit localized URLs remain shareable',async()=>assert.deepEqual(await resolve({path:'/zh/menu/'}),{result:undefined,called:0}));
test('saved choice wins over browser and geo',async()=>assert.deepEqual(await resolve({saved:'ru'}),{result:'/ru/?from=qr#booking',called:0}));
test('foreign visitor in China keeps browser language',async()=>assert.deepEqual(await resolve({langs:['ja-JP'],geo:'zh'}),{result:'/ja/?from=qr#booking',called:0}));
test('country fallback only when supported browser language absent',async()=>assert.deepEqual(await resolve({langs:['es-ES'],geo:'fr'}),{result:'/fr/?from=qr#booking',called:1}));
test('missing geo does not block entry',async()=>assert.deepEqual(await resolve({langs:['es'],fail:true}),{result:'/en/?from=qr#booking',called:1}));
