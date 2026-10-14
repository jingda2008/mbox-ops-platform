import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
const rule=css.match(/\.catalog-price[\s\S]*?\{[^}]+\}/g)?.at(-1)||'';

test('display digits use system lining figures, not the oldstyle serif',()=>{
 for(const selector of ['.performance time','.catalog-price','.product-name>span','.steps li>span','.ordinal','.contact-card .phone','.story-mark>div','.schedule-header strong','.set-number','.step-progress b']){
  assert.ok(rule.includes(selector), selector);
 }
 assert.match(rule,/font-family:var\(--sans\)/);
 assert.match(rule,/lining-nums tabular-nums/);
 assert.match(rule,/font-feature-settings:"lnum" 1,"tnum" 1/);
 assert.match(css,/\.performance time\{[^}]*font-family:var\(--sans\)/);
 assert.match(css,/\.performance time\{[^}]*font-size:16px/);
 assert.match(css,/\.performance time\{[^}]*font-size:14px/);
 assert.doesNotMatch(css,/\.performance time\{[^}]*var\(--serif\)/);
});
