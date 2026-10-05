import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseMarketingNotice} from '../../../../server/normalized/marketing-contact-policy.ts';
const source='server/normalized/marketing-contact-policy.ts';
const input={operatorName:'  本地测试经营主体  ',operatorContact:'测试工作联系渠道',summary:'仅用于本地合同核对的活动说明',withdrawalInstructions:'通过测试入口停止联系',purposes:['own_activities','mbox_joint_activities'],channels:['wechat','sms','phone'],dataCategories:['  会员编号  ','活动偏好'],validFrom:'2026-01-01T08:00:00.123+08:00',validUntil:'2099-01-01T08:00:00.456+08:00',consentDays:30,contactStartMinute:0,contactEndMinute:1440,weekdays:[7,1,2,3,4,5,6],maximumPerDay:2,maximumPerMonth:10,sharingMode:'no_partner_list'};
const result={source,sourceSHA256:createHash('sha256').update(readFileSync(source)).digest('hex'),input,expected:parseMarketingNotice(input)};
writeFileSync(new URL('./MarketingServerFixtures.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
