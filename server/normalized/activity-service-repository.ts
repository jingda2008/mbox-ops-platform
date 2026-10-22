import { randomUUID } from 'node:crypto';
import { refreshActivityMealNumber } from './activity-service-number.js';
import type { ActivityDoorCommand, ActivityProductionCommand, ActivityProductionResult, ActivityServiceLine, ActivityServiceView } from '../../src/shared/activity-service.js';
import { appendOutboxMessage, IdempotencyConflictError } from './command-executor.js';
import type { ScopedTransaction } from './transaction-runner.js';
export class ActivityServiceError extends Error {
    constructor(message: string, readonly code = 'ACTIVITY_SERVICE_CONFLICT', readonly statusCode = 409) { super(message); }
}
const fail = (message: string, code?: string): never => { throw new ActivityServiceError(message, code); };
export const activityCredential = (id: string, token: string) => `MBOX_ACTIVITY_V3:${id}:${token}`;
export function parseActivityCredential(code: string) {
    const match = /^MBOX_ACTIVITY_V3:([^:]{8,128}):([0-9a-f-]{36})$/i.exec(code.trim());
    if (!match)
        throw new ActivityServiceError('请扫描顾客的套餐专用核销码', 'ACTIVITY_CREDENTIAL_INVALID', 400);
    return { publicId: match[1]!, token: match[2]! };
}
interface Registration extends Record<string, unknown> {
    id: string;
    public_id: string;
    service_version: number;
    service_has_meal: boolean;
    fee_amount_minor: string | number;
    party_size: number;
    max_participants: number;
    reserved_seats: number;
    includes_admission: boolean;
    payment_status: string;
    service_refund_disposition: string | null;
    status: string;
    credential_token: string;
    parent_registration_id: string | null;
    purchase_kind: string;
    service_items_snapshot: Array<{
        productId: string;
        name: string;
        station: 'bar' | 'kitchen';
        quantity: number;
    }>;
    starts_at: string;
    ends_at: string;
    meal_starts_at: string;
    meal_ends_at: string;
    activity_status: string;
    activity_public_id: string;
    activity_title: string;
    activity_package_snapshot: {
        name?: string;
    };
}
export class ActivityServiceRepository {
    constructor(private readonly tx: ScopedTransaction) { }
    private get scope() { return [this.tx.scope.tenantId, this.tx.scope.storeId]; }
    async registration(publicId: string, lock = false): Promise<Registration> {
        const row = (await this.tx.query<Registration>(`SELECT r.*,a.public_id AS activity_public_id,a.title AS activity_title,a.starts_at::text,a.ends_at::text,a.status AS activity_status,COALESCE(a.meal_service_starts_at,a.starts_at)::text AS meal_starts_at,COALESCE(a.meal_service_ends_at,a.ends_at)::text AS meal_ends_at FROM mbox.community_activity_registrations r JOIN mbox.community_activities a ON (a.tenant_id,a.store_id,a.id)=(r.tenant_id,r.store_id,r.activity_id) WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.public_id=$3 ${lock ? 'FOR UPDATE OF r' : ''}`, [...this.scope, publicId])).rows[0];
        if (!row)
            throw new ActivityServiceError('未找到本门店报名', 'ACTIVITY_REGISTRATION_NOT_FOUND', 404);
        if (row.service_version !== 3)
            fail('此订单使用原活动承诺，请在原活动记录办理', 'ACTIVITY_LEGACY_SERVICE');
        return row;
    }
    async scan(code: string) { const credential = parseActivityCredential(code), r = await this.registration(credential.publicId); this.checkCredential(r, code); return this.view(r.public_id); }
    private checkCredential(r: Registration, code: string | undefined) {
        if (!code || activityCredential(r.public_id, r.credential_token) !== code.trim())
            throw new ActivityServiceError('核销凭证无效，请重新扫描套餐码', 'ACTIVITY_CREDENTIAL_INVALID', 403);
    }
    private assertPaid(r: Registration) {
        if (!(r.payment_status === 'paid' || (r.payment_status === 'refunded' && r.service_refund_disposition !== null) || (r.payment_status === 'not_required' && Number(r.fee_amount_minor) === 0)) || !['confirmed', 'checked_in'].includes(r.status))
            fail('付款、退款或报名状态已变化，请核对原订单', 'ACTIVITY_NOT_PAID');
    }
    private async within(r: Registration, meal: boolean) {
        const row = (await this.tx.query<{
            allowed: boolean;
        }>(`SELECT clock_timestamp()<$2::timestamptz AND clock_timestamp()>=$1::timestamptz AS allowed`, [meal ? r.meal_starts_at : r.starts_at, meal ? r.meal_ends_at : r.ends_at])).rows[0];
        if (!row?.allowed || !['published', 'full'].includes(r.activity_status))
            fail(meal ? '当前不在餐饮核销服务时间内' : '当前不在活动入场时间内', 'ACTIVITY_SERVICE_WINDOW');
    }
    async view(publicId: string): Promise<ActivityServiceView> {
        const r = await this.registration(publicId), admitted = Number((await this.tx.query<{
            n: number;
        }>('SELECT COALESCE(sum(quantity),0)::int n FROM mbox.activity_admission_batches WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3', [...this.scope, r.id])).rows[0]!.n);
        const meal = (await this.tx.query<{
            id: string;
            number: number;
            plaque_state: 'pending' | 'issued' | 'returned';
            location: string | null;
            closed_at: string | null;
        }>(`SELECT id,number,plaque_state,location,closed_at FROM mbox.activity_meals WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3`, [...this.scope, r.purchase_kind === 'single_dish' ? r.parent_registration_id : r.id])).rows[0];
        return { registrationPublicId: r.public_id, activityPublicId: r.activity_public_id, activityTitle: r.activity_title, packageName: r.activity_package_snapshot.name ?? '活动单点', purchaseKind: r.purchase_kind, hasMeal: r.service_has_meal || r.service_items_snapshot.length > 0 || await this.hasPaidMealChild(r.id), mealServiceStartsAt: r.meal_starts_at, mealServiceEndsAt: r.meal_ends_at, pendingAddonCount: Number((await this.tx.query<{
                n: string;
            }>(`SELECT count(*)::text n FROM mbox.community_activity_registrations c WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.parent_registration_id=$3 AND c.purchase_kind='single_dish' AND (c.payment_status='paid' OR (c.payment_status='not_required' AND c.fee_amount_minor=0) OR (c.payment_status='refunded' AND c.service_refund_disposition IS NOT NULL)) AND c.status IN('confirmed','checked_in') AND NOT EXISTS(SELECT 1 FROM mbox.activity_service_lines l WHERE (l.tenant_id,l.store_id,l.registration_id)=(c.tenant_id,c.store_id,c.id))`, [...this.scope, r.id])).rows[0]!.n), partySize: r.party_size, maxParticipants: r.max_participants, reservedSeats: r.reserved_seats, admittedCount: admitted, remainingAdmission: Math.max(0, r.reserved_seats - admitted), includesAdmission: r.includes_admission, paymentStatus: r.payment_status, meal: meal ? { id: meal.id, number: meal.number, status: meal.closed_at ? 'closed' : 'open', plaqueState: meal.plaque_state, location: meal.location, lines: await this.lines({ mealId: meal.id }), issueNotes: await this.issueNotes(meal.id) } : null };
    }
    private async issueNotes(mealId: string) {
        return (await this.tx.query<{
            id: string;
            lineId: string;
            reason: string;
            employeeLabel: string | null;
            createdAt: string;
        }>(`SELECT receipt.id,receipt.request_body->>'lineId' AS "lineId",receipt.request_body->>'reason' AS reason,employee.display_name AS "employeeLabel",receipt.created_at::text AS "createdAt"
          FROM mbox.activity_service_receipts receipt JOIN mbox.activity_service_lines line ON line.tenant_id=receipt.tenant_id AND line.store_id=receipt.store_id AND line.id=(receipt.request_body->>'lineId')::uuid
          LEFT JOIN mbox.employees employee ON (employee.tenant_id,employee.store_id,employee.id)=(receipt.tenant_id,receipt.store_id,receipt.employee_id)
          WHERE receipt.tenant_id=$1 AND receipt.store_id=$2 AND receipt.operation_scope='exception' AND receipt.request_body->>'action'='record_issue' AND line.meal_id=$3 ORDER BY receipt.created_at DESC LIMIT 20`, [...this.scope, mealId])).rows;
    }
    async lines(filter: {
        mealId?: string;
        station?: 'bar' | 'kitchen';
        pickup?: boolean;
    } = {}): Promise<ActivityServiceLine[]> {
        const result = await this.tx.query<{
            value: ActivityServiceLine;
        }>(`SELECT jsonb_build_object('id',l.id,'taskId',k.id,'registrationPublicId',r.public_id,'mealId',m.id,'number',m.number,'location',m.location,'activityTitle',a.title,'packageName',COALESCE(r.activity_package_snapshot->>'name','活动单点'),'productId',l.product_id,'name',l.product_snapshot->>'name','station',l.station_code,'quantity',l.quantity,'startedQuantity',l.started_quantity,'readyQuantity',l.ready_quantity,'takenQuantity',l.taken_quantity,'version',l.version,'held',l.held,'stoppedQuantity',l.stopped_quantity,'discardedReadyQuantity',l.discarded_ready_quantity,'remadeTakenQuantity',l.remade_taken_quantity,'sourceRef',l.source_ref,'note',l.product_snapshot->>'note','selectionLabel',l.product_snapshot->>'selectionLabel','status',l.status,'createdAt',l.created_at) value FROM mbox.activity_service_lines l JOIN mbox.activity_meals m ON (m.tenant_id,m.store_id,m.id)=(l.tenant_id,l.store_id,l.meal_id) JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(l.tenant_id,l.store_id,l.registration_id) JOIN mbox.community_activities a ON (a.tenant_id,a.store_id,a.id)=(r.tenant_id,r.store_id,r.activity_id) LEFT JOIN mbox.kds_tasks k ON (k.tenant_id,k.store_id,k.activity_service_line_id)=(l.tenant_id,l.store_id,l.id) WHERE l.tenant_id=$1 AND l.store_id=$2 AND ($3::uuid IS NULL OR m.id=$3) AND ($4::text IS NULL OR l.station_code=$4) AND ($5::boolean=false OR l.ready_quantity>l.taken_quantity+l.discarded_ready_quantity) AND ($3::uuid IS NOT NULL OR (l.status='active' AND l.taken_quantity+l.discarded_ready_quantity+l.stopped_quantity<l.quantity)) ORDER BY m.redeemed_at,m.id,l.created_at,l.id`, [...this.scope, filter.mealId ?? null, filter.station ?? null, filter.pickup ?? false]);
        return result.rows.map(r => r.value);
    }
    async door(publicId: string, command: ActivityDoorCommand, key: string, employeeId: string, businessDate: string): Promise<ActivityServiceView> {
        const r = await this.registration(publicId, true), scope = `door:${r.id}`;
        const old = await this.previous<ActivityServiceView>(scope, key, command);
        if (old)
            return old;
        this.assertPaid(r);
        await assertActivityServiceAvailable(this.tx, r.id);
        await this.tx.query(`SELECT id FROM mbox.community_activity_registrations WHERE tenant_id=$1 AND store_id=$2 AND parent_registration_id=$3 AND purchase_kind='single_dish' ORDER BY id FOR UPDATE`, [...this.scope, r.id]);
        const take = command.action === 'redeem' || command.action === 'admit_and_redeem', admit = command.action === 'admit' || command.action === 'admit_and_redeem';
        if (admit || take)
            this.checkCredential(r, command.credential);
        if (admit) {
            await this.within(r, false);
            if (!r.includes_admission || !Number.isSafeInteger(command.arrivedCount) || command.arrivedCount! < 1)
                fail('请选择本次实际首次到场人数');
            const count = Number((await this.tx.query<{
                n: number;
            }>('SELECT COALESCE(sum(quantity),0)::int n FROM mbox.activity_admission_batches WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3', [...this.scope, r.id])).rows[0]!.n);
            if (count + command.arrivedCount! > r.reserved_seats)
                fail('本次到场人数超过剩余入场额度', 'ACTIVITY_ADMISSION_EXCEEDED');
            await this.tx.query('INSERT INTO mbox.activity_admission_batches(tenant_id,store_id,registration_id,operation_key,quantity,employee_id) VALUES($1,$2,$3,$4,$5,$6)', [...this.scope, r.id, key, command.arrivedCount, employeeId]);
        }
        if (take) {
            await this.within(r, true);
            await this.redeem(r, employeeId, businessDate, command.location);
        }
        const meal = (await this.tx.query<{
            id: string;
            number: number;
            plaque_state: string;
            business_date: string;
        }>(`SELECT id,number,plaque_state,business_date::text FROM mbox.activity_meals WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3 FOR UPDATE`, [...this.scope, r.purchase_kind === 'single_dish' ? r.parent_registration_id : r.id])).rows[0];
        if (command.action === 'update_location') {
            if (!meal)
                fail('尚未生成取餐号');
            if (!command.location?.trim())
                fail('请填写新的收餐位置');
            await this.tx.query('UPDATE mbox.activity_meals SET location=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3', [...this.scope, meal!.id, command.location!.trim()]);
        }
        if (command.action === 'recover') {
            if (meal?.plaque_state === 'returned')
                fail('请先恢复原号持牌关系再补齐制作');
            if (!meal)
                fail('尚未餐饮核销，请先核对套餐码');
            await this.ensureLines(meal!.id, r.id);
            await this.recoverChildren(meal!.id, r.id);
        }
        if (['plaque_issued', 'return_plaque', 'restore_plaque'].includes(command.action)) {
            if (!meal)
                fail('尚未生成取餐号');
            if (command.action === 'restore_plaque') {
                await this.within(r, true);
                await this.numberLock();
                const conflict = (await this.tx.query(`SELECT 1 FROM mbox.activity_meals WHERE tenant_id=$1 AND store_id=$2 AND number=$3 AND id<>$4 AND (number_active OR business_date=$5::date)`, [...this.scope, meal!.number, meal!.id, businessDate])).rowCount;
                if (conflict)
                    fail('原号已被使用，请由领班安排有效收餐点', 'ACTIVITY_NUMBER_OCCUPIED');
            }
            if (command.action === 'plaque_issued' && meal!.plaque_state === 'returned')
                fail('请先恢复原号持牌关系');
            await this.tx.query(`UPDATE mbox.activity_meals SET plaque_state=$4,location=COALESCE($5,location),closed_at=CASE WHEN $4='returned' THEN clock_timestamp() ELSE NULL END,number_active=CASE WHEN $4<>'returned' THEN true ELSE EXISTS(SELECT 1 FROM mbox.activity_service_lines l WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.meal_id=$3 AND l.status='active' AND l.taken_quantity+l.discarded_ready_quantity+l.stopped_quantity<l.quantity) END WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.scope, meal!.id, command.action === 'return_plaque' ? 'returned' : 'issued', command.location ?? null]);
        }
        if (command.action === 'restore_plaque' && meal)
            await this.recoverChildren(meal.id, r.id);
        if (meal)
            await refreshActivityMealNumber(this.tx, meal.id);
        const view = await this.view(publicId);
        await this.persist(scope, key, command, view, employeeId);
        return view;
    }
    private async numberLock() { await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended('activity-number:'||$1,0))", [this.tx.scope.storeId]); }
    private async redeem(r: Registration, employeeId: string, businessDate: string, location?: string) {
        if (r.purchase_kind === 'single_dish')
            fail('单点随关联套餐核销，不单独领取号码');
        await this.numberLock();
        let meal = (await this.tx.query<{
            id: string;
        }>(`SELECT id FROM mbox.activity_meals WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3`, [...this.scope, r.id])).rows[0];
        if (!meal) {
            if (!r.service_has_meal && !r.service_items_snapshot.length && !await this.hasPaidMealChild(r.id))
                fail('此报名只有入场权益，没有餐饮内容');
            meal = (await this.tx.query<{
                id: string;
            }>(`INSERT INTO mbox.activity_meals(tenant_id,store_id,registration_id,business_date,number,redeemed_by_employee_id,location) SELECT $1,$2,$3,$4::date,COALESCE(max(number),0)+1,$5,$6 FROM mbox.activity_meals WHERE tenant_id=$1 AND store_id=$2 AND (business_date=$4::date OR number_active) RETURNING id`, [...this.scope, r.id, businessDate, employeeId, location ?? null])).rows[0]!;
        }
        await this.ensureLines(meal.id, r.id);
        await this.recoverChildren(meal.id, r.id);
    }
    private async hasPaidMealChild(registrationId: string) { return Boolean((await this.tx.query(`SELECT 1 FROM mbox.community_activity_registrations WHERE tenant_id=$1 AND store_id=$2 AND parent_registration_id=$3 AND purchase_kind='single_dish' AND (payment_status='paid' OR (payment_status='not_required' AND fee_amount_minor=0) OR (payment_status='refunded' AND service_refund_disposition IS NOT NULL)) AND status IN('confirmed','checked_in') LIMIT 1`, [...this.scope, registrationId])).rowCount); }
    private async recoverChildren(mealId: string, registrationId: string) {
        const children = await this.tx.query<{
            id: string;
        }>(`SELECT id FROM mbox.community_activity_registrations WHERE tenant_id=$1 AND store_id=$2 AND parent_registration_id=$3 AND purchase_kind='single_dish' AND (payment_status='paid' OR (payment_status='not_required' AND fee_amount_minor=0) OR (payment_status='refunded' AND service_refund_disposition IS NOT NULL)) AND status IN('confirmed','checked_in') ORDER BY id`, [...this.scope, registrationId]);
        for (const child of children.rows)
            await this.ensureLines(mealId, child.id);
    }
    async dispatchPaidAddon(registrationId: string) {
        const row = (await this.tx.query<{
            meal_id: string;
        }>(`SELECT meal.id meal_id FROM mbox.community_activity_registrations r JOIN mbox.activity_meals meal ON (meal.tenant_id,meal.store_id,meal.registration_id)=(r.tenant_id,r.store_id,r.parent_registration_id) WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id=$3 AND r.purchase_kind='single_dish' AND (r.payment_status='paid' OR (r.payment_status='not_required' AND r.fee_amount_minor=0) OR (r.payment_status='refunded' AND r.service_refund_disposition IS NOT NULL)) AND r.status IN('confirmed','checked_in') AND meal.plaque_state<>'returned' FOR UPDATE OF meal`, [...this.scope, registrationId])).rows[0];
        if (!row)
            return;
        // A failed production adapter must not erase the channel's successful payment.
        await this.tx.query('SAVEPOINT activity_paid_dispatch');
        try {
            await this.ensureLines(row.meal_id, registrationId);
            await this.tx.query('RELEASE SAVEPOINT activity_paid_dispatch');
        }
        catch (error) {
            await this.tx.query('ROLLBACK TO SAVEPOINT activity_paid_dispatch');
            await this.tx.query('RELEASE SAVEPOINT activity_paid_dispatch');
            if (['40001', '40P01'].includes(String((error as {
                code?: string;
            }).code)))
                throw error;
            await appendOutboxMessage(this.tx, { businessEventKey: `activity-dispatch-pending:${registrationId}`, aggregateType: 'community_activity_registration', aggregateId: registrationId, aggregateVersion: 1, eventType: 'activity.meal.dispatch.pending.v1', payload: { registrationId, mealId: row.meal_id, reason: 'production_retry_required' }, occurredAt: new Date().toISOString() });
        }
    }
    async ensureLines(mealId: string, registrationId: string) {
        const r = (await this.tx.query<Registration>(`SELECT * FROM mbox.community_activity_registrations WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`, [...this.scope, registrationId])).rows[0]!;
        this.assertPaid(r);
        await assertActivityServiceAvailable(this.tx, r.id);
        for (const item of r.service_items_snapshot) {
            const line = (await this.tx.query<{
                id: string;
                created_at: string;
            }>(`INSERT INTO mbox.activity_service_lines(tenant_id,store_id,meal_id,registration_id,product_id,product_snapshot,station_code,quantity) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(tenant_id,store_id,registration_id,product_id,source_ref) DO UPDATE SET product_id=EXCLUDED.product_id RETURNING id,created_at::text`, [...this.scope, mealId, r.id, item.productId, JSON.stringify(item), item.station, item.quantity])).rows[0]!;
            await this.tx.query(`INSERT INTO mbox.kds_tasks(tenant_id,store_id,activity_service_line_id,station_code,quantity,status) VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT(tenant_id,store_id,activity_service_line_id) WHERE activity_service_line_id IS NOT NULL DO NOTHING`, [...this.scope, line.id, item.station, item.quantity]);
            await appendOutboxMessage(this.tx, { businessEventKey: `activity-meal-line:${line.id}`, aggregateType: 'activity_service_line', aggregateId: line.id, aggregateVersion: 1, eventType: 'activity.meal.line.created.v1', payload: { lineId: line.id }, occurredAt: line.created_at });
        }
    }
    async production(command: ActivityProductionCommand, key: string, employeeId: string | null, source?: ActivityProductionResult['source']): Promise<ActivityProductionResult> {
        const scope = 'production';
        const old = await this.previous<ActivityProductionResult>(scope, key, command);
        if (old)
            return old;
        if (!command.lines.length || command.lines.length > 100 || new Set(command.lines.map(l => l.lineId)).size !== command.lines.length)
            fail('请选择不重复的实际出品');
        const ids = command.lines.map(l => l.lineId).sort();
        // Lock purchase roots before their children and before meal/line rows, matching door and payment dispatch.
        await this.tx.query(`SELECT r.id FROM mbox.community_activity_registrations r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id IN (SELECT l.registration_id FROM mbox.activity_service_lines l WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.id=ANY($3::uuid[]) UNION SELECT m.registration_id FROM mbox.activity_service_lines l JOIN mbox.activity_meals m ON (m.tenant_id,m.store_id,m.id)=(l.tenant_id,l.store_id,l.meal_id) WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.id=ANY($3::uuid[])) ORDER BY (r.purchase_kind='single_dish'),r.id FOR UPDATE`, [...this.scope, ids]);
        const rows = (await this.tx.query<{
            id: string;
            registration_id: string;
            meal_id: string;
            station_code: 'bar' | 'kitchen';
            source_ref: string;
            product_id: string;
            quantity: number;
            started_quantity: number;
            ready_quantity: number;
            taken_quantity: number;
            version: number;
            held: boolean;
            stopped_quantity: number;
            discarded_ready_quantity: number;
            status: string;
        }>(`SELECT * FROM mbox.activity_service_lines WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`, [...this.scope, ids])).rows;
        if (rows.length !== ids.length)
            fail('部分活动出品不存在');
        if (command.action === 'undo_take') {
            if (command.physicalStillAtPickupPoint !== true || !command.receiptId)
                fail('只有实物仍在出餐口才能撤回取走');
            const receipt = (await this.tx.query<{
                request_body: ActivityProductionCommand;
                undone_at: string | null;
                result: ActivityProductionResult;
            }>(`SELECT request_body,undone_at,result FROM mbox.activity_service_receipts WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND operation_scope='production' FOR UPDATE`, [...this.scope, command.receiptId])).rows[0];
            if (!receipt || receipt.undone_at || receipt.request_body.action !== 'take' || receipt.result.lines.some(previous => !rows.some(current => current.id === previous.id && current.version === previous.version)) || JSON.stringify(receipt.request_body.lines.map(l => ({ lineId: l.lineId, quantity: l.quantity })).sort((a, b) => a.lineId.localeCompare(b.lineId))) !== JSON.stringify(command.lines.map(l => ({ lineId: l.lineId, quantity: l.quantity })).sort((a, b) => a.lineId.localeCompare(b.lineId))))
                fail('原取走批次已撤回或份数不一致');
            await this.tx.query('UPDATE mbox.activity_service_receipts SET undone_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3', [...this.scope, command.receiptId]);
        }
        if (command.action === 'take' && new Set(rows.map(r => r.meal_id)).size !== 1)
            fail('请按同一个取餐号选择本批实际取走数量');
        for (const row of rows) {
            await assertActivityServiceAvailable(this.tx, row.registration_id);
            const part = command.lines.find(p => p.lineId === row.id)!;
            if (row.status !== 'active' || row.held || row.version !== part.expectedVersion || !Number.isSafeInteger(part.quantity) || part.quantity < 1)
                fail('出品数量刚有变化，请核对原批次', 'ACTIVITY_SERVICE_STALE');
            const field = command.action === 'start' ? 'started_quantity' : command.action === 'ready' ? 'ready_quantity' : 'taken_quantity';
            const available = command.action === 'start' ? row.quantity - row.started_quantity - row.stopped_quantity : command.action === 'ready' ? row.started_quantity - row.ready_quantity : command.action === 'take' ? row.ready_quantity - row.taken_quantity - row.discarded_ready_quantity : row.taken_quantity;
            if (part.quantity > available)
                fail('本批数量超过当前可操作份数', 'ACTIVITY_SERVICE_STALE');
            if (command.action === 'start')
                await this.consumeInventory(row.registration_id, row.product_id, row.started_quantity + part.quantity, row.quantity, employeeId, row.source_ref);
            await this.tx.query(`UPDATE mbox.activity_service_lines SET ${field}=${field}+$4,version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.scope, row.id, command.action === 'undo_take' ? -part.quantity : part.quantity]);
        }
        // Mirror quantity state into the existing KDS record; activity receipt is the durable command history.
        await this.tx.query(`UPDATE mbox.kds_tasks k SET status=CASE WHEN l.ready_quantity+l.stopped_quantity=l.quantity THEN 'ready' WHEN l.started_quantity>0 THEN 'preparing' ELSE 'pending' END,ready_at=CASE WHEN l.ready_quantity+l.stopped_quantity=l.quantity THEN COALESCE(k.ready_at,clock_timestamp()) ELSE NULL END,updated_at=clock_timestamp() FROM mbox.activity_service_lines l WHERE (k.tenant_id,k.store_id,k.activity_service_line_id)=(l.tenant_id,l.store_id,l.id) AND l.tenant_id=$1 AND l.store_id=$2 AND l.id=ANY($3::uuid[])`, [...this.scope, ids]);
        for (const mealId of new Set(rows.map(row => row.meal_id)))
            await refreshActivityMealNumber(this.tx, mealId);
        const receiptId = randomUUID(), lines = (await Promise.all([...new Set(rows.map(r => r.meal_id))].map(mealId => this.lines({ mealId })))).flat().filter(l => ids.includes(l.id));
        const result = { receiptId, action: command.action, lines, command, ...(source ? { source } : {}), canUndo: command.action === 'take' };
        await this.persist(scope, key, command, result, employeeId, receiptId);
        return result;
    }
    async consumeInventory(registrationId: string, productId: string, startedQuantity: number, totalQuantity: number, employeeId: string | null, sourceRef = 'original') {
        const held = await this.tx.query<{
            id: string;
            inventory_item_id: string;
            amount: string;
        }>(`SELECT id,inventory_item_id,GREATEST(0,LEAST(quantity-consumed_quantity-released_quantity,round(quantity*$5::numeric/$6::numeric,6)-consumed_quantity))::numeric(18,6)::text amount FROM mbox.activity_service_inventory WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3 AND product_id=$4 AND source_ref=$7 AND status='reserved' ORDER BY inventory_item_id FOR UPDATE`, [...this.scope, registrationId, productId, startedQuantity, totalQuantity, sourceRef]);
        for (const stock of held.rows) {
            if (Number(stock.amount) <= 0)
                continue;
            const cost = (await this.tx.query<{
                weighted_unit_cost_minor: string | null;
            }>(`SELECT weighted_unit_cost_minor::text FROM mbox.inventory_balances WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 FOR UPDATE`, [...this.scope, stock.inventory_item_id])).rows[0];
            const movement = (await this.tx.query<{
                id: string;
            }>(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,unit_cost_minor,reference_type,reference_id,reason,created_by_employee_id,metadata) VALUES($1,$2,$3,'sale',-$4::numeric,$7::numeric,'activity_service',$5,'活动餐饮开始制作',$6,$8::jsonb) RETURNING id`, [...this.scope, stock.inventory_item_id, stock.amount, registrationId, employeeId, cost?.weighted_unit_cost_minor ?? null, JSON.stringify({ productId, startedQuantity, sourceRef })])).rows[0]!;
            const changed = await this.tx.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=on_hand_quantity-$4::numeric,reserved_quantity=reserved_quantity-$4::numeric,last_movement_id=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND on_hand_quantity>=$4::numeric AND reserved_quantity>=$4::numeric`, [...this.scope, stock.inventory_item_id, stock.amount, movement.id]);
            if (changed.rowCount !== 1)
                fail('原活动库存预留需要核对');
            await this.tx.query(`UPDATE mbox.activity_service_inventory SET consumed_quantity=consumed_quantity+$4::numeric,status=CASE WHEN consumed_quantity+$4::numeric+released_quantity>=quantity THEN 'consumed' ELSE 'reserved' END,movement_id=$5 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.scope, stock.id, stock.amount, movement.id]);
        }
    }
    async receipts(): Promise<ActivityProductionResult[]> {
        const rows = (await this.tx.query<{
            result: ActivityProductionResult;
            undone_at: string | null;
        }>(`SELECT result,undone_at FROM mbox.activity_service_receipts WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='production' AND request_body->>'action'='take' ORDER BY created_at DESC,id DESC LIMIT 50`, this.scope)).rows;
        const ids = [...new Set(rows.flatMap(r => r.result.lines.map(l => l.id)))];
        const current = (await this.tx.query<{
            id: string;
            version: number;
            status: string;
        }>('SELECT id,version,status FROM mbox.activity_service_lines WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])', [...this.scope, ids])).rows;
        return rows.map(r => ({ ...r.result, canUndo: !r.undone_at && r.result.lines.every(line => current.some(c => c.id === line.id && c.version === line.version && c.status === 'active')) }));
    }
    async previous<T>(scope: string, key: string, body: unknown): Promise<T | null> {
        const row = (await this.tx.query<{
            same: boolean;
            result: T;
        }>(`SELECT request_body=$5::jsonb same,result FROM mbox.activity_service_receipts WHERE tenant_id=$1 AND store_id=$2 AND operation_scope=$3 AND operation_key=$4`, [...this.scope, scope, key, JSON.stringify(body)])).rows[0];
        if (!row)
            return null;
        if (!row.same)
            throw new IdempotencyConflictError(scope, key);
        return row.result;
    }
    async persist(scope: string, key: string, body: unknown, result: unknown, employeeId: string | null, id = randomUUID()) { await this.tx.query(`INSERT INTO mbox.activity_service_receipts(id,tenant_id,store_id,operation_scope,operation_key,request_body,result,employee_id) VALUES($3,$1,$2,$4,$5,$6::jsonb,$7::jsonb,$8)`, [...this.scope, id, scope, key, JSON.stringify(body), JSON.stringify(result), employeeId]); }
}
export async function assertActivityUnusedRefund(tx: ScopedTransaction, registrationId: string) {
    const row = (await tx.query<{
        used: boolean;
        dependent: boolean;
    }>(`SELECT (EXISTS(SELECT 1 FROM mbox.activity_admission_batches b WHERE (b.tenant_id,b.store_id,b.registration_id)=(r.tenant_id,r.store_id,r.id)) OR EXISTS(SELECT 1 FROM mbox.activity_service_lines l WHERE (l.tenant_id,l.store_id,l.registration_id)=(r.tenant_id,r.store_id,r.id)) OR EXISTS(SELECT 1 FROM mbox.activity_meals m WHERE (m.tenant_id,m.store_id,m.registration_id)=(r.tenant_id,r.store_id,r.id))) used,EXISTS(SELECT 1 FROM mbox.community_activity_registrations child WHERE (child.tenant_id,child.store_id,child.parent_registration_id)=(r.tenant_id,r.store_id,r.id) AND child.status IN('payment_pending','confirmed','checked_in') AND (child.payment_status IN('pending','paid') OR (child.payment_status='not_required' AND child.fee_amount_minor=0) OR child.service_refund_disposition IS NOT NULL)) dependent FROM mbox.community_activity_registrations r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id=$3 AND r.service_version=3 FOR UPDATE OF r`, [tx.scope.tenantId, tx.scope.storeId, registrationId])).rows[0];
    if (row?.used)
        fail('所含权益已有使用，请由领班核对后按原售后规则处理', 'ACTIVITY_USED_REFUND_REVIEW');
    if (row?.dependent)
        fail('仍有关联加购，请先处理其退款或有效履约归属', 'ACTIVITY_DEPENDENT_REFUND_REVIEW');
}
export async function assertActivityServiceAvailable(tx: ScopedTransaction, registrationId: string) {
    const pending = await tx.query(`SELECT 1 FROM mbox.refunds refund JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)=(refund.tenant_id,refund.store_id,refund.payment_id) WHERE payment.tenant_id=$1 AND payment.store_id=$2 AND payment.activity_registration_id=$3 AND (refund.status IN('requested','approved','processing') OR (refund.status='failed' AND refund.approved_by_employee_id IS NOT NULL)) LIMIT 1`, [tx.scope.tenantId, tx.scope.storeId, registrationId]);
    if (pending.rowCount)
        throw new ActivityServiceError('本份退款处理中，请查回原退款结果后再操作', 'ACTIVITY_REFUND_PENDING');
}
