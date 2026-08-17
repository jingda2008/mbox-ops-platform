import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

interface ExpiringLot extends Record<string, unknown> {
  id: string
  membership_id: string
  customer_id: string
  remaining_points: number
}

export interface LoyaltyPointsExpiryBatch {
  workerId: string
  expiredLots: number
  expiredPoints: number
}

export class LoyaltyPointsExpiryWorker {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  runBatch(scope: Readonly<StoreScope>, workerId: string, batchSize = 100): Promise<LoyaltyPointsExpiryBatch> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new TypeError('batchSize is invalid')
    return this.transactions.run(scope, async (transaction) => {
      const selected = await transaction.query<ExpiringLot>(`
        SELECT lot.id,lot.membership_id,lot.customer_id,lot.remaining_points
        FROM mbox.loyalty_point_lots lot
        JOIN mbox.loyalty_accounts account
          ON account.tenant_id=lot.tenant_id AND account.store_id=lot.store_id
         AND account.membership_id=lot.membership_id
        WHERE lot.tenant_id=$1::uuid AND lot.store_id=$2::uuid
          AND lot.status='available' AND lot.remaining_points>0
          AND lot.expires_at IS NOT NULL AND lot.expires_at<=clock_timestamp()
        ORDER BY lot.expires_at,lot.id
        FOR UPDATE OF lot,account SKIP LOCKED LIMIT $3
      `, [transaction.scope.tenantId, transaction.scope.storeId, batchSize])
      let expiredPoints = 0
      for (const lot of selected.rows) {
        const points = Number(lot.remaining_points)
        const account = await transaction.query<{ available_points: number }>(`
          UPDATE mbox.loyalty_accounts
          SET available_points=available_points-$4,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
            AND available_points>=$4
          RETURNING available_points
        `, [transaction.scope.tenantId, transaction.scope.storeId, lot.membership_id, points])
        const balance = account.rows[0]?.available_points
        if (!Number.isSafeInteger(balance)) throw new Error(`Loyalty account cannot cover expiring lot ${lot.id}`)
        await transaction.query(`
          UPDATE mbox.customer_memberships
          SET points_balance=$4,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        `, [transaction.scope.tenantId, transaction.scope.storeId, lot.membership_id, balance])
        const updated = await transaction.query(`
          UPDATE mbox.loyalty_point_lots
          SET remaining_points=0,status='expired',updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
            AND status='available' AND remaining_points=$4
        `, [transaction.scope.tenantId, transaction.scope.storeId, lot.id, points])
        if (updated.rowCount !== 1) throw new Error(`Expiring point lot changed concurrently ${lot.id}`)
        await transaction.query(`
          INSERT INTO mbox.loyalty_point_ledger(
            tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,
            balance_after,source_type,source_id,reason,idempotency_key,occurred_at
          ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'expire',$5,$6,'expiration',$7,
            '积分批次达到已发布有效期',$8,clock_timestamp())
        `, [
          transaction.scope.tenantId, transaction.scope.storeId, lot.membership_id,
          lot.customer_id, -points, balance, lot.id, `points-expire:${lot.id}`,
        ])
        await transaction.query(`
          INSERT INTO mbox.loyalty_point_lot_movements(
            tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,
            source_type,source_id,idempotency_key,occurred_at
          ) VALUES($1::uuid,$2::uuid,$3::uuid,'expire',$4,0,'system',$3::uuid::text,$5,clock_timestamp())
        `, [
          transaction.scope.tenantId, transaction.scope.storeId, lot.id,
          -points, `lot-expire:${lot.id}`,
        ])
        await transaction.query(`
          INSERT INTO mbox.audit_events(
            tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,business_date,metadata
          ) SELECT $1::uuid,$2::uuid,'system',$4,'loyalty.points.expired','loyalty_point_lot',$3::uuid::text,
            ((clock_timestamp() AT TIME ZONE store.timezone)-make_interval(secs=>extract(epoch FROM store.business_day_cutoff)))::date,
            jsonb_build_object('expiredPoints',$5::integer)
          FROM mbox.stores store WHERE store.tenant_id=$1::uuid AND store.id=$2::uuid
        `, [transaction.scope.tenantId, transaction.scope.storeId, lot.id, workerId, points])
        expiredPoints += points
      }
      return { workerId, expiredLots: selected.rows.length, expiredPoints }
    })
  }
}
