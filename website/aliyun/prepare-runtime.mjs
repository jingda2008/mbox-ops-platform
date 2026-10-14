import {cp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url)),site=resolve(here,'..');
const output=resolve(process.argv[2]||'');
if(!process.argv[2]||output===site||output===here)throw Error('Provide a separate, empty output directory');
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw Error('Output must be empty');
for(const file of ['server.mjs','server.test.mjs','gateway.js','package.json','package-lock.json'])await cp(join(here,file),join(output,file));
for(const dir of ['public','data','lib/mbox'])await cp(join(site,dir),join(output,dir),{recursive:true});
await cp(join(here,'public-overrides'),join(output,'public'),{recursive:true});
async function rewrite(dir){for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())await rewrite(path);else if(/\.(html|json|xml|txt)$/.test(e.name)){const text=await readFile(path,'utf8');await writeFile(path,text.replaceAll('https://mbox-shanghai-preview-20261013.jingda2008.chatgpt.site','https://www.shmbox.com'));}}}
await rewrite(join(output,'public'));await rewrite(join(output,'data'));
// Reservation recovery must keep the old-origin link, not rewrite it to the new identity.
for(const lang of ['zh','en','ru','ja','ko','fr','de'])await cp(join(here,'public-overrides',lang,'reserve','index.html'),join(output,'public',lang,'reserve','index.html'));
console.log(output);
