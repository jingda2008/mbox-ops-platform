import type { ActivityPackageChoiceGroup } from '../../src/shared/activity-service.js';
import type { ScopedTransaction } from './transaction-runner.js';
import { ActivityServiceError, assertActivityServiceAvailable, parseActivityCredential } from './activity-service-repository.js';
import { OrderRepository } from './order-repository.js';
export type ActivityMealItem = {
    productId: string;
    name: string;
    station: 'bar' | 'kitchen';
    categoryCode?: string | null;
    quantity: number;
    unitPriceMinor?: number;
    priceType?: string;
    note?: string;
    selectionLabel?: string;
};
export interface ActivityPurchaseOptions {
    purchaseKind?: 'admission_package' | 'meal_package' | 'single_dish';
    parentRegistrationPublicId?: string | null;
    parentCredential?: string;
    productId?: string;
    quantity?: number;
    selections?: Array<{
        groupId: string;
        productId: string;
    }>;
    note?: string;
}
export async function prepareActivityPurchase(tx: ScopedTransaction, input: ActivityPurchaseOptions & {
    customerId: string;
    activityId: string;
    packageId: string | null;
    maxParticipants: number | null;
    partySize: number;
    packageIncludesAdmission: boolean;
    mealOnlyAmount: number | null;
    packageHasMeal?: boolean;
    choiceGroups?: ActivityPackageChoiceGroup[];
}) {
    const scope = [tx.scope.tenantId, tx.scope.storeId], kind = input.purchaseKind ?? (input.packageIncludesAdmission ? 'admission_package' : 'meal_package');
    if (input.maxParticipants === null && input.purchaseKind === undefined)
        return null;
    if (kind === 'admission_package' && !input.packageIncludesAdmission)
        throw new ActivityServiceError('此套餐不包含入场权益', 'ACTIVITY_PACKAGE_ADMISSION_NOT_INCLUDED');
    if (kind !== 'single_dish' && !input.packageId)
        throw new ActivityServiceError('请选择明确的活动套餐', 'ACTIVITY_PACKAGE_SELECTION_REQUIRED', 400);
    const maxParticipants = kind === 'single_dish' ? 1 : input.maxParticipants ?? input.partySize;
    if (!Number.isSafeInteger(input.partySize) || input.partySize < 1 || input.partySize > maxParticipants)
        throw new ActivityServiceError('参加人数必须在套餐允许范围内', 'ACTIVITY_PARTY_SIZE_INVALID', 400);
    const authorizedParent = input.parentCredential ? parseActivityCredential(input.parentCredential) : null;
    if (authorizedParent && (kind !== 'single_dish' || authorizedParent.publicId !== input.parentRegistrationPublicId))
        throw new ActivityServiceError('请重新扫描要关联的原套餐码', 'ACTIVITY_CREDENTIAL_INVALID', 403);
    let parentId: string | null = null;
    if (kind !== 'admission_package') {
        const parent = (await tx.query<{
            id: string;
            payment_status: string;
            fee_amount_minor: string;
            service_refund_disposition: string | null;
            status: string;
            closed_at: string | null;
            meal_id: string | null;
        }>(`SELECT r.id,r.payment_status,r.fee_amount_minor,r.service_refund_disposition,r.status,m.closed_at,m.id meal_id FROM mbox.community_activity_registrations r LEFT JOIN mbox.activity_meals m ON (m.tenant_id,m.store_id,m.registration_id)=(r.tenant_id,r.store_id,r.id) WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.public_id=$3 AND (mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=$4 OR ($6::text='single_dish' AND r.credential_token=$7::uuid)) AND r.activity_id=$5 AND ($6::text='meal_package' OR (r.service_version=3 AND r.purchase_kind IN('admission_package','meal_package'))) FOR UPDATE OF r`, [...scope, input.parentRegistrationPublicId ?? null, input.customerId, input.activityId, kind, authorizedParent?.token ?? null])).rows[0];
        if (!parent || !(parent.payment_status === 'paid' || (parent.payment_status === 'refunded' && parent.service_refund_disposition !== null) || (parent.payment_status === 'not_required' && Number(parent.fee_amount_minor) === 0)) || !['confirmed', 'checked_in'].includes(parent.status))
            throw new ActivityServiceError('请从本人的有效活动报名进入加购', 'ACTIVITY_ADDON_PARENT_REQUIRED');
        if (parent.closed_at)
            throw new ActivityServiceError('请先恢复原取餐号持牌关系再加购', 'ACTIVITY_MEAL_CLOSED');
        await assertActivityServiceAvailable(tx, parent.id);
        parentId = parent.id;
    }
    let items: ActivityMealItem[] = [], amount: number | null = null, deadline: string | null = null;
    if (kind === 'single_dish') {
        const policy = (await tx.query<{
            allowed: boolean;
        }>(`SELECT $4::uuid=ANY(addon_product_ids) AND clock_timestamp()<COALESCE(addon_ends_at,ends_at) AS allowed FROM mbox.community_activities WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...scope, input.activityId, input.productId ?? null])).rows[0];
        if (!policy?.allowed)
            throw new ActivityServiceError('该菜品不在本活动加购菜单或已停售', 'ACTIVITY_ADDON_UNAVAILABLE');
        const quote = await new OrderRepository(tx, input.customerId).quoteCurrent([{ productId: input.productId!, quantity: input.quantity ?? 1 }], 'guest_qr', true);
        amount = quote.subtotalAmountMinor;
        deadline = quote.purchaseDeadline;
        if (quote.items.some(item => item.bundle))
            throw new ActivityServiceError('活动单点请选择明确的单个菜品', 'ACTIVITY_ADDON_SINGLE_DISH_ONLY');
        const product = (await tx.query<{
            name: string;
            fulfillment_station: string;
            category_code: string;
        }>(`SELECT name,fulfillment_station,category_code FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...scope, input.productId])).rows[0]!;
        if (!['bar', 'kitchen'].includes(product.fulfillment_station))
            throw new ActivityServiceError('该商品未配置制作岗位', 'ACTIVITY_PRODUCT_STATION_REQUIRED');
        items = [{ productId: input.productId!, name: product.name, station: product.fulfillment_station as 'bar' | 'kitchen', categoryCode: product.category_code, quantity: input.quantity ?? 1, unitPriceMinor: quote.items[0]!.unitPriceMinor, priceType: quote.items[0]!.priceType }];
    }
    else if (input.packageId) {
        const products = (await tx.query<{
            product_id: string;
            name: string;
            fulfillment_station: string;
            category_code: string;
            quantity: number;
            status: string;
        }>(`SELECT p.id product_id,p.name,p.fulfillment_station,p.category_code,part.quantity,p.status FROM mbox.activity_package_products part JOIN mbox.products p ON (p.tenant_id,p.store_id,p.id)=(part.tenant_id,part.store_id,part.product_id) WHERE part.tenant_id=$1 AND part.store_id=$2 AND part.package_id=$3 ORDER BY p.id FOR KEY SHARE OF p`, [...scope, input.packageId])).rows;
        if (products.some(p => p.status !== 'active' || !['bar', 'kitchen'].includes(p.fulfillment_station)))
            throw new ActivityServiceError('套餐菜品或制作岗位尚未配置好', 'ACTIVITY_PACKAGE_PRODUCTS_INVALID');
        items = products.map(p => ({ productId: p.product_id, name: p.name, station: p.fulfillment_station as 'bar' | 'kitchen', categoryCode: p.category_code, quantity: p.quantity }));
        if (kind === 'meal_package' && input.packageIncludesAdmission) {
            if (input.mealOnlyAmount === null)
                throw new ActivityServiceError('该套餐尚未设置纯加餐价格', 'ACTIVITY_MEAL_PRICE_REQUIRED');
            amount = input.mealOnlyAmount;
        }
    }
    const groups = input.choiceGroups ?? [], selections = input.selections ?? [];
    if (selections.length !== groups.length || new Set(selections.map(s => s.groupId)).size !== selections.length)
        throw new ActivityServiceError('请完成每一组固定自选项', 'ACTIVITY_SELECTION_REQUIRED', 400);
    for (const group of groups) {
        const selected = selections.find(s => s.groupId === group.id);
        if (!selected || !group.productIds.includes(selected.productId))
            throw new ActivityServiceError('自选菜品不在本套餐允许范围内', 'ACTIVITY_SELECTION_INVALID', 400);
        const product = (await tx.query<{
            name: string;
            fulfillment_station: 'bar' | 'kitchen';
            category_code: string;
        }>(`SELECT name,fulfillment_station,category_code FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND product_kind='single' AND status='active' AND fulfillment_station IN('bar','kitchen') FOR KEY SHARE`, [...scope, selected.productId])).rows[0];
        if (!product)
            throw new ActivityServiceError('所选菜品当前无法供应，请重新选择', 'ACTIVITY_SELECTION_UNAVAILABLE');
        items.push({ productId: selected.productId, name: product.name, station: product.fulfillment_station, categoryCode: product.category_code, quantity: group.quantity, selectionLabel: group.name });
    }
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.trim().length > 200))
        throw new ActivityServiceError('必要备注限200字', 'ACTIVITY_NOTE_INVALID', 400);
    const combined = new Map<string, ActivityMealItem>();
    for (const item of items) {
        const previous = combined.get(item.productId);
        if (previous) {
            previous.quantity += item.quantity;
            previous.selectionLabel = [previous.selectionLabel, item.selectionLabel].filter(Boolean).join('、');
        }
        else
            combined.set(item.productId, { ...item });
    }
    items = [...combined.values()].map(item => ({ ...item, ...(input.note?.trim() ? { note: input.note.trim() } : {}) }));
    const policy = (await tx.query<{
        deadline: string;
    }>(`SELECT LEAST(COALESCE(addon_ends_at,ends_at),COALESCE(meal_service_ends_at,ends_at))::text deadline FROM mbox.community_activities WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...scope, input.activityId])).rows[0]!;
    if (kind !== 'admission_package') {
        if (Date.parse(policy.deadline) <= Date.now())
            throw new ActivityServiceError('本活动加购已截止', 'ACTIVITY_ADDON_UNAVAILABLE');
        deadline = deadline && Date.parse(deadline) < Date.parse(policy.deadline) ? deadline : policy.deadline;
    }
    return { hasMeal: kind === 'single_dish' || input.packageHasMeal === true || items.length > 0, kind, maxParticipants, includesAdmission: kind === 'admission_package', reservedSeats: kind === 'admission_package' ? maxParticipants : 0, parentId, items, amount, deadline };
}
export async function reserveActivityMealInventory(tx: ScopedTransaction, registrationId: string, items: ActivityMealItem[]) {
    if (!items.length)
        return;
    const scope = [tx.scope.tenantId, tx.scope.storeId], json = JSON.stringify(items);
    const missing = (await tx.query(`SELECT p.id FROM jsonb_to_recordset($3::jsonb) AS item("productId" uuid,quantity int) JOIN mbox.products p ON p.tenant_id=$1 AND p.store_id=$2 AND p.id=item."productId" WHERE p.inventory_control_mode='tracked' AND NOT EXISTS(SELECT 1 FROM mbox.recipes recipe JOIN mbox.recipe_items ri ON (ri.tenant_id,ri.store_id,ri.recipe_id)=(recipe.tenant_id,recipe.store_id,recipe.id) WHERE recipe.tenant_id=$1 AND recipe.store_id=$2 AND recipe.product_id=p.id AND recipe.status='active' AND recipe.effective_at<=clock_timestamp())`, [...scope, json])).rowCount;
    if (missing)
        throw new ActivityServiceError('套餐菜品缺少有效库存配方', 'ACTIVITY_RECIPE_REQUIRED');
    const demands = (await tx.query<{
        product_id: string;
        inventory_item_id: string;
        quantity: string;
    }>(`SELECT p.id product_id,ri.inventory_item_id,sum((ri.quantity+ri.expected_waste_quantity)*item.quantity/recipe.yield_quantity)::numeric(18,6)::text quantity FROM jsonb_to_recordset($3::jsonb) AS item("productId" uuid,quantity int) JOIN mbox.products p ON p.tenant_id=$1 AND p.store_id=$2 AND p.id=item."productId" AND p.inventory_control_mode='tracked' JOIN LATERAL (SELECT candidate.* FROM mbox.recipes candidate WHERE candidate.tenant_id=$1 AND candidate.store_id=$2 AND candidate.product_id=p.id AND candidate.status='active' AND candidate.effective_at<=clock_timestamp() ORDER BY candidate.effective_at DESC,candidate.id DESC LIMIT 1) recipe ON true JOIN mbox.recipe_items ri ON (ri.tenant_id,ri.store_id,ri.recipe_id)=(recipe.tenant_id,recipe.store_id,recipe.id) GROUP BY p.id,ri.inventory_item_id ORDER BY ri.inventory_item_id,p.id`, [...scope, json])).rows;
    for (const demand of demands) {
        const result = await tx.query(`UPDATE mbox.inventory_balances b SET reserved_quantity=reserved_quantity+$4::numeric,updated_at=clock_timestamp() WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.inventory_item_id=$3 AND b.on_hand_quantity-b.reserved_quantity>=$4::numeric AND EXISTS(SELECT 1 FROM mbox.inventory_items i WHERE (i.tenant_id,i.store_id,i.id)=(b.tenant_id,b.store_id,b.inventory_item_id) AND i.status='active')`, [...scope, demand.inventory_item_id, demand.quantity]);
        if (result.rowCount !== 1)
            throw new ActivityServiceError('活动菜品库存不足，本次未占用名额', 'ACTIVITY_INVENTORY_INSUFFICIENT');
        await tx.query(`INSERT INTO mbox.activity_service_inventory(tenant_id,store_id,registration_id,product_id,inventory_item_id,quantity,status) VALUES($1,$2,$3,$4,$5,$6,'reserved')`, [...scope, registrationId, demand.product_id, demand.inventory_item_id, demand.quantity]);
    }
}
