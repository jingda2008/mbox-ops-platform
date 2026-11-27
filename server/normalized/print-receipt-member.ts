import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import type {ScopedTransaction} from './transaction-runner.js'

export type ReceiptPhoneKeys = Pick<ActivityContactProtectionKeyring,'revealPhone'>
export interface ReceiptMember {memberNo:string;level:string;phone:string|null}

export function receiptMemberText(member?:ReceiptMember, role='获分会员'):string|null {
  return member ? `${role} · 卡号 ${member.memberNo} · ${member.level}\n手机号 ${member.phone??'未留可打印号码'}` : null
}

export async function readReceiptMembers(tx:ScopedTransaction,customers:readonly string[],keys?:ReceiptPhoneKeys) {
  const result=new Map<string,ReceiptMember>()
  if(!customers.length)return result
  const rows=await tx.query<{source:string;member_no:string;tier:string;masked:string|null;cipher:Buffer|null;key_id:string;hash:string}>(`
    SELECT src.id AS source,m.member_no,coalesce(a.current_tier,m.level) AS tier,c.masked_value AS masked,
      CASE WHEN $4::boolean AND c.masked_value !~ '^1[0-9]{2}[*]{4}[0-9]{4}$' THEN c.encrypted_value END AS cipher,
      c.contact_encryption_key_id AS key_id,c.contact_hash AS hash
    FROM unnest($3::uuid[]) src(id)
    JOIN mbox.customer_memberships m ON (m.tenant_id,m.store_id,m.customer_id)=($1,$2,mbox.canonical_customer_id($1,$2,src.id)) AND m.status='active'
    LEFT JOIN mbox.loyalty_accounts a ON (a.tenant_id,a.store_id,a.membership_id)=(m.tenant_id,m.store_id,m.id)
    LEFT JOIN LATERAL (SELECT masked_value,encrypted_value,contact_encryption_key_id,contact_hash FROM mbox.customer_verified_contacts
      WHERE (tenant_id,store_id,customer_id)=(m.tenant_id,m.store_id,m.customer_id) AND contact_type='phone'
        AND processing_status='active' AND verified_at IS NOT NULL AND revoked_at IS NULL
      ORDER BY verified_at DESC,id LIMIT 1) c ON true`,[tx.scope.tenantId,tx.scope.storeId,[...new Set(customers)],Boolean(keys?.revealPhone)])
  const levels:Record<string,string>={member:'普卡会员',silver:'银卡会员',gold:'金卡会员',black:'黑卡会员'}
  for(const row of rows.rows){
    let phone=row.masked && /^1\d{2}\*{4}\d{4}$/.test(row.masked)?row.masked:null
    if(!phone && keys?.revealPhone && row.cipher){
      try{
        const match=/^(?:\+86)?(1\d{2})\d{4}(\d{4})$/.exec(keys.revealPhone({encryptedValue:row.cipher,encryptionKeyId:row.key_id,contactHash:row.hash}))
        if(match)phone=match[1]+'****'+match[2]
      } catch { /* A retired key must not prevent the receipt or expose the stored value. */ }
    }
    result.set(row.source,{memberNo:row.member_no,level:levels[row.tier]??'等级未记录',phone})
  }
  return result
}
