import {writeFileSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseCouponCalendarRule, previewCouponCalendar, couponIssuanceValidity} from '../../../../server/normalized/coupon-calendar.ts';
import {calculateStackingPrice} from '../../../../server/normalized/stacking-pricing.ts';
const employeeId='00000000-0000-4000-8000-000000000001';
const rule=parseCouponCalendarRule({timezone:'Asia/Shanghai',dateBasis:'business',businessDayStartMinute:360,dateFrom:'2026-10-05',dateThrough:'2026-11-05',validFrom:'2026-10-04T16:00:00Z',validUntil:'2026-11-06T00:00:00Z',weekdays:[1,2,3,4,5,6,7],weekStartsOn:1,windows:[{startMinute:1080,endMinute:120}],excludedDates:['2026-10-06'],relativeValidity:{days:2,basis:'business_end'}});
const calendars=[undefined,'2026-10-05T12:30:00Z'].map(issuedAt=>{const body={rule,at:'2026-10-05T12:00:00Z',...(issuedAt?{issuedAt}:{})};const validity=issuedAt?couponIssuanceValidity(rule,new Date(issuedAt)):null;return{body,response:{data:{employeeId,protocol:1,previewOnly:true,issuanceValidity:validity,...previewCouponCalendar(validity?{...rule,...validity}:rule,new Date(body.at),undefined,31)}}}});
const policy={allowMemberPrice:true,allowBundlePrice:true,allowCheckoutUpgrade:true,allowOtherCoupons:true,allowPoints:true,maxCoupons:2,calculationOrder:['member','coupon','points'],maximumDiscountMinor:null,minimumPayableMinor:0};
const scenarios=[
 {units:[{id:'unit-1',amountMinor:10001,costMinor:null,bundle:false,upgraded:false},{id:'unit-2',amountMinor:999,costMinor:100,bundle:true,upgraded:false}],effects:[{id:'member-1',stage:'member',kind:'rate',value:8000,unitIds:['unit-1','unit-2'],minimumSpendMinor:0},{id:'coupon-1',stage:'coupon',kind:'amount_off',value:300,unitIds:['unit-1','unit-2'],minimumSpendMinor:0},{id:'points-1',stage:'points',kind:'amount_off',value:150,unitIds:['unit-1'],minimumSpendMinor:0}]},
 {units:[{id:'unit-1',amountMinor:100,costMinor:200,bundle:false,upgraded:false}],effects:[{id:'coupon-1',stage:'coupon',kind:'free',value:0,unitIds:['unit-1'],minimumSpendMinor:0}]},
 {units:[{id:'unit-1',amountMinor:9007199254740991,costMinor:0,bundle:false,upgraded:false}],effects:[]},
];
const stacking=scenarios.map(scenario=>({body:{policy,scenario},response:{data:{employeeId,protocol:1,previewOnly:true,orderAuthorization:false,currency:'CNY',...calculateStackingPrice(policy,scenario)}}}));
const sources=Object.fromEntries(['coupon-calendar.ts','stacking-pricing.ts'].map(name=>[name,createHash('sha256').update(readFileSync(new URL('../../../../server/normalized/'+name,import.meta.url))).digest('hex')]));
writeFileSync(process.argv[2]??fileURLToPath(new URL('CouponPolicyContractFixtures.json',import.meta.url)),JSON.stringify({sources,calendars,stacking},null,2)+'\n');
