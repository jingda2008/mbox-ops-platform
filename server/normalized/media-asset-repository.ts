import type { ScopedTransaction } from './transaction-runner.js'

export type MediaPurpose = 'community_activity' | 'home_content' | 'menu' | 'performer' | 'support_contact'

export interface MediaAssetView {
  publicId: string
  purpose: MediaPurpose
  originalFileName: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  byteLength: number
  sha256: string
  publicUrl: string
  staffUrl: string
  createdAt: string
}

interface AssetRow extends Record<string, unknown> {
  public_id: string
  purpose: MediaPurpose
  original_file_name: string
  mime_type: MediaAssetView['mimeType']
  byte_length: number
  sha256: string
  created_at: string
}

interface BytesRow extends AssetRow { bytes: Buffer }

export class MediaAssetRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async list(): Promise<MediaAssetView[]> {
    const result = await this.transaction.query<AssetRow>(`
      SELECT public_id,purpose,original_file_name,mime_type,byte_length,sha256,created_at::text
      FROM mbox.media_assets
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      ORDER BY created_at DESC,id DESC
      LIMIT 100
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows.map(view)
  }

  async create(input: Readonly<{
    publicId: string
    purpose: MediaPurpose
    originalFileName: string
    mimeType: MediaAssetView['mimeType']
    bytes: Buffer
    sha256: string
    employeeId: string
  }>): Promise<{ asset: MediaAssetView; replayed: boolean }> {
    const inserted = await this.transaction.query<AssetRow>(`
      INSERT INTO mbox.media_assets(
        tenant_id,store_id,public_id,purpose,original_file_name,mime_type,
        byte_length,sha256,bytes,created_by_employee_id
      ) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::bytea,$10::uuid)
      ON CONFLICT(tenant_id,store_id,purpose,sha256) DO NOTHING
      RETURNING public_id,purpose,original_file_name,mime_type,byte_length,sha256,created_at::text
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,input.publicId,input.purpose,
      input.originalFileName,input.mimeType,input.bytes.length,input.sha256,input.bytes,input.employeeId,
    ])
    if (inserted.rows[0] !== undefined) return { asset: view(inserted.rows[0]), replayed: false }
    const existing = await this.transaction.query<AssetRow>(`
      SELECT public_id,purpose,original_file_name,mime_type,byte_length,sha256,created_at::text
      FROM mbox.media_assets
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND purpose=$3 AND sha256=$4
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,input.purpose,input.sha256])
    const row = existing.rows[0]
    if (row === undefined) throw new Error('图片上传结果无法确认')
    return { asset: view(row), replayed: true }
  }

  async publicBytes(publicId: string): Promise<{ mimeType: MediaAssetView['mimeType']; bytes: Buffer; sha256: string } | null> {
    const result = await this.transaction.query<BytesRow>(`
      SELECT asset.public_id,asset.purpose,asset.original_file_name,asset.mime_type,asset.byte_length,
        asset.sha256,asset.bytes,asset.created_at::text
      FROM mbox.media_assets AS asset
      WHERE asset.tenant_id=$1::uuid AND asset.store_id=$2::uuid AND asset.public_id=$3
        AND (
          EXISTS (
            SELECT 1 FROM mbox.community_activities AS activity
            WHERE activity.tenant_id=asset.tenant_id AND activity.store_id=asset.store_id
              AND activity.status IN ('published','full')
              AND activity.cover_url=('/api/public/media-assets/'||asset.public_id)
          ) OR EXISTS (
            SELECT 1 FROM mbox.member_content_cards AS card
            WHERE card.tenant_id=asset.tenant_id AND card.store_id=asset.store_id
              AND card.status='published'
              AND card.image_url=('/api/public/media-assets/'||asset.public_id)
          ) OR EXISTS (
            -- Menu images are visible to the mini program only when the
            -- product itself is published to the customer menu.  Staff image
            -- previews must not make inactive or hidden product assets public.
            SELECT 1
            FROM mbox.products AS product
            LEFT JOIN mbox.menu_categories AS menu_category
              ON menu_category.tenant_id=product.tenant_id
             AND menu_category.store_id=product.store_id
             AND menu_category.code=product.category_code
            LEFT JOIN mbox.menu_categories AS parent_menu_category
              ON parent_menu_category.tenant_id=menu_category.tenant_id
             AND parent_menu_category.store_id=menu_category.store_id
             AND parent_menu_category.code=menu_category.parent_code
            WHERE product.tenant_id=asset.tenant_id
              AND product.store_id=asset.store_id
              AND product.product_snapshot->>'imageUrl'=('/api/public/media-assets/'||asset.public_id)
              AND product.status='active'
              AND product.guest_visible=true
              AND 'guest_qr'=ANY(product.allowed_channels)
              AND (menu_category.id IS NULL OR (
                menu_category.guest_visible=true
                AND (parent_menu_category.id IS NULL OR parent_menu_category.guest_visible=true)
              ))
          )
        )
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,publicId])
    const row = result.rows[0]
    return row === undefined ? null : { mimeType: row.mime_type, bytes: row.bytes, sha256: row.sha256 }
  }

  async staffBytes(publicId: string): Promise<{ mimeType: MediaAssetView['mimeType']; bytes: Buffer; sha256: string } | null> {
    const result = await this.transaction.query<BytesRow>(`
      SELECT public_id,purpose,original_file_name,mime_type,byte_length,sha256,bytes,created_at::text
      FROM mbox.media_assets
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,publicId])
    const row = result.rows[0]
    return row === undefined ? null : { mimeType: row.mime_type, bytes: row.bytes, sha256: row.sha256 }
  }
}

function view(row: AssetRow): MediaAssetView {
  return {
    publicId: row.public_id,purpose: row.purpose,originalFileName: row.original_file_name,
    mimeType: row.mime_type,byteLength: row.byte_length,sha256: row.sha256,
    publicUrl: `/api/public/media-assets/${row.public_id}`,
    staffUrl: `/api/staff/media-assets/${row.public_id}`,
    createdAt: row.created_at,
  }
}
