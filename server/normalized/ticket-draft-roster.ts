import { createHash } from 'node:crypto'
import { ActivityOperationsError } from './activity-operations-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

type Desk = {
  id: string
  code: string
  selected: boolean
  fixed: boolean
}

export async function readDraftRoster(tx: ScopedTransaction, areaId: string, lock = false) {
  const scope = [tx.scope.tenantId, tx.scope.storeId, areaId]
  const area = await tx.query(`SELECT id FROM mbox.areas WHERE (tenant_id,store_id,id)=($1,$2,$3)
    AND status='active' ${lock ? 'FOR UPDATE' : ''}`, scope)
  if (!area.rows.length) throw new ActivityOperationsError('桌区已停用或不存在，请重新选择。', 'ROSTER_AREA_UNAVAILABLE', 409)
  const { rows } = await tx.query<Desk>(`
    SELECT t.id,t.code,(r.table_id IS NOT NULL OR e.table_id IS NOT NULL) AS selected,
      r.table_id IS NOT NULL AS fixed
    FROM mbox.tables t LEFT JOIN mbox.ticket_table_roster r ON
      (r.tenant_id,r.store_id,r.table_id)=(t.tenant_id,t.store_id,t.id)
    LEFT JOIN mbox.ticket_draft_roster_entries e ON
      (e.tenant_id,e.store_id,e.area_id,e.table_id)=(t.tenant_id,t.store_id,t.area_id,t.id)
    WHERE (t.tenant_id,t.store_id,t.area_id)=($1,$2,$3) AND t.status='available'
    ORDER BY t.code,t.id ${lock ? 'FOR SHARE OF t' : ''}`, scope)
  return { desks:rows, revision:createHash('sha256').update(JSON.stringify([areaId,rows])).digest('hex') }
}

export async function saveDraftRoster(tx: ScopedTransaction, areaId: string, revision: string, ids: string[]) {
  const current = await readDraftRoster(tx, areaId, true)
  if (current.revision !== revision)
    throw new ActivityOperationsError('本区桌台或名单已变化，请重新读取后核对。', 'ROSTER_CHANGED', 409)
  const selected = new Set(ids)
  const eligible = new Set(current.desks.map(desk => desk.id))
  if (ids.length !== selected.size || ids.some(id => !eligible.has(id)) ||
      current.desks.some(d => d.fixed && !selected.has(d.id)))
    throw new ActivityOperationsError('请选择本区可用桌台，并保留已核定的桌号。','ROSTER_INVALID_SELECTION',409)
  const args = [tx.scope.tenantId,tx.scope.storeId,areaId,ids]
  await tx.query(`DELETE FROM mbox.ticket_draft_roster_entries WHERE
    (tenant_id,store_id,area_id)=($1,$2,$3) AND NOT(table_id=ANY($4::uuid[]))`,args)
  await tx.query(`INSERT INTO mbox.ticket_draft_roster_entries(tenant_id,store_id,area_id,table_id)
    SELECT $1,$2,$3,desk FROM unnest($4::uuid[]) desk
    ON CONFLICT DO NOTHING`,[...args.slice(0,3),current.desks.filter(d=>!d.fixed && selected.has(d.id)).map(d=>d.id)])
  return {areaId,tableIds:ids}
}
