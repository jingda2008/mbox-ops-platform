import { ActivityServiceError, ActivityServiceRepository, parseActivityCredential, activityCredential, assertActivityServiceAvailable } from './activity-service-repository.js';
import { CustomerRepository } from './customer-repository.js';
import { OrderRepository } from './order-repository.js';
import type { ScopedTransaction } from './transaction-runner.js';
export async function editActivityParty(tx: ScopedTransaction, customerId: string, publicId: string, partySize: number, key: string) {
    const repository = new ActivityServiceRepository(tx), r = await repository.registration(publicId, true);
    const customers = new CustomerRepository(tx), owner = await customers.resolveCanonical(String(r.customer_id)), actor = await customers.resolveCanonical(customerId);
    if (owner.id !== actor.id)
        throw new ActivityServiceError('只能修改本人的活动报名', 'ACTIVITY_OWNER_REQUIRED', 403);
    const command = { customerId: actor.id, partySize }, scope = `party:${r.id}`, previous = await repository.previous<{
        partySize: number;
    }>(scope, key, command);
    if (previous)
        return previous;
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > r.max_participants)
        throw new ActivityServiceError('人数超出本份套餐范围', 'ACTIVITY_PARTY_SIZE_INVALID', 400);
    if (!['payment_pending', 'confirmed', 'checked_in'].includes(r.status) || r.purchase_kind === 'single_dish')
        throw new ActivityServiceError('当前报名不能修改参加人数');
    const used = await tx.query(`SELECT 1 FROM mbox.activity_meals WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3`, [tx.scope.tenantId, tx.scope.storeId, r.id]);
    if (used.rowCount)
        throw new ActivityServiceError('已开始餐饮核销，请由门口人员核对原额度', 'ACTIVITY_PARTY_ALREADY_USED');
    const admitted = (await tx.query<{
        count: number;
    }>(`SELECT COALESCE(sum(quantity),0)::int count FROM mbox.activity_admission_batches WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3`, [tx.scope.tenantId, tx.scope.storeId, r.id])).rows[0]!.count;
    if (partySize < admitted)
        throw new ActivityServiceError('预计人数不能少于已经实际入场人数', 'ACTIVITY_PARTY_BELOW_ADMITTED', 400);
    await tx.query('UPDATE mbox.community_activity_registrations SET party_size=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3', [tx.scope.tenantId, tx.scope.storeId, r.id, partySize]);
    const result = { partySize };
    await repository.persist(scope, key, command, result, null);
    return result;
}
export async function activityAddonProducts(tx: ScopedTransaction, customerId: string, publicId: string) {
    const rows = (await tx.query<{
        id: string;
        name: string;
        fulfillment_station: 'bar' | 'kitchen';
        sellable: boolean;
    }>(`SELECT p.id,p.name,p.fulfillment_station,
        mbox.product_purchase_deadline(p.tenant_id,p.store_id,p.id,$4::uuid) IS NOT NULL AS sellable
        FROM mbox.community_activities a JOIN mbox.products p ON p.tenant_id=a.tenant_id AND p.store_id=a.store_id AND p.id=ANY(a.addon_product_ids) WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.public_id=$3 AND a.status IN('published','full') AND clock_timestamp()<LEAST(COALESCE(a.addon_ends_at,a.ends_at),COALESCE(a.meal_service_ends_at,a.ends_at)) AND p.status='active' AND p.product_kind='single' AND p.fulfillment_station IN('bar','kitchen') AND mbox.product_visible_now(p.tenant_id,p.store_id,p.id,$4::uuid) ORDER BY p.name,p.id`, [tx.scope.tenantId, tx.scope.storeId, publicId, customerId])).rows;
    const result = [];
    for (const row of rows) {
        if (!row.sellable) {
            result.push({ id: row.id, name: row.name, station: row.fulfillment_station, sellable: false,
                statusText: '当前未开售或已结束', priceAmountMinor: null, purchaseDeadline: null });
            continue;
        }
        try {
            const quote = await new OrderRepository(tx, customerId).quoteCurrent([{ productId: row.id, quantity: 1 }], 'guest_qr', true);
            result.push({ id: row.id, name: row.name, station: row.fulfillment_station, sellable: true,
                statusText: '', priceAmountMinor: quote.subtotalAmountMinor, purchaseDeadline: quote.purchaseDeadline });
        }
        catch (error) {
            if (error instanceof Error && ('code' in error || error.name.includes('Order')))
                continue;
            throw error;
        }
    }
    return result;
}
/** A package QR grants only an explicit same-number add-on link, never another member's prices. */
export async function resolveActivityParent(tx: ScopedTransaction, activityPublicId: string, code: string) {
    const parsed = parseActivityCredential(code);
    const repository = new ActivityServiceRepository(tx);
    const row = await repository.registration(parsed.publicId);
    if (activityCredential(row.public_id, row.credential_token) !== code.trim()
        || row.activity_public_id !== activityPublicId
        || !['admission_package', 'meal_package'].includes(row.purchase_kind))
        throw new ActivityServiceError('请扫描本活动有效套餐的专用码', 'ACTIVITY_CREDENTIAL_INVALID', 403);
    if (!['confirmed', 'checked_in'].includes(row.status)
        || !(row.payment_status === 'paid' || (row.payment_status === 'refunded' && row.service_refund_disposition !== null) || (row.payment_status === 'not_required' && Number(row.fee_amount_minor) === 0)))
        throw new ActivityServiceError('原套餐当前不能加购，请核对原单', 'ACTIVITY_ADDON_PARENT_REQUIRED');
    await assertActivityServiceAvailable(tx, row.id);
    const view = await repository.view(row.public_id);
    if (view.meal?.status === 'closed')
        throw new ActivityServiceError('请先由门口恢复原号码再加购', 'ACTIVITY_MEAL_CLOSED');
    return {
        registrationPublicId: row.public_id,
        activityPublicId: row.activity_public_id,
        activityTitle: row.activity_title,
        packageName: row.activity_package_snapshot?.name ?? '',
        number: view.meal?.number ?? null,
        plaqueState: view.meal?.plaqueState ?? null,
    };
}
/** Customer projection is deliberately independent of staff exception notes and other buyers. */
export function customerActivityServiceView(view: Awaited<ReturnType<ActivityServiceRepository['view']>>) {
    const { pendingAddonCount: _pendingAddonCount, meal, ...registration } = view;
    return {
        ...registration,
        meal: meal ? {
            id: meal.id, number: meal.number, status: meal.status,
            plaqueState: meal.plaqueState, location: meal.location,
            lines: meal.lines.filter(line => line.registrationPublicId === view.registrationPublicId).map(line => ({
                id: line.id, registrationPublicId: line.registrationPublicId, productId: line.productId,
                name: line.name, quantity: line.quantity, startedQuantity: line.startedQuantity,
                readyQuantity: line.readyQuantity, takenQuantity: line.takenQuantity,
                stoppedQuantity: line.stoppedQuantity ?? 0, status: line.status,
            })),
        } : null,
    };
}
