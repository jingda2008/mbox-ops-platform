import {z} from 'zod'
export class BottleCustodyError extends Error {constructor(message:string,readonly code='BOTTLE_CUSTODY_INVALID',readonly statusCode=400){super(message)}}
export const quantitySchema=z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/).refine(value=>quantityUnits(value)>0n,'数量必须大于零')
export function quantityUnits(value:string):bigint{const [whole,fraction='']=value.split('.');return BigInt(whole!)*1000000n+BigInt(fraction.padEnd(6,'0'))}
export function quantityText(value:bigint):string{return `${value/1000000n}.${(value%1000000n).toString().padStart(6,'0')}`.replace(/\.?0+$/,'')||'0'}
export const custodyExtraFieldSchema=z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),label:z.string().trim().min(1).max(30),type:z.enum(['text','number','date']),required:z.boolean()}).strict()
export const custodyPolicySchema=z.object({
 allowRestorage:z.boolean().default(true),requireOriginalOrder:z.boolean().default(false),archiveMode:z.enum(['automatic','manual']).default('automatic'),
 extraFieldDefinitions:z.array(custodyExtraFieldSchema).max(20).refine(v=>new Set(v.map(f=>f.key)).size===v.length).default([]),
 serviceAccountId:z.string().uuid().nullable().default(null),enabled:z.boolean(),defaultDays:z.number().int().min(1).max(3660),remindersEnabled:z.boolean(),
 reminderDays:z.array(z.number().int().min(1).max(3660)).min(1).max(12).refine(value=>new Set(value).size===value.length),
 sendMinute:z.number().int().min(960).max(1020),codeDigits:z.number().int().min(4).max(8),
 codeTtlSeconds:z.number().int().min(60).max(600),resendSeconds:z.number().int().min(30).max(600),maximumAttempts:z.number().int().min(1).max(10),
 allowPartial:z.boolean(),numberPattern:z.string().min(10).max(200).refine(value=>['{date}','{time}','{member}','{serial}'].every(token=>value.includes(token))&&!/[<>\r\n]/.test(value)),
 printFields:z.array(z.enum(['category','item','quantity','remaining','expiry','location','status','source'])).max(8).refine(v=>new Set(v).size===v.length).default(['category','item','quantity','remaining','expiry','location','status','source']),printFooter:z.string().max(300).default('取酒须通过会员验证码核验，本凭证不代替取走确认。'),reportDimensions:z.array(z.enum(['category','status','date'])).max(3).refine(v=>new Set(v).size===v.length).default(['category','status','date']),
 printTitle:z.string().trim().min(1).max(100),reminderText:z.string().trim().min(1).max(500),
}).strict()
export type CustodyPolicy=z.infer<typeof custodyPolicySchema>
export const defaultCustodyPolicy:CustodyPolicy={allowRestorage:true,requireOriginalOrder:false,archiveMode:'automatic',extraFieldDefinitions:[],printFields:['category','item','quantity','remaining','expiry','location','status','source'],printFooter:'取酒须通过会员验证码核验，本凭证不代替取走确认。',reportDimensions:['category','status','date'],serviceAccountId:null,enabled:false,defaultDays:20,remindersEnabled:false,reminderDays:[30,15,7,3,2,1],sendMinute:990,codeDigits:4,codeTtlSeconds:300,resendSeconds:60,maximumAttempts:5,allowPartial:false,numberPattern:'{date}-{time}-{member}-{serial}',printTitle:'M-BOX 存酒凭证',reminderText:'您的存酒将于{expiry}到期，请安排来店领取或饮用。'}
export function custodyNumber(pattern:string,date:Date,member:string,serial:string){
 const local=new Date(date.getTime()+8*3600000).toISOString()
 return pattern.replaceAll('{date}',local.slice(0,10).replaceAll('-','')).replaceAll('{time}',local.slice(11,19).replaceAll(':','')).replaceAll('{member}',member).replaceAll('{serial}',serial)
}
export function reminderDueAt(expiry:string,days:number,minute:number):Date{
 const local=new Date(Date.parse(expiry)+8*3600000).toISOString().slice(0,10)
 return new Date(Date.parse(`${local}T00:00:00+08:00`)-days*86400000+minute*60000)
}

export function validateCustodyExtraFields(values:Record<string,string>,definitions:CustodyPolicy['extraFieldDefinitions']){
 for(const key of Object.keys(values))if(!definitions.some(field=>field.key===key))throw new BottleCustodyError('表单字段已变化，请刷新后重填')
 for(const field of definitions){const value=values[field.key]?.trim()??'';if(field.required&&!value)throw new BottleCustodyError(`请填写${field.label}`)
  if(value&&field.type==='number'&&!/^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value))throw new BottleCustodyError(`${field.label}须为有效数字`)
  if(value&&field.type==='date'&&!z.iso.date().safeParse(value).success)throw new BottleCustodyError(`${field.label}须为有效日期`)
 }
 return values
}
