import type { ScopedTransaction } from './transaction-runner.js'

export type MemberContentCardType = 'activity' | 'presale' | 'benefit' | 'article' | 'return_offer' | 'show'
export type MemberContentCardStatus = 'draft' | 'published' | 'paused' | 'retired'
export type MemberContentCardVisibility = 'public' | 'member' | 'segment'

export interface MemberContentCardDraft {
  code: string
  type: MemberContentCardType
  title: string
  summary: string
  imageUrl: string | null
  ctaLabel: string
  targetPath: string
  priority: number
  visibility: MemberContentCardVisibility
  audienceMemberLevels: readonly string[]
  audienceLifecycleStages: readonly string[]
  validFrom: string
  validUntil: string
}

export interface MemberContentCardView extends MemberContentCardDraft {
  status: MemberContentCardStatus
  publishedByEmployeeId: string | null
  createdAt: string
  updatedAt: string
}

interface CardRow extends Record<string, unknown> {
  code: string
  card_type: MemberContentCardType
  title: string
  summary: string
  image_url: string | null
  cta_label: string
  target_path: string
  priority: number
  audience_visibility: MemberContentCardVisibility
  audience_member_levels: string[]
  audience_lifecycle_stages: string[]
  valid_from: string
  valid_until: string
  status: MemberContentCardStatus
  approved_by_employee_id: string | null
  created_at: string
  updated_at: string
}

export class MemberContentCardError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) {
    super(message)
    this.name = 'MemberContentCardError'
  }
}

const CARD_COLUMNS = `
  code,card_type,title,summary,image_url,cta_label,target_path,priority,
  audience_visibility,audience_member_levels,audience_lifecycle_stages,
  valid_from::text,valid_until::text,status,approved_by_employee_id,
  created_at::text,updated_at::text
`

export class MemberContentCardRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async list(): Promise<MemberContentCardView[]> {
    const result = await this.transaction.query<CardRow>(`
      SELECT ${CARD_COLUMNS}
      FROM mbox.member_content_cards
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
        priority,valid_from DESC,id DESC
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows.map(cardView)
  }

  async create(input: Readonly<MemberContentCardDraft>): Promise<MemberContentCardView> {
    const result = await this.transaction.query<CardRow>(`
      INSERT INTO mbox.member_content_cards(
        tenant_id,store_id,code,card_type,title,summary,image_url,cta_label,target_path,
        priority,audience_rule,source_ref,valid_from,valid_until,status,
        audience_visibility,audience_member_levels,audience_lifecycle_stages
      ) VALUES(
        $1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,
        jsonb_build_object('memberLevels',$12::text[],'lifecycleStages',$13::text[]),
        NULL,$14::timestamptz,$15::timestamptz,'draft',$11,$12::text[],$13::text[]
      )
      RETURNING ${CARD_COLUMNS}
    `, values(this.transaction, input))
    const row = result.rows[0]
    if (!row) throw new MemberContentCardError('首页内容草稿未能建立', 'HOME_CONTENT_CREATE_FAILED', 503)
    return cardView(row)
  }

  async update(code: string, input: Readonly<MemberContentCardDraft>): Promise<MemberContentCardView> {
    const parameters = values(this.transaction, input)
    parameters[2] = code
    const result = await this.transaction.query<CardRow>(`
      UPDATE mbox.member_content_cards
      SET card_type=$4,title=$5,summary=$6,image_url=$7,cta_label=$8,target_path=$9,
        priority=$10,audience_visibility=$11,audience_member_levels=$12::text[],
        audience_lifecycle_stages=$13::text[],
        audience_rule=jsonb_build_object('memberLevels',$12::text[],'lifecycleStages',$13::text[]),
        valid_from=$14::timestamptz,valid_until=$15::timestamptz,status='draft',
        approved_by_employee_id=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code=$3
        AND status IN ('draft','paused')
      RETURNING ${CARD_COLUMNS}
    `, parameters)
    const row = result.rows[0]
    if (row) return cardView(row)
    return this.notEditable(code)
  }

  async publish(code: string, employeeId: string): Promise<MemberContentCardView> {
    const result = await this.transaction.query<CardRow>(`
      UPDATE mbox.member_content_cards
      SET status='published',approved_by_employee_id=$4::uuid,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code=$3
        AND status IN ('draft','paused')
        AND valid_until>clock_timestamp()
      RETURNING ${CARD_COLUMNS}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, code, employeeId])
    const row = result.rows[0]
    if (row) return cardView(row)
    const current = await this.findStatus(code)
    if (current === null) throw new MemberContentCardError('首页内容不存在', 'HOME_CONTENT_NOT_FOUND', 404)
    if (current === 'published') throw new MemberContentCardError('该内容已经发布', 'HOME_CONTENT_ALREADY_PUBLISHED')
    if (current === 'retired') throw new MemberContentCardError('已退役内容不能重新发布', 'HOME_CONTENT_RETIRED')
    throw new MemberContentCardError('内容有效期已经结束，请先修改草稿排期', 'HOME_CONTENT_EXPIRED')
  }

  async pause(code: string): Promise<MemberContentCardView> {
    const result = await this.transaction.query<CardRow>(`
      UPDATE mbox.member_content_cards
      SET status='paused',updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code=$3 AND status='published'
      RETURNING ${CARD_COLUMNS}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, code])
    const row = result.rows[0]
    if (row) return cardView(row)
    const current = await this.findStatus(code)
    if (current === null) throw new MemberContentCardError('首页内容不存在', 'HOME_CONTENT_NOT_FOUND', 404)
    throw new MemberContentCardError('只有已发布内容可以暂停展示', 'HOME_CONTENT_NOT_PUBLISHED')
  }

  private async findStatus(code: string): Promise<MemberContentCardStatus | null> {
    const result = await this.transaction.query<{ status: MemberContentCardStatus }>(`
      SELECT status FROM mbox.member_content_cards
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code=$3
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, code])
    return result.rows[0]?.status ?? null
  }

  private async notEditable(code: string): Promise<never> {
    const current = await this.findStatus(code)
    if (current === null) throw new MemberContentCardError('首页内容不存在', 'HOME_CONTENT_NOT_FOUND', 404)
    throw new MemberContentCardError(
      current === 'published' ? '请先暂停展示，再修改内容并重新发布' : '已退役内容不能修改',
      current === 'published' ? 'HOME_CONTENT_PAUSE_REQUIRED' : 'HOME_CONTENT_RETIRED',
    )
  }
}

function values(transaction: ScopedTransaction, input: Readonly<MemberContentCardDraft>): unknown[] {
  return [
    transaction.scope.tenantId,transaction.scope.storeId,input.code,input.type,input.title,input.summary,
    input.imageUrl,input.ctaLabel,input.targetPath,input.priority,input.visibility,
    [...new Set(input.audienceMemberLevels)].toSorted(),
    [...new Set(input.audienceLifecycleStages)].toSorted(),input.validFrom,input.validUntil,
  ]
}

function cardView(row: CardRow): MemberContentCardView {
  return {
    code:row.code,type:row.card_type,title:row.title,summary:row.summary,imageUrl:row.image_url,
    ctaLabel:row.cta_label,targetPath:row.target_path,priority:row.priority,
    visibility:row.audience_visibility,audienceMemberLevels:[...row.audience_member_levels],
    audienceLifecycleStages:[...row.audience_lifecycle_stages],validFrom:row.valid_from,
    validUntil:row.valid_until,status:row.status,publishedByEmployeeId:row.approved_by_employee_id,
    createdAt:row.created_at,updatedAt:row.updated_at,
  }
}
