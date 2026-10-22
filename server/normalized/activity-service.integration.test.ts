import {validateProductPaymentWindow} from './product-payment-window.js'
import {PrintTicketSourceRepository,ActivityPrintHeldError} from './print-ticket-source.js'
import {PrintSourceWorker} from './print-source-worker.js'
import type {ActivityPackageChoiceGroup} from '../../src/shared/activity-service.js'
import {ActivityServiceExceptionRepository} from './activity-service-exception-repository.js'
import type {ActivityServiceExceptionCommand} from '../../src/shared/activity-service-exception.js'
import {CustomerExperienceRepository} from './customer-experience-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {RefundRepository} from './refund-repository.js'
import {ActivityRecollectionAuthorizationRepository} from './activity-recollection-authorization-repository.js'
import {ActivityOperationsRepository} from './activity-operations-repository.js'
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { runNormalizedMigrations } from '../migrate-normalized.js';
import { ScopedPostgresTransactionRunner } from './transaction-runner.js';
import { ActivityServiceRepository, activityCredential, assertActivityUnusedRefund } from './activity-service-repository.js';
import { reserveActivityMealInventory, prepareActivityPurchase, type ActivityMealItem } from './activity-purchase-support.js';
import { editActivityParty, resolveActivityParent, customerActivityServiceView, activityAddonProducts } from './activity-customer-service.js';
import { saveProductServiceWindow } from './product-service-window-repository.js';
import { DEFAULT_PRODUCT_SERVICE_WINDOW } from '../../src/shared/product-service-window.js';
import type { ActivityDoorCommand, ActivityProductionCommand } from '../../src/shared/activity-service.js';
const database = process.env.TEST_NORMALIZED_DATABASE_URL;
(database ? describe : describe.skip)('activity package service PostgreSQL', () => {
    const scope = { tenantId: randomUUID(), storeId: randomUUID() }, employee = randomUUID(), customer = randomUUID(), activity = randomUUID();
    let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner;
    beforeAll(async () => {
        await runNormalizedMigrations(database!);
        admin = new Pool({ connectionString: database });
        runtime = new Pool({ connectionString: process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL ?? database });
        runner = new ScopedPostgresTransactionRunner(runtime);
        await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Activity service')", [scope.tenantId]);
        await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Activity service')", [scope.storeId, scope.tenantId]);
        await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'AS','Activity service')", [employee, scope.tenantId, scope.storeId]);
        await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)", [customer, scope.tenantId, scope.storeId]);
        await admin.query(`INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,registration_payment_mode,payment_deadline_minutes,payment_rule_text,currency,points_reward,visibility,safety_policy_version,safety_acknowledgement_text,safety_requirements,refund_policy_version,refund_policy_summary,activity_details,included_items,participation_requirements,contact_instructions,status,published_at,created_by_employee_id,approved_by_employee_id) VALUES($1::uuid,$2,$3,$1::text,'member_night','服务测试','服务测试活动',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day','门口',1000,0,0,'per_registration','none',15,'免费活动','CNY',0,'public','activity-safety-v1','已知安全规则',ARRAY['年满18周岁'],'activity-refund-v1','按原退款约定','现场音乐、交流与限定饮品体验。',ARRAY['欢迎饮品'],ARRAY['提前到场'],'报名成功后在小程序查看集合通知','published',clock_timestamp(),$4,$4)`, [activity, scope.tenantId, scope.storeId, employee]);
    });
    beforeAll(async()=>{
      await admin.query(`WITH membership AS(INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,'MBX-SERVICE-TEST') RETURNING *) INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) SELECT tenant_id,store_id,id,customer_id FROM membership`,[scope.tenantId,scope.storeId,customer]);
      await admin.query(`INSERT INTO mbox.store_commerce_policies(tenant_id,store_id,online_payment_enabled,reason,updated_by_employee_id) VALUES($1,$2,true,'活动服务测试',$3) ON CONFLICT(tenant_id,store_id) DO UPDATE SET online_payment_enabled=true`,[scope.tenantId,scope.storeId,employee]);
      await admin.query(`UPDATE mbox.customer_experience_features SET rollout_state='pilot',reason='活动服务支付测试' WHERE tenant_id=$1 AND store_id=$2 AND feature_code='community.activity.payment'`,[scope.tenantId,scope.storeId]);
    });
    afterAll(async () => { await runtime?.end(); await admin?.end(); });
    const run = <T>(fn: (repo: ActivityServiceRepository) => Promise<T>) => runner.run(scope, tx => fn(new ActivityServiceRepository(tx)));
    async function product(tracked = false) { const id = randomUUID(); await admin.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($1::uuid,$2,$3,$1::text,'测试餐品','food','kitchen',$4)`, [id, scope.tenantId, scope.storeId, tracked ? 'tracked' : 'not_managed']); return id; }
    async function registration(items: ActivityMealItem[] = [], options: {
        parent?: string;
        activityId?: string;
        kind?: string;
        hasMeal?: boolean;
        free?: boolean;
        pending?: boolean;
    } = {}) {
        const id = randomUUID(), kind = options.kind ?? 'admission_package';
        await admin.query(`INSERT INTO mbox.community_activity_registrations(id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,status,payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,currency,safety_acknowledgement,idempotency_key,refund_policy_snapshot,acknowledged_safety_policy_version,acknowledged_refund_policy_version,terms_acknowledged_at,terms_acknowledgement_source,requested_payment_choice,requested_payment_method,requested_amount_due_minor,payment_due_at,seat_hold_expires_at,service_version,reserved_seats,max_participants,includes_admission,parent_registration_id,purchase_kind,service_items_snapshot,service_has_meal) VALUES($1::uuid,$2,$3,$1::text,$4,$5,1,$6,$7,$8,$9,CASE WHEN $6='payment_pending' THEN $9::bigint ELSE 0 END,$10,'CNY','{}',$1::text,'{"policyVersion":"activity-refund-v1"}','activity-safety-v1','activity-refund-v1',clock_timestamp(),'staff_assisted',$7,CASE WHEN $7='none' THEN NULL ELSE 'jsapi' END,$9,CASE WHEN $6='payment_pending' THEN clock_timestamp()+interval '15 minutes' ELSE NULL END,CASE WHEN $6='payment_pending' THEN clock_timestamp()+interval '15 minutes' ELSE NULL END,3,$11,5,$12,$13,$14,$15::jsonb,$16)`, [id, scope.tenantId, scope.storeId, options.activityId ?? activity, customer, options.pending ? 'payment_pending' : 'confirmed', options.free ? 'none' : 'full', options.pending ? 'pending' : options.free ? 'not_required' : 'paid', options.free ? 0 : 5000, options.free || options.pending ? 0 : 5000, kind === 'admission_package' ? 5 : 0, kind === 'admission_package', options.parent ?? null, kind, JSON.stringify(items), options.hasMeal ?? items.length > 0]);
        const r = await run(repo => repo.registration(id));
        return { id, code: activityCredential(id, r.credential_token) };
    }
    const item = (productId: string, quantity = 2): ActivityMealItem => ({ productId, name: '菜品', station: 'kitchen', quantity });
    const door = (r: {
        id: string;
        code: string;
    }, action: ActivityDoorCommand['action'], extra: Partial<ActivityDoorCommand> = {}, key = randomUUID()) => run(repo => repo.door(r.id, { action, credential: r.code, ...extra }, key, employee, '2026-10-22'));
    const produce = (action: ActivityProductionCommand['action'], line: {
        id: string;
        version: number;
    }, quantity: number, extra: Partial<ActivityProductionCommand> = {}, key = randomUUID()) => run(repo => repo.production({ action, lines: [{ lineId: line.id, expectedVersion: line.version, quantity }], ...extra }, key, action === 'take' || action === 'undo_take' ? null : employee, { kind: 'shared_pickup_device', id: 'test-device' }));
    it('requires a dedicated credential and leaves member lookup read-only', async () => { const r = await registration([item(await product())]); await expect(run(repo => repo.scan(r.id))).rejects.toMatchObject({ code: 'ACTIVITY_CREDENTIAL_INVALID' }); const view = await run(repo => repo.scan(r.code)); expect(view.meal).toBeNull(); expect(view.admittedCount).toBe(0); await expect(door(r, 'admit', { credential: undefined, arrivedCount: 1 })).rejects.toMatchObject({ code: 'ACTIVITY_CREDENTIAL_INVALID' }); });
    it('separates arrival batches from food and deduplicates the original door command', async () => { const r = await registration([item(await product())]), key = randomUUID(); const first = await door(r, 'admit', { arrivedCount: 2 }, key), again = await door(r, 'admit', { arrivedCount: 2 }, key); expect(again).toEqual(first); expect(first.meal).toBeNull(); expect(first.remainingAdmission).toBe(3); await expect(door(r, 'admit', { arrivedCount: 4 })).rejects.toMatchObject({ code: 'ACTIVITY_ADMISSION_EXCEEDED' }); expect((await door(r, 'admit', { arrivedCount: 3 })).admittedCount).toBe(5); });
    it('serializes competing arrival batches without overselling the same allowance', async () => { const r = await registration(); const results = await Promise.allSettled([door(r, 'admit', { arrivedCount: 4 }), door(r, 'admit', { arrivedCount: 4 })]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect((await run(repo => repo.view(r.id))).admittedCount).toBe(4); });
    it('creates one number, one KDS line and one printing source under repeated redemption', async () => { const r = await registration([item(await product())]); const [a, b] = await Promise.all([door(r, 'redeem'), door(r, 'redeem')]); expect(a.meal!.number).toBe(b.meal!.number); expect(a.meal!.lines).toHaveLength(1); const facts = await admin.query(`SELECT (SELECT count(*) FROM mbox.kds_tasks WHERE activity_service_line_id=$1)::int tasks,(SELECT count(*) FROM mbox.print_source_jobs WHERE aggregate_id=$1 AND ticket_kind='activity_production')::int prints`, [a.meal!.lines[0]!.id]); expect(facts.rows[0]).toEqual({ tasks: 1, prints: 1 }); expect(a.meal!.lines[0]).toMatchObject({ activityTitle: '服务测试', number: a.meal!.number }); });
    it('allocates unique natural numbers for concurrent different packages', async () => { const p = await product(), rs = await Promise.all(Array.from({ length: 8 }, () => registration([item(p)]))); const views = await Promise.all(rs.map(r => door(r, 'redeem'))); expect(new Set(views.map(v => v.meal!.number)).size).toBe(8); expect(views.every(v => Number.isInteger(v.meal!.number) && v.meal!.number > 0)).toBe(true); });
    it('handles pure entry tickets and meal entitlement without production separately', async () => { const entry = await registration([], { free: true }); await expect(door(entry, 'redeem')).rejects.toThrow('没有餐饮'); expect((await door(entry, 'admit', { arrivedCount: 1 })).meal).toBeNull(); const meal = await registration([], { free: true, hasMeal: true }); const view = await door(meal, 'redeem'); expect(view.hasMeal).toBe(true); expect(view.meal!.lines).toEqual([]); expect(view.meal!.number).toBeGreaterThan(0); });
    it('records partial preparation, actual taken batch and exact undo without a picker', async () => { const r = await registration([item(await product(), 3)]), view = await door(r, 'redeem'); let line = view.meal!.lines[0]!; line = (await produce('start', line, 3)).lines[0]!; line = (await produce('ready', line, 2)).lines[0]!; const key = randomUUID(), take = await produce('take', line, 1, {}, key); expect(take.lines[0]!.takenQuantity).toBe(1); expect(await produce('take', line, 1, {}, key)).toEqual(take); expect(take.source?.kind).toBe('shared_pickup_device'); await expect(produce('undo_take', take.lines[0]!, 1, { receiptId: take.receiptId })).rejects.toThrow('实物'); const undo = await produce('undo_take', take.lines[0]!, 1, { receiptId: take.receiptId, physicalStillAtPickupPoint: true }); expect(undo.lines[0]!.takenQuantity).toBe(0); expect((await run(repo => repo.receipts())).find(x => x.receiptId === take.receiptId)?.canUndo).toBe(false); });
    it('rejects stale partial quantities and never subtracts from a different receipt', async () => { const r = await registration([item(await product())]); let line = (await door(r, 'redeem')).meal!.lines[0]!; const start = await produce('start', line, 1); await expect(produce('start', line, 1)).rejects.toMatchObject({ code: 'ACTIVITY_SERVICE_STALE' }); line = (await produce('ready', start.lines[0]!, 1)).lines[0]!; await expect(produce('take', line, 2)).rejects.toMatchObject({ code: 'ACTIVITY_SERVICE_STALE' }); });
    it('keeps the number while dishes remain and releases it after returned-plaque fulfilment', async () => { const r = await registration([item(await product(), 1)]); let view = await door(r, 'redeem'), line = view.meal!.lines[0]!; await door(r, 'return_plaque'); expect((await admin.query('SELECT number_active FROM mbox.activity_meals WHERE registration_id=$1', [r.id])).rows[0].number_active).toBe(true); line = (await produce('start', line, 1)).lines[0]!; line = (await produce('ready', line, 1)).lines[0]!; await produce('take', line, 1); expect((await admin.query('SELECT number_active FROM mbox.activity_meals WHERE registration_id=$1', [r.id])).rows[0].number_active).toBe(false); });
    it('recovers paid add-ons only after restoring their original closed number', async () => { const parent = await registration([item(await product())]); const before = await door(parent, 'redeem'); await door(parent, 'return_plaque'); const child = await registration([item(await product(), 1)], { parent: parent.id, kind: 'single_dish' }); await run(repo => repo.dispatchPaidAddon(child.id)); expect((await run(repo => repo.view(parent.id))).pendingAddonCount).toBe(1); const restored = await door(parent, 'restore_plaque'); expect(restored.meal!.number).toBe(before.meal!.number); expect(restored.meal!.lines).toHaveLength(2); expect(restored.pendingAddonCount).toBe(0); });
    it('updates location without creating another production or print', async () => { const r = await registration([item(await product())]); const before = await door(r, 'redeem'); const after = await door(r, 'update_location', { location: '左区沙发' }); expect(after.meal!.location).toBe('左区沙发'); expect(after.meal!.lines.map(l => l.id)).toEqual(before.meal!.lines.map(l => l.id)); });
    it('edits expected attendance until the first meal redemption without rewriting actual arrivals or reserved maximum', async () => {
      const r = await registration([], {hasMeal:true});
      const edit = (size:number) => runner.run(scope,tx=>editActivityParty(tx,customer,r.id,size,randomUUID()));
      await edit(4);expect(await run(repo=>repo.view(r.id))).toMatchObject({partySize:4,reservedSeats:5});
      await expect(edit(6)).rejects.toMatchObject({code:'ACTIVITY_PARTY_SIZE_INVALID'});
      await door(r,'admit',{arrivedCount:2});await edit(3);
      expect(await run(repo=>repo.view(r.id))).toMatchObject({partySize:3,reservedSeats:5,admittedCount:2});
      await expect(edit(1)).rejects.toMatchObject({code:'ACTIVITY_PARTY_BELOW_ADMITTED'});
      await door(r,'redeem');await expect(edit(4)).rejects.toMatchObject({code:'ACTIVITY_PARTY_ALREADY_USED'});
    });
    it('blocks self refund after any included right is used and preserves dependent purchases', async () => { const r = await registration([item(await product())]); await runner.run(scope, tx => assertActivityUnusedRefund(tx, r.id)); await door(r, 'admit', { arrivedCount: 1 }); await expect(runner.run(scope, tx => assertActivityUnusedRefund(tx, r.id))).rejects.toMatchObject({ code: 'ACTIVITY_USED_REFUND_REVIEW' }); const parent = await registration([item(await product())]); await registration([item(await product())], { parent: parent.id, kind: 'single_dish' }); await expect(runner.run(scope, tx => assertActivityUnusedRefund(tx, parent.id))).rejects.toMatchObject({ code: 'ACTIVITY_DEPENDENT_REFUND_REVIEW' }); });
    it('consumes only actually started product quantities and preserves other dish reservations', async () => {
        const products = await Promise.all([product(true), product(true)]), stock = randomUUID();
        await admin.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1::uuid,$2,$3,$1::text,'共用食材','ingredient','g')`, [stock, scope.tenantId, scope.storeId]);
        await admin.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,100,0)', [scope.tenantId, scope.storeId, stock]);
        for (const p of products) {
            const recipe = randomUUID();
            await admin.query("INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,status,effective_at) VALUES($1,$2,$3,$4,1,'active',clock_timestamp()-interval '1 day')", [recipe, scope.tenantId, scope.storeId, p]);
            await admin.query('INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity) VALUES($1,$2,$3,$4,10)', [scope.tenantId, scope.storeId, recipe, stock]);
        }
        const items = products.map(p => item(p, 2)), r = await registration(items);
        await runner.run(scope, tx => reserveActivityMealInventory(tx, r.id, items));
        let lines = (await door(r, 'redeem')).meal!.lines;
        await produce('start', lines[0]!, 1);
        const balance = (await admin.query('SELECT on_hand_quantity::int, reserved_quantity::int FROM mbox.inventory_balances WHERE inventory_item_id=$1', [stock])).rows[0];
        expect(balance).toEqual({ on_hand_quantity: 90, reserved_quantity: 30 });
        const held = (await admin.query('SELECT consumed_quantity::int FROM mbox.activity_service_inventory WHERE registration_id=$1 ORDER BY consumed_quantity', [r.id])).rows;
        expect(held.map(r => r.consumed_quantity)).toEqual([0, 10]);
        expect((await admin.query('SELECT count(*)::int n FROM mbox.inventory_movements WHERE reference_id=$1', [r.id])).rows[0].n).toBe(1);
    });
    it('rejects single-dish parent chains and foreign-owner parents before creating any service fact', async () => { const root = await registration([item(await product())]), child = await registration([item(await product())], { parent: root.id, kind: 'single_dish' }); await expect(runner.run(scope, tx => prepareActivityPurchase(tx, { customerId: customer, activityId: activity, packageId: null, maxParticipants: null, partySize: 1, packageIncludesAdmission: false, mealOnlyAmount: null, purchaseKind: 'single_dish', parentRegistrationPublicId: child.id, productId: awaitProductPlaceholder }))).rejects.toMatchObject({ code: 'ACTIVITY_ADDON_PARENT_REQUIRED' }); });
    const awaitProductPlaceholder = randomUUID();
    it('isolates service lookup by store scope', async () => { const r = await registration(); await expect(runner.run({ ...scope, storeId: randomUUID() }, tx => new ActivityServiceRepository(tx).scan(r.code))).rejects.toMatchObject({ code: 'ACTIVITY_REGISTRATION_NOT_FOUND' }); });
    async function salePackage(options:{activityId?:string;capacity?:number;max?:number;includesAdmission?:boolean;mealPrice?:number|null;quantity?:number;choices?:ActivityPackageChoiceGroup[]}={}){
      const id=randomUUID(),p=await product();
      await admin.query(`INSERT INTO mbox.community_activity_packages(id,tenant_id,store_id,activity_id,public_id,name,capacity,member_purchase_limit,fee_amount_minor,deposit_amount_minor,fee_basis,payment_mode,payment_deadline_minutes,payment_rule_text,status,max_participants,includes_admission,meal_only_fee_amount_minor,has_meal) VALUES($1::uuid,$2,$3,$4,$1::text,'整份套餐',$5,20,5000,0,'per_registration','full_required',15,'每份固定价','draft',$6,$7,$8,true)`,[id,scope.tenantId,scope.storeId,options.activityId??activity,options.capacity??30,options.max??5,options.includesAdmission??true,options.mealPrice===undefined?3000:options.mealPrice]);
      await admin.query(`INSERT INTO mbox.activity_package_products(tenant_id,store_id,package_id,product_id,quantity) VALUES($1,$2,$3,$4,$5)`,[scope.tenantId,scope.storeId,id,p,options.quantity??2]);
      if(options.choices)await admin.query('UPDATE mbox.community_activity_packages SET choice_groups=$2::jsonb WHERE id=$1',[id,JSON.stringify(options.choices)]);
      await admin.query(`UPDATE mbox.community_activity_packages SET status='published' WHERE id=$1`,[id]);return {id,p};
    }
    async function buy(packageId:string|null,partySize=1,extra:Record<string,unknown>={}){
      const key=randomUUID();return runner.run(scope,tx=>new CustomerExperienceRepository(tx,true).registerActivity({
        activityPublicId:activity,activityPackagePublicId:packageId,customerId:customer,partySize,
        protectedContact:{contactType:'phone',contactHash:'a'.repeat(64),encryptedContact:'AQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',encryptionKeyId:'activity-test-v1',maskedContact:'138****8000',source:'mini_program'},
        termsAcknowledged:true,acknowledgedSafetyPolicyVersion:'activity-safety-v1',acknowledgedRefundPolicyVersion:'activity-refund-v1',paymentChoice:'full',paymentMethod:'jsapi',jsapiReady:true,
        publicId:key,paymentPublicId:`AP${key.replaceAll('-','')}`,idempotencyKey:key,...extra
      }));
    }
    async function pay(registration:{paymentPublicId:string|null;amountDueMinor:number},succeededAt=new Date().toISOString()){
      return runner.run(scope,async tx=>{const repo=new PaymentRepository(tx),applied=await repo.applySucceededCallback({paymentPublicId:registration.paymentPublicId!,provider:'postar',providerTransactionId:randomUUID(),reportedAmountMinor:registration.amountDueMinor,reportedCurrency:'CNY',providerSnapshot:{test:true},succeededAt});await repo.syncActivityRegistrationPaymentStatus(applied.payment);return applied.payment;});
    }
    it('charges a fixed package amount, reserves the maximum and permits separate purchases by one member',async()=>{
      const pkg=await salePackage(),a=await buy(pkg.id,1),b=await buy(pkg.id,5);expect(a.totalFeeAmountMinor).toBe(5000);expect(b.totalFeeAmountMinor).toBe(5000);expect(a.publicId).not.toBe(b.publicId);
      const rows=(await admin.query('SELECT service_version,reserved_seats,party_size,service_items_snapshot FROM mbox.community_activity_registrations WHERE public_id=ANY($1::text[]) ORDER BY party_size',[[a.publicId,b.publicId]])).rows;
      expect(rows.map(r=>[r.service_version,r.reserved_seats,r.party_size,r.service_items_snapshot[0].quantity])).toEqual([[3,5,1,2],[3,5,5,2]]);
      const list=await runner.run(scope,tx=>new CustomerExperienceRepository(tx,true).publicActivityRegistrations(customer));expect(list.find(r=>r.publicId===a.publicId)).toMatchObject({registrationRequestIdempotencyKey:a.publicId,serviceVersion:3,maxParticipants:5});
    });
    it('counts package capacity in portions and rejects the losing concurrent purchase atomically',async()=>{
      const pkg=await salePackage({capacity:1});const results=await Promise.allSettled([buy(pkg.id,5),buy(pkg.id,1)]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
      const counts=(await admin.query('SELECT count(*)::int n FROM mbox.community_activity_registrations WHERE activity_package_id=$1',[pkg.id])).rows[0];expect(counts.n).toBe(1);
    });
    it('sells a meal-only extra at its configured price with no extra admission after registration closes',async()=>{
      const pkg=await salePackage(),parent=await buy(pkg.id,2);await pay(parent);
      await admin.query('UPDATE mbox.community_activities SET registration_closed_at=clock_timestamp() WHERE id=$1',[activity]);
      try{const meal=await buy(pkg.id,3,{purchaseKind:'meal_package',parentRegistrationPublicId:parent.publicId});expect(meal.totalFeeAmountMinor).toBe(3000);const r=await run(repo=>repo.registration(meal.publicId));expect([r.reserved_seats,r.includes_admission,r.purchase_kind]).toEqual([0,false,'meal_package']);await expect(buy(pkg.id,1)).rejects.toMatchObject({code:'ACTIVITY_UNAVAILABLE'});}finally{await admin.query('UPDATE mbox.community_activities SET registration_closed_at=NULL WHERE id=$1',[activity])}
    });
    it('uses a meal-only package own price and prevents forging admission or a missing meal-only price',async()=>{
      const root=await registration([item(await product())]),meal=await salePackage({includesAdmission:false,mealPrice:null});expect((await buy(meal.id,2,{purchaseKind:'meal_package',parentRegistrationPublicId:root.id})).totalFeeAmountMinor).toBe(5000);
      await expect(buy(meal.id,2,{purchaseKind:'admission_package'})).rejects.toMatchObject({code:'ACTIVITY_PACKAGE_ADMISSION_NOT_INCLUDED'});
      const noMealPrice=await salePackage({mealPrice:null});await expect(buy(noMealPrice.id,2,{purchaseKind:'meal_package',parentRegistrationPublicId:root.id})).rejects.toMatchObject({code:'ACTIVITY_MEAL_PRICE_REQUIRED'});
    });
    it('keeps a verified on-time payment valid even when its callback arrives after the deadline',async()=>{
      const pkg=await salePackage(),purchase=await buy(pkg.id),success=new Date(Date.now()-120000).toISOString();await admin.query(`UPDATE mbox.community_activity_registrations SET payment_due_at=clock_timestamp()-interval '1 minute',seat_hold_expires_at=clock_timestamp()-interval '1 minute' WHERE public_id=$1`,[purchase.publicId]);
      const paid=await pay(purchase,success);expect(paid.status).toBe('succeeded');expect((await run(repo=>repo.registration(purchase.publicId))).status).toBe('confirmed');
    });
    it('records late funds without creating rights or kitchen tasks and permits a refund of the exact original payment',async()=>{
      const pkg=await salePackage(),purchase=await buy(pkg.id);await admin.query(`UPDATE mbox.community_activity_registrations SET payment_due_at=clock_timestamp()-interval '1 minute',seat_hold_expires_at=clock_timestamp()-interval '1 minute' WHERE public_id=$1`,[purchase.publicId]);
      const paid=await pay(purchase);expect(paid.status).toBe('succeeded');const r=await run(repo=>repo.registration(purchase.publicId));expect([r.status,r.payment_status]).toEqual(['cancelled','paid']);expect((await run(repo=>repo.view(purchase.publicId))).meal).toBeNull();
      const refund=await runner.run(scope,tx=>new RefundRepository(tx).requestActivity({paymentId:paid.id,publicId:randomUUID(),reason:'超时实收原路退回',requestedByEmployeeId:employee}));expect(refund.status).toBe('requested');
    });


    const exception=(line:{id:string;version:number},action:ActivityServiceExceptionCommand['action'],extra:Partial<ActivityServiceExceptionCommand>={},key=randomUUID())=>runner.run(scope,tx=>new ActivityServiceExceptionRepository(tx).execute({action,lineId:line.id,expectedVersion:line.version,reason:'现场核对异常',...extra},key,employee));
    async function materialMeal(quantity=3){
      const p=await product(true),stock=randomUUID(),recipe=randomUUID();
      await admin.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1::uuid,$2,$3,$1::text,'异常核对材料','ingredient','g')`,[stock,scope.tenantId,scope.storeId]);
      await admin.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,100,0)',[scope.tenantId,scope.storeId,stock]);
      await admin.query("INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,status,effective_at) VALUES($1,$2,$3,$4,1,'active',clock_timestamp()-interval '1 day')",[recipe,scope.tenantId,scope.storeId,p]);
      await admin.query('INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity) VALUES($1,$2,$3,$4,10)',[scope.tenantId,scope.storeId,recipe,stock]);
      const items=[item(p,quantity)],r=await registration(items);
      await runner.run(scope,tx=>reserveActivityMealInventory(tx,r.id,items));
      const view=await door(r,'redeem');await door(r,'plaque_issued');
      return {r,stock,line:view.meal!.lines[0]!,number:view.meal!.number};
    }
    const stockBalance=async(stock:string)=>(await admin.query('SELECT on_hand_quantity::float8 on_hand,reserved_quantity::float8 reserved FROM mbox.inventory_balances WHERE inventory_item_id=$1',[stock])).rows[0];
    it('pauses production and pickup, then resumes only the original remaining quantity',async()=>{
      const r=await registration([item(await product())]);let line=(await door(r,'redeem')).meal!.lines[0]!;
      line=(await produce('start',line,1)).lines[0]!;line=(await produce('ready',line,1)).lines[0]!;
      const hold=await exception(line,'hold');line=hold.lines[0]!;
      await expect(produce('start',line,1)).rejects.toMatchObject({code:'ACTIVITY_SERVICE_STALE'});
      await expect(produce('take',line,1)).rejects.toMatchObject({code:'ACTIVITY_SERVICE_STALE'});
      line=(await exception(line,'resume')).lines[0]!;
      expect(line).toMatchObject({held:false,startedQuantity:1,readyQuantity:1,takenQuantity:0});
      expect((await produce('take',line,1)).lines[0]!.takenQuantity).toBe(1);
    });
    it('stops only unmade portions and releases their reserved stock once under repeated commands',async()=>{
      const {r,stock,line:original}=await materialMeal();let line=(await produce('start',original,1)).lines[0]!;
      const key=randomUUID(),stopped=await exception(line,'cancel_unmade',{quantity:2},key);
      expect(await exception(line,'cancel_unmade',{quantity:2},key)).toEqual(stopped);
      expect(await stockBalance(stock)).toEqual({on_hand:90,reserved:0});line=stopped.lines[0]!;
      expect(line).toMatchObject({startedQuantity:1,stoppedQuantity:2});
      await expect(exception(line,'cancel_unmade',{quantity:1})).rejects.toThrow('未开做');
      line=(await produce('ready',line,1)).lines[0]!;await door(r,'return_plaque');await produce('take',line,1);
      expect((await admin.query('SELECT number_active FROM mbox.activity_meals WHERE registration_id=$1',[r.id])).rows[0].number_active).toBe(false);
      await admin.query("UPDATE mbox.community_activity_registrations SET status='cancelled' WHERE id=$1",[r.id]);
      expect(await stockBalance(stock)).toEqual({on_hand:90,reserved:0});
    });
    it('remakes lost ready food on the original number with a distinct source and extra material',async()=>{
      const {r,stock,line:original,number}=await materialMeal(2);let line=(await produce('start',original,2)).lines[0]!;
      line=(await produce('ready',line,2)).lines[0]!;
      await expect(exception(line,'remake',{quantity:1,remakeFrom:'ready'})).rejects.toThrow('损耗');
      const key=randomUUID(),result=await exception(line,'remake',{quantity:1,remakeFrom:'ready',goodsLost:true},key);
      expect(await exception(line,'remake',{quantity:1,remakeFrom:'ready',goodsLost:true},key)).toEqual(result);
      const source=result.lines.find(l=>l.id===line.id)!,remake=result.lines.find(l=>l.id!==line.id)!;
      expect(source).toMatchObject({readyQuantity:2,discardedReadyQuantity:1,takenQuantity:0});
      expect(remake).toMatchObject({number,quantity:1,startedQuantity:0});expect(remake.sourceRef).toMatch(/^remake:/);
      expect(await stockBalance(stock)).toEqual({on_hand:80,reserved:10});
      await produce('start',remake,1);expect(await stockBalance(stock)).toEqual({on_hand:70,reserved:0});
      expect((await admin.query('SELECT count(*)::int n FROM mbox.kds_tasks WHERE activity_service_line_id=$1',[remake.id])).rows[0].n).toBe(1);
      expect((await admin.query("SELECT count(*)::int n FROM mbox.print_source_jobs WHERE aggregate_id=$1 AND ticket_kind='activity_production'",[remake.id])).rows[0].n).toBe(1);
      expect((await run(repo=>repo.view(r.id))).meal!.number).toBe(number);
    });
    it('remaking taken food preserves the original take and prevents undo from inventing returned food',async()=>{
      const {line:original}=await materialMeal(1);let line=(await produce('start',original,1)).lines[0]!;
      line=(await produce('ready',line,1)).lines[0]!;const taken=await produce('take',line,1);line=taken.lines[0]!;
      const result=await exception(line,'remake',{quantity:1,remakeFrom:'taken',goodsLost:true});
      const source=result.lines.find(l=>l.id===line.id)!;expect(source).toMatchObject({takenQuantity:1,remadeTakenQuantity:1});
      await expect(produce('undo_take',source,1,{receiptId:taken.receiptId,physicalStillAtPickupPoint:true})).rejects.toThrow('批次');
      await expect(exception(source,'remake',{quantity:1,remakeFrom:'taken',goodsLost:true})).rejects.toThrow('损耗范围');
    });
    it('serializes two conflicting exception commands against the same original quantity',async()=>{
      const {line}=await materialMeal(1);
      const results=await Promise.allSettled([exception(line,'cancel_unmade',{quantity:1}),exception(line,'cancel_unmade',{quantity:1})]);
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    });
    it('consumes fractional reservations cumulatively without leaving rounding residue',async()=>{
      const {r,stock,line:original}=await materialMeal(3);
      await admin.query('UPDATE mbox.activity_service_inventory SET quantity=1 WHERE registration_id=$1',[r.id]);
      await admin.query('UPDATE mbox.inventory_balances SET reserved_quantity=1 WHERE inventory_item_id=$1',[stock]);
      let line=original;for(let i=0;i<3;i++)line=(await produce('start',line,1)).lines[0]!;
      expect(await stockBalance(stock)).toEqual({on_hand:99,reserved:0});
      expect((await admin.query('SELECT consumed_quantity::float8 n FROM mbox.activity_service_inventory WHERE registration_id=$1',[r.id])).rows[0].n).toBe(1);
    });
    it('keeps a paid fact when incremental dispatch fails and recovers the original number without re-redemption',async()=>{
      const parent=await registration([item(await product(),1)]),view=await door(parent,'redeem');await door(parent,'plaque_issued');
      const child=await registration([item(await product(),1)],{parent:parent.id,kind:'single_dish'});
      await admin.query("UPDATE mbox.community_activity_registrations SET status='payment_pending',payment_status='pending',paid_amount_minor=0,amount_due_minor=fee_amount_minor,payment_due_at=clock_timestamp()+interval '15 minutes',seat_hold_expires_at=clock_timestamp()+interval '15 minutes' WHERE id=$1",[child.id]);
      await runner.run(scope,async tx=>{
        await tx.query("UPDATE mbox.community_activity_registrations SET status='confirmed',payment_status='paid',paid_amount_minor=fee_amount_minor,amount_due_minor=0 WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[scope.tenantId,scope.storeId,child.id]);
        class FailingDispatch extends ActivityServiceRepository {override async ensureLines(){await tx.query('SELECT 1/0')}}
        await new FailingDispatch(tx).dispatchPaidAddon(child.id);
      });
      expect((await run(repo=>repo.view(child.id))).paymentStatus).toBe('paid');
      expect((await run(repo=>repo.view(parent.id))).pendingAddonCount).toBe(1);
      const recovered=await door(parent,'recover');expect(recovered.meal!.number).toBe(view.meal!.number);expect(recovered.meal!.lines).toHaveLength(2);
      expect((await door(parent,'recover')).meal!.lines.map(l=>l.id)).toEqual(recovered.meal!.lines.map(l=>l.id));
    });
    it('issues a first meal number for a pure entry ticket only after a paid dish and service-point redemption',async()=>{
      const parent=await registration([],{free:true});await door(parent,'admit',{arrivedCount:1});
      const child=await registration([item(await product(),1)],{parent:parent.id,kind:'single_dish'});
      await run(repo=>repo.dispatchPaidAddon(child.id));expect((await run(repo=>repo.view(parent.id))).meal).toBeNull();
      expect((await run(repo=>repo.view(parent.id))).hasMeal).toBe(true);
      const view=await door(parent,'redeem');expect(view.meal!.lines).toHaveLength(1);expect(view.admittedCount).toBe(1);
    });
    it('treats a redeemed no-preparation meal as used for self refund',async()=>{
      const r=await registration([],{hasMeal:true});await door(r,'redeem');
      await expect(runner.run(scope,tx=>assertActivityUnusedRefund(tx,r.id))).rejects.toMatchObject({code:'ACTIVITY_USED_REFUND_REVIEW'});
    });
    it('freezes fixed meal choices and necessary notes from checkout through kitchen source',async()=>{
      const a=await product(),b=await product(),groups=[{id:'drink-choice',name:'饮品二选一',quantity:2,productIds:[a,b]}];const pkg=await salePackage({choices:groups});
      await expect(buy(pkg.id,3)).rejects.toMatchObject({code:'ACTIVITY_SELECTION_REQUIRED'});
      await expect(buy(pkg.id,3,{selections:[{groupId:'drink-choice',productId:pkg.p}]})).rejects.toMatchObject({code:'ACTIVITY_SELECTION_INVALID'});
      const purchase=await buy(pkg.id,3,{selections:[{groupId:'drink-choice',productId:b}],note:'不加冰，请核实过敏要求'});expect(purchase.totalFeeAmountMinor).toBe(5000);await pay(purchase);
      const r=await run(repo=>repo.registration(purchase.publicId));expect(r.service_items_snapshot).toEqual(expect.arrayContaining([expect.objectContaining({productId:b,quantity:2,selectionLabel:'饮品二选一',note:'不加冰，请核实过敏要求'})]));
      const lines=(await door({id:r.public_id,code:activityCredential(r.public_id,r.credential_token)},'redeem')).meal!.lines;expect(lines.find(l=>l.productId===b)).toMatchObject({quantity:2,note:'不加冰，请核实过敏要求',selectionLabel:'饮品二选一'});
      const current=await runner.run(scope,tx=>new CustomerExperienceRepository(tx,true).publicActivity(customer,activity));expect(current.packages.find(p=>p.publicId===pkg.id)?.choiceGroups?.[0]?.options).toEqual(expect.arrayContaining([expect.objectContaining({productId:b,name:'测试餐品'})]));
      const history=await runner.run(scope,tx=>new CustomerExperienceRepository(tx,true).publicActivityRegistrations(customer));expect(history.find(p=>p.publicId===purchase.publicId)).toMatchObject({note:'不加冰，请核实过敏要求',selections:[expect.objectContaining({label:'饮品二选一',productId:b,quantity:2})]});
      await expect(admin.query("UPDATE mbox.community_activity_packages SET choice_groups='[]' WHERE id=$1",[pkg.id])).rejects.toMatchObject({code:'23514'});
    });
    it('allows an existing pure activity ticket to buy its first dish and receive one original-parent number',async()=>{
      const parent=await registration([],{free:true}),p=await product();await admin.query('UPDATE mbox.community_activities SET addon_product_ids=array_append(addon_product_ids,$2::uuid) WHERE id=$1',[activity,p]);
      await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1200,'CNY',clock_timestamp()-interval '1 hour')`,[scope.tenantId,scope.storeId,p]);
      const purchase=await buy(null,1,{purchaseKind:'single_dish',parentRegistrationPublicId:parent.id,productId:p,quantity:2});expect(purchase.totalFeeAmountMinor).toBe(2400);await pay(purchase);
      const view=await door(parent,'redeem');expect(view.hasMeal).toBe(true);expect(view.meal!.lines).toHaveLength(1);expect(view.meal!.lines[0]!.quantity).toBe(2);expect(view.reservedSeats).toBe(5);
    });
    it.each([false,true])('dispatches a zero-price add-on through the purchase path only when its original meal exists (redeemed=%s)',async redeemed=>{
      const parent=await registration([item(await product(),1)]),p=await product(),key=randomUUID();
      if(redeemed){await door(parent,'redeem');await door(parent,'plaque_issued')}
      await admin.query('UPDATE mbox.community_activities SET addon_product_ids=array_append(addon_product_ids,$2::uuid) WHERE id=$1',[activity,p]);
      await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',0,'CNY',clock_timestamp()-interval '1 hour')`,[scope.tenantId,scope.storeId,p]);
      const input={purchaseKind:'single_dish',parentRegistrationPublicId:parent.id,productId:p,quantity:2,idempotencyKey:key,publicId:key,paymentPublicId:`AP${key.replaceAll('-','')}`};
      const purchase=await buy(null,1,input);expect(purchase).toMatchObject({status:'confirmed',paymentRequired:false,paymentPublicId:null,totalFeeAmountMinor:0});
      expect((await admin.query('SELECT count(*)::int AS count FROM mbox.activity_service_lines WHERE registration_id=$1',[purchase.id])).rows[0].count).toBe(redeemed?1:0);
      await run(repo=>repo.dispatchPaidAddon(purchase.id));
      let view=await run(repo=>repo.view(parent.id));
      if(!redeemed){expect(view.meal).toBeNull();view=await door(parent,'redeem')}
      const lines=view.meal!.lines.filter(line=>line.registrationPublicId===purchase.publicId);
      expect(lines).toHaveLength(1);expect(lines[0]!.quantity).toBe(2);
      const facts=(await admin.query(`SELECT (SELECT count(*) FROM mbox.kds_tasks WHERE activity_service_line_id=$1)::int tasks,(SELECT count(*) FROM mbox.print_source_jobs WHERE aggregate_id=$1 AND ticket_kind='activity_production')::int prints`,[lines[0]!.id])).rows[0];
      expect(facts).toEqual({tasks:1,prints:1});
    });
    it('keeps a visible unsaleable add-on in the menu without a quote and still rejects its purchase',async()=>{
      const parent=await registration([],{free:true}),p=await product();
      await admin.query('UPDATE mbox.community_activities SET addon_product_ids=array_append(addon_product_ids,$2::uuid) WHERE id=$1',[activity,p]);
      await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1200,'CNY',clock_timestamp()-interval '1 hour')`,[scope.tenantId,scope.storeId,p]);
      const minute=Number((await admin.query("SELECT floor(extract(epoch FROM (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::time)/60)::int AS current_minute")).rows[0].current_minute);
      const sale=minute<720?{saleStartMinute:1080,saleEndMinute:1200}:{saleStartMinute:60,saleEndMinute:120};
      await runner.run(scope,tx=>saveProductServiceWindow(tx,p,{...DEFAULT_PRODUCT_SERVICE_WINDOW,...sale}));
      const menu=()=>runner.run(scope,tx=>activityAddonProducts(tx,customer,activity));
      expect((await menu()).find(row=>row.id===p)).toMatchObject({sellable:false,priceAmountMinor:null,purchaseDeadline:null,statusText:'当前未开售或已结束'});
      await expect(buy(null,1,{purchaseKind:'single_dish',parentRegistrationPublicId:parent.id,productId:p})).rejects.toThrow();
      await runner.run(scope,tx=>saveProductServiceWindow(tx,p,{...DEFAULT_PRODUCT_SERVICE_WINDOW,dateFrom:'2100-01-01'}));
      expect((await menu()).find(row=>row.id===p)).toBeUndefined();
      await runner.run(scope,tx=>saveProductServiceWindow(tx,p,null));
      expect((await menu()).find(row=>row.id===p)).toMatchObject({sellable:true,priceAmountMinor:1200});
    });
    it('holds an unprinted kitchen source without exhausting retries and resumes the original source',async()=>{
      const r=await registration([item(await product(),1)]),view=await door(r,'redeem'),line=view.meal!.lines[0]!;
      await admin.query('UPDATE mbox.activity_service_lines SET held=true WHERE id=$1',[line.id]);
      const source=(await admin.query("SELECT id,source_outbox_message_id FROM mbox.print_source_jobs WHERE aggregate_id=$1 AND ticket_kind='activity_production'",[line.id])).rows[0];
      await expect(runner.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeActivityProduction(source.source_outbox_message_id,line.id))).rejects.toBeInstanceOf(ActivityPrintHeldError);
      await admin.query("UPDATE mbox.print_source_jobs SET next_attempt_at=clock_timestamp()+interval '1 day' WHERE tenant_id=$1 AND store_id=$2 AND id<>$3",[scope.tenantId,scope.storeId,source.id]);
      expect((await new PrintSourceWorker(runner).runBatch(scope,'activity-print-test',50)).retrying).toBe(1);
      expect((await admin.query('SELECT status,attempts,last_error_code FROM mbox.print_source_jobs WHERE id=$1',[source.id])).rows[0]).toEqual({status:'retry',attempts:0,last_error_code:'activity_service_held'});
      await admin.query('UPDATE mbox.activity_service_lines SET held=false WHERE id=$1',[line.id]);await admin.query('UPDATE mbox.print_source_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1',[source.id]);
      await new PrintSourceWorker(runner).runBatch(scope,'activity-print-test',50);expect((await admin.query('SELECT attempts FROM mbox.print_source_jobs WHERE id=$1',[source.id])).rows[0].attempts).toBe(1);
    });


    it('records a delivery issue without pretending handed-over food returned or causing another production',async()=>{
      const {r,line:original}=await materialMeal(1);let line=(await produce('start',original,1)).lines[0]!;
      line=(await produce('ready',line,1)).lines[0]!;line=(await produce('take',line,1)).lines[0]!;
      const before=await run(repo=>repo.view(r.id)),key=randomUUID();
      const note=await exception(line,'record_issue',{reason:'客人移位，已联系并交领班协调'},key);
      expect(await exception(line,'record_issue',{reason:'客人移位，已联系并交领班协调'},key)).toEqual(note);
      const after=await run(repo=>repo.view(r.id));expect(after.meal!.lines).toEqual(before.meal!.lines);
      expect(after.meal!.issueNotes).toHaveLength(1);expect(after.meal!.issueNotes![0]).toMatchObject({lineId:line.id,reason:'客人移位，已联系并交领班协调',employeeLabel:'Activity service'});
    });
    it('revalidates the stored activity single-dish quote before a new payment action',async()=>{
      const parent=await registration([],{free:true}),p=await product();
      await admin.query('UPDATE mbox.community_activities SET addon_product_ids=array_append(addon_product_ids,$2::uuid) WHERE id=$1',[activity,p]);
      await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1200,'CNY',clock_timestamp()-interval '1 hour')`,[scope.tenantId,scope.storeId,p]);
      const purchase=await buy(null,1,{purchaseKind:'single_dish',parentRegistrationPublicId:parent.id,productId:p,quantity:1});
      const r=await run(repo=>repo.registration(purchase.publicId));expect(r.service_items_snapshot[0]).toMatchObject({productId:p,unitPriceMinor:1200,priceType:'standard'});
      const payment=(await admin.query('SELECT id FROM mbox.payments WHERE public_id=$1',[purchase.paymentPublicId])).rows[0];
      const expiry=new Date(Date.now()+300000).toISOString();expect(Date.parse(await runner.run(scope,tx=>validateProductPaymentWindow(tx,payment.id,expiry)))).toBeLessThanOrEqual(Date.parse(expiry));
      await admin.query("UPDATE mbox.products SET status='sold_out' WHERE id=$1",[p]);
      await expect(runner.run(scope,tx=>validateProductPaymentWindow(tx,payment.id,expiry))).rejects.toThrow('已变化');
      expect((await run(repo=>repo.registration(purchase.publicId))).payment_status).toBe('pending');
    });

    it('authorizes a different buyer only by the original package QR and keeps customer views isolated', async () => {
      const parent = await registration([item(await product())]);
      const original = await door(parent, 'redeem');
      const otherBuyer = randomUUID(), dish = await product();
      await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)",[otherBuyer,scope.tenantId,scope.storeId]);
      await admin.query(`WITH membership AS(INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3::uuid,'MBX-OTHER') RETURNING *) INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) SELECT tenant_id,store_id,id,customer_id FROM membership`,[scope.tenantId,scope.storeId,otherBuyer]);
      await admin.query("UPDATE mbox.community_activities SET addon_product_ids=array_append(addon_product_ids,$2::uuid) WHERE id=$1",[activity,dish]);
      await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1200,'CNY',clock_timestamp()-interval '1 hour')`,[scope.tenantId,scope.storeId,dish]);
      const input = {purchaseKind:'single_dish',parentRegistrationPublicId:parent.id,productId:dish,quantity:1,customerId:otherBuyer};
      await expect(buy(null,1,input)).rejects.toMatchObject({code:'ACTIVITY_ADDON_PARENT_REQUIRED'});
      await expect(buy(null,1,{...input,parentCredential:parent.code.replace(/.$/,'x')})).rejects.toMatchObject({code:'ACTIVITY_CREDENTIAL_INVALID'});
      const preview = await runner.run(scope,tx=>resolveActivityParent(tx,activity,parent.code));
      expect(preview).toMatchObject({registrationPublicId:parent.id,number:original.meal!.number});
      expect(preview).not.toHaveProperty('customerId');
      await expect(runner.run(scope,tx=>resolveActivityParent(tx,randomUUID(),parent.code))).rejects.toMatchObject({code:'ACTIVITY_CREDENTIAL_INVALID'});
      const purchase = await buy(null,1,{...input,parentCredential:parent.code});
      await pay(purchase);
      const row = (await admin.query('SELECT customer_id,parent_registration_id FROM mbox.community_activity_registrations WHERE public_id=$1',[purchase.publicId])).rows[0];
      expect(row).toEqual({customer_id:otherBuyer,parent_registration_id:parent.id});
      const parentView = await run(repo=>repo.view(parent.id));
      const childView = await run(repo=>repo.view(purchase.publicId));
      expect(parentView.meal!.lines).toHaveLength(2);
      expect(customerActivityServiceView({...parentView,meal:{...parentView.meal!,issueNotes:[{id:randomUUID(),lineId:parentView.meal!.lines[0]!.id,reason:'员工内部处理',employeeLabel:'员工',createdAt:new Date().toISOString()}]}}).meal).not.toHaveProperty('issueNotes');
      expect(customerActivityServiceView(parentView).meal!.lines.map(line=>line.registrationPublicId)).toEqual([parent.id]);
      expect(customerActivityServiceView(childView).meal!.lines.map(line=>line.registrationPublicId)).toEqual([purchase.publicId]);
      expect(childView.meal!.number).toBe(original.meal!.number);
    });

    async function completeRefund(payment:{id:string;providerTransactionId:string|null}, refund:{id:string;amountMinor:number}) {
      const approver = randomUUID();
      await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'退款复核')",[approver,scope.tenantId,scope.storeId]);
      await runner.run(scope,tx=>new RefundRepository(tx).approve(refund.id,approver,'核对原权益和原付款后同意'));
      await runner.run(scope,tx=>new RefundRepository(tx).beginExecution(refund.id));
      const reference = refund.id.replaceAll('-','');
      await admin.query("UPDATE mbox.refunds SET merchant_refund_id=$2,provider_submission_started_at=clock_timestamp(),provider_submission_state='submitted' WHERE id=$1 AND status='processing'",[refund.id,reference]);
      return runner.run(scope,async tx=>{
        const repo=new RefundRepository(tx),result=await repo.completeProviderExecution({refundPublicId:reference,provider:'postar',succeeded:true,providerRefundId:`RF${reference}`,originalProviderTransactionId:payment.providerTransactionId!,reportedAmountMinor:refund.amountMinor,reportedCurrency:'CNY',providerSnapshot:{test:true}});
        await repo.syncPaymentRefundStatus(payment.id);await new PaymentRepository(tx).syncActivityRegistrationRefundStatus(payment.id);return result;
      });
    }
    const requestRefund=(paymentId:string,extra:Record<string,unknown>={})=>runner.run(scope,tx=>new RefundRepository(tx).requestActivity({paymentId,publicId:randomUUID(),reason:'按原单和顾客确认的售后方案',requestedByEmployeeId:employee,...extra}));
    it('completes a full original-payment refund then purchases a fresh portion without reviving the old code',async()=>{
      const pkg=await salePackage({capacity:1}),purchase=await buy(pkg.id,2),payment=await pay(purchase),row=await run(repo=>repo.registration(purchase.publicId));
      const refund=await requestRefund(payment.id);await completeRefund(payment,refund);
      expect(await run(repo=>repo.registration(purchase.publicId))).toMatchObject({status:'refunded',payment_status:'refunded'});
      await expect(door({id:row.public_id,code:activityCredential(row.public_id,row.credential_token)},'redeem')).rejects.toMatchObject({code:'ACTIVITY_NOT_PAID'});
      await expect(runner.run(scope,tx=>new ActivityRecollectionAuthorizationRepository(tx).authorize({activityRegistrationPublicId:row.public_id,employeeId:employee,reason:'尝试重收旧报名'}))).rejects.toThrow('新购');
      const fresh=await buy(pkg.id,1);expect(fresh.publicId).not.toBe(purchase.publicId);expect(fresh.totalFeeAmountMinor).toBe(5000);
      await runner.run(scope,tx=>new PaymentRepository(tx).syncActivityRegistrationRefundStatus(payment.id));
      expect(await run(repo=>repo.registration(fresh.publicId))).toMatchObject({status:'payment_pending',payment_status:'pending',reserved_seats:5});
    });
    it('keeps actual attendance, original number and remaining food through partial and full compensation refunds',async()=>{
      const pkg=await salePackage({quantity:2}),purchase=await buy(pkg.id,2),payment=await pay(purchase),row=await run(repo=>repo.registration(purchase.publicId));
      const r={id:row.public_id,code:activityCredential(row.public_id,row.credential_token)};
      let view=await door(r,'admit_and_redeem',{arrivedCount:2}),line=view.meal!.lines[0]!;
      line=(await produce('start',line,1)).lines[0]!;
      await expect(requestRefund(payment.id)).rejects.toMatchObject({code:'ACTIVITY_USED_REFUND_REVIEW'});
      await expect(requestRefund(payment.id,{amountMinor:1000,disposition:'retain_fulfillment'})).rejects.toMatchObject({code:'ACTIVITY_COMPENSATION_CONFIRMATION_REQUIRED'});
      const partial=await requestRefund(payment.id,{amountMinor:1000,disposition:'retain_fulfillment',customerConfirmed:true});
      await expect(produce('ready',line,1)).rejects.toMatchObject({code:'ACTIVITY_REFUND_PENDING'});
      await completeRefund(payment,partial);
      expect(await run(repo=>repo.registration(r.id))).toMatchObject({status:'confirmed',payment_status:'paid',reserved_seats:5,service_refund_disposition:'retain_fulfillment'});
      line=(await produce('ready',line,1)).lines[0]!;line=(await produce('take',line,1)).lines[0]!;
      const remainder=await requestRefund(payment.id,{amountMinor:4000,disposition:'retain_fulfillment',customerConfirmed:true});await completeRefund(payment,remainder);
      expect(await run(repo=>repo.registration(r.id))).toMatchObject({status:'confirmed',payment_status:'refunded',reserved_seats:5,service_refund_disposition:'retain_fulfillment'});
      line=(await produce('start',line,1)).lines[0]!;line=(await produce('ready',line,1)).lines[0]!;line=(await produce('take',line,1)).lines[0]!;
      expect(line).toMatchObject({quantity:2,startedQuantity:2,takenQuantity:2});
      const after=await door(r,'redeem');expect(after.meal!.id).toBe(view.meal!.id);expect(after.meal!.lines).toHaveLength(1);expect(after.admittedCount).toBe(2);expect(after.remainingAdmission).toBe(3);
      expect((await admin.query('SELECT status FROM mbox.payments WHERE id=$1',[payment.id])).rows[0].status).toBe('refunded');
      const occupied=(await admin.query("SELECT sum(reserved_seats)::int n FROM mbox.community_activity_registrations WHERE activity_package_id=$1 AND status IN('payment_pending','confirmed','checked_in')",[pkg.id])).rows[0].n;expect(occupied).toBe(5);
    });
    it('requires an explicit original-line stop before stop-unstarted compensation and preserves started food',async()=>{
      const pkg=await salePackage({quantity:2}),purchase=await buy(pkg.id),payment=await pay(purchase),row=await run(repo=>repo.registration(purchase.publicId));
      const r={id:row.public_id,code:activityCredential(row.public_id,row.credential_token)},view=await door(r,'redeem');let line=view.meal!.lines[0]!;
      line=(await produce('start',line,1)).lines[0]!;
      await expect(requestRefund(payment.id,{amountMinor:2000,disposition:'stop_unstarted',customerConfirmed:true})).rejects.toMatchObject({code:'ACTIVITY_COMPENSATION_STOP_REQUIRED'});
      line=(await exception(line,'cancel_unmade',{quantity:1,reason:'已与顾客确认停止本份未做的一份'})).lines.find(l=>l.id===line.id)!;
      const refund=await requestRefund(payment.id,{amountMinor:2000,disposition:'stop_unstarted',customerConfirmed:true});await completeRefund(payment,refund);
      line=(await produce('ready',line,1)).lines[0]!;line=(await produce('take',line,1)).lines[0]!;
      expect(line).toMatchObject({quantity:2,startedQuantity:1,takenQuantity:1,stoppedQuantity:1});await expect(produce('start',line,1)).rejects.toMatchObject({code:'ACTIVITY_SERVICE_STALE'});
    });
    it('keeps paid dependent dishes attached when the unused parent takes an explicitly retained compensation',async()=>{
      const pkg=await salePackage(),parent=await buy(pkg.id),payment=await pay(parent),dish=await product();
      await admin.query('UPDATE mbox.community_activities SET addon_product_ids=array_append(addon_product_ids,$2::uuid) WHERE id=$1',[activity,dish]);
      await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1200,'CNY',clock_timestamp()-interval '1 hour')`,[scope.tenantId,scope.storeId,dish]);
      const child=await buy(null,1,{purchaseKind:'single_dish',parentRegistrationPublicId:parent.publicId,productId:dish});await pay(child);
      await expect(requestRefund(payment.id)).rejects.toMatchObject({code:'ACTIVITY_DEPENDENT_REFUND_REVIEW'});
      const retained=await requestRefund(payment.id,{amountMinor:5000,disposition:'retain_fulfillment',customerConfirmed:true});await completeRefund(payment,retained);
      const r=await run(repo=>repo.registration(parent.publicId)),view=await door({id:r.public_id,code:activityCredential(r.public_id,r.credential_token)},'redeem');
      expect(view.meal!.lines).toHaveLength(2);expect(view.meal!.lines.map(line=>line.registrationPublicId)).toEqual(expect.arrayContaining([parent.publicId,child.publicId]));
      expect(view.admittedCount).toBe(0);expect((await run(repo=>repo.view(child.publicId))).meal!.number).toBe(view.meal!.number);
    });
    it('refuses restoring an ended old number when another business day already uses it',async()=>{
      const first=await registration([],{hasMeal:true}),old=await door(first,'redeem');await door(first,'return_plaque');
      const next=await registration([],{hasMeal:true});
      await admin.query(`INSERT INTO mbox.activity_meals(tenant_id,store_id,registration_id,business_date,number,plaque_state,number_active,redeemed_by_employee_id) VALUES($1,$2,$3,'2026-10-23',$4,'issued',true,$5)`,[scope.tenantId,scope.storeId,next.id,old.meal!.number,employee]);
      await expect(run(repo=>repo.door(first.id,{action:'restore_plaque',credential:first.code},randomUUID(),employee,'2026-10-23'))).rejects.toMatchObject({code:'ACTIVITY_NUMBER_OCCUPIED'});
      expect((await run(repo=>repo.view(first.id))).meal!.plaqueState).toBe('returned');
      expect((await run(repo=>repo.view(next.id))).meal!.plaqueState).toBe('issued');
    });

    async function copyActivity(changes:Record<string,unknown>) {
      const id=randomUUID();
      await admin.query(`INSERT INTO mbox.community_activities SELECT (jsonb_populate_record(NULL::mbox.community_activities,to_jsonb(a)||$2::jsonb)).* FROM mbox.community_activities a WHERE id=$1`,[activity,JSON.stringify({...changes,id,public_id:id})]);
      return id;
    }
    it('uses maximum admission promises rather than expected attendance when only four seats remain',async()=>{
      const smallActivity=await copyActivity({capacity:4}),pkg=await salePackage({max:5,activityId:smallActivity});
      await expect(buy(pkg.id,2,{activityPublicId:smallActivity})).rejects.toThrow();
      expect((await admin.query('SELECT count(*)::int n FROM mbox.community_activity_registrations WHERE activity_package_id=$1',[pkg.id])).rows[0].n).toBe(0);
    });
    it('uses the activity start for entry and a later meal start for food without erasing valid early arrivals',async()=>{
      const future=await copyActivity({starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+172800000).toISOString()}),futureTicket=await registration([],{free:true,activityId:future});
      await expect(door(futureTicket,'admit',{arrivedCount:1})).rejects.toMatchObject({code:'ACTIVITY_SERVICE_WINDOW'});
      expect((await run(repo=>repo.view(futureTicket.id))).admittedCount).toBe(0);
      const staggered=await copyActivity({meal_service_starts_at:new Date(Date.now()+3600000).toISOString()}),ticket=await registration([],{free:true,hasMeal:true,activityId:staggered});
      await door(ticket,'admit',{arrivedCount:2});
      await expect(door(ticket,'redeem')).rejects.toMatchObject({code:'ACTIVITY_SERVICE_WINDOW'});
      expect(await run(repo=>repo.view(ticket.id))).toMatchObject({admittedCount:2,remainingAdmission:3,meal:null});
    });
    it('restores original service after rejecting compensation and freezes approved failures with their reserved balance',async()=>{
      const pkg=await salePackage({quantity:1}),purchase=await buy(pkg.id),payment=await pay(purchase),row=await run(repo=>repo.registration(purchase.publicId));
      const r={id:row.public_id,code:activityCredential(row.public_id,row.credential_token)};let line=(await door(r,'redeem')).meal!.lines[0]!;
      const approver=randomUUID();await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'退款复核')",[approver,scope.tenantId,scope.storeId]);
      const rejected=await requestRefund(payment.id,{amountMinor:1000,disposition:'retain_fulfillment',customerConfirmed:true});
      await expect(produce('start',line,1)).rejects.toMatchObject({code:'ACTIVITY_REFUND_PENDING'});
      await runner.run(scope,tx=>new RefundRepository(tx).reject(rejected.id,approver,'核对后不批准，继续原餐'));
      line=(await produce('start',line,1)).lines[0]!;
      const failed=await requestRefund(payment.id,{amountMinor:4000,disposition:'retain_fulfillment',customerConfirmed:true});
      await runner.run(scope,tx=>new RefundRepository(tx).approve(failed.id,approver,'同意原渠道补偿'));
      await runner.run(scope,tx=>new RefundRepository(tx).beginExecution(failed.id));
      const reference=failed.id.replaceAll('-','');await admin.query("UPDATE mbox.refunds SET merchant_refund_id=$2,provider_submission_started_at=clock_timestamp(),provider_submission_state='submitted' WHERE id=$1",[failed.id,reference]);
      await runner.run(scope,tx=>new RefundRepository(tx).completeProviderExecution({refundPublicId:reference,provider:'postar',succeeded:false,providerRefundId:`RF${reference}`,originalProviderTransactionId:payment.providerTransactionId!,reportedAmountMinor:4000,reportedCurrency:'CNY',providerSnapshot:{test:true}}));
      await expect(produce('ready',line,1)).rejects.toMatchObject({code:'ACTIVITY_REFUND_PENDING'});
      await expect(requestRefund(payment.id,{amountMinor:2000,disposition:'retain_fulfillment',customerConfirmed:true})).rejects.toThrow('remaining');
      expect(await run(repo=>repo.registration(r.id))).toMatchObject({status:'confirmed',payment_status:'paid',service_refund_disposition:null});
    });

    const cancelLegacyEntry=(publicId:string)=>runner.run(scope,tx=>new ActivityOperationsRepository(tx).transitionRegistration(publicId,'cancel','顾客申请取消未用免费报名',employee));
    it('completes an ended v3 activity without legacy check-in, retaining its original unfinished meal for handover',async()=>{
      const localActivity=randomUUID();
      await admin.query(`INSERT INTO mbox.community_activities SELECT (jsonb_populate_record(NULL::mbox.community_activities,to_jsonb(a)||jsonb_build_object('id',$1::uuid,'public_id',$1::text,'ends_at',clock_timestamp()+interval '3 seconds'))).* FROM mbox.community_activities a WHERE a.id=$2`,[localActivity,activity]);
      const r=await registration([item(await product(),2)],{activityId:localActivity,free:true});
      const meal=(await door(r,'redeem')).meal!;
      const complete=()=>runner.run(scope,tx=>new ActivityOperationsRepository(tx).closeActivity(localActivity,'completed'));
      await expect(complete()).rejects.toMatchObject({code:'ACTIVITY_CLOSE_BLOCKED'});
      await admin.query('SELECT pg_sleep(GREATEST(0,extract(epoch FROM ends_at-clock_timestamp()))+0.05) FROM mbox.community_activities WHERE id=$1',[localActivity]);
      expect(await complete()).toMatchObject({status:'completed'});
      const retained=(await run(repo=>repo.view(r.id))).meal!;
      expect(retained.id).toBe(meal.id);expect(retained.number).toBe(meal.number);expect(retained.lines).toHaveLength(1);
      const started=await produce('start',retained.lines[0]!,1);expect(started.lines[0]!.startedQuantity).toBe(1);
      const ready=await produce('ready',started.lines[0]!,1),taken=await produce('take',ready.lines[0]!,1);
      expect(taken.lines[0]!.takenQuantity).toBe(1);
      expect((await run(repo=>repo.registration(r.id))).status).toBe('confirmed');
    });
    it('does not treat a pending v3 payment as resolved when ending the activity',async()=>{
      const localActivity=randomUUID();
      await admin.query(`INSERT INTO mbox.community_activities SELECT (jsonb_populate_record(NULL::mbox.community_activities,to_jsonb(a)||jsonb_build_object('id',$1::uuid,'public_id',$1::text,'ends_at',clock_timestamp()-interval '1 minute'))).* FROM mbox.community_activities a WHERE a.id=$2`,[localActivity,activity]);
      await registration([],{activityId:localActivity,pending:true});
      await expect(runner.run(scope,tx=>new ActivityOperationsRepository(tx).closeActivity(localActivity,'completed'))).rejects.toMatchObject({code:'ACTIVITY_CLOSE_BLOCKED'});
    });
    const cancelCustomerEntry=(publicId:string,actor=customer)=>runner.run(scope,tx=>new CustomerExperienceRepository(tx,true).cancelActivityRegistration({registrationPublicId:publicId,customerId:actor,reason:'本人取消未使用免费报名'}));
    it.each(['admit','redeem'] as const)('prevents customer cancellation of a free package after %s',async action=>{
      const free=await registration([item(await product())],{free:true});
      await door(free,action,action==='admit'?{arrivedCount:1}:{});
      await expect(cancelCustomerEntry(free.id)).rejects.toMatchObject({code:'ACTIVITY_USED_REFUND_REVIEW'});
      expect((await run(repo=>repo.registration(free.id))).status).toBe('confirmed');
    });
    it('keeps a paid child attached when the customer tries to cancel its free parent',async()=>{
      const parent=await registration([],{free:true}),dish=await product();
      await admin.query('UPDATE mbox.community_activities SET addon_product_ids=array_append(addon_product_ids,$2::uuid) WHERE id=$1',[activity,dish]);
      await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1000,'CNY',clock_timestamp()-interval '1 hour')`,[scope.tenantId,scope.storeId,dish]);
      const child=await buy(null,1,{purchaseKind:'single_dish',parentRegistrationPublicId:parent.id,productId:dish});await pay(child);
      await expect(cancelCustomerEntry(parent.id)).rejects.toMatchObject({code:'ACTIVITY_DEPENDENT_REFUND_REVIEW'});
      expect((await run(repo=>repo.registration(parent.id))).status).toBe('confirmed');
      expect((await door(parent,'redeem')).meal!.lines.map(line=>line.registrationPublicId)).toEqual([child.publicId]);
    });
    it('still allows the owner to cancel an unused free package, while a different member cannot',async()=>{
      const free=await registration([],{free:true}),other=randomUUID();
      await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)',[other,scope.tenantId,scope.storeId]);
      await expect(cancelCustomerEntry(free.id,other)).rejects.toThrow();
      expect((await run(repo=>repo.registration(free.id))).status).toBe('confirmed');
      expect(await cancelCustomerEntry(free.id)).toMatchObject({status:'cancelled'});
      await expect(door(free,'admit',{arrivedCount:1})).rejects.toMatchObject({code:'ACTIVITY_NOT_PAID'});
    });
    it('prevents the legacy unpaid cancellation from erasing admission on a free v3 package',async()=>{
      const free=await registration([],{free:true});await door(free,'admit',{arrivedCount:1});
      await expect(cancelLegacyEntry(free.id)).rejects.toMatchObject({code:'ACTIVITY_USED_REFUND_REVIEW'});
      expect(await run(repo=>repo.view(free.id))).toMatchObject({admittedCount:1,reservedSeats:5,paymentStatus:'not_required'});
      expect((await run(repo=>repo.registration(free.id))).status).toBe('confirmed');
    });
    it('prevents the legacy unpaid cancellation from erasing a redeemed free meal',async()=>{
      const free=await registration([item(await product(),1)],{free:true}),original=await door(free,'redeem');
      await expect(cancelLegacyEntry(free.id)).rejects.toMatchObject({code:'ACTIVITY_USED_REFUND_REVIEW'});
      const after=await run(repo=>repo.view(free.id));expect(after.meal).toEqual(original.meal);expect(after.reservedSeats).toBe(5);
      expect((await run(repo=>repo.registration(free.id))).status).toBe('confirmed');
    });
    it('prevents the legacy unpaid cancellation of a free parent with a paid dependent dish',async()=>{
      const parent=await registration([],{free:true}),dish=await product();
      await admin.query('UPDATE mbox.community_activities SET addon_product_ids=array_append(addon_product_ids,$2::uuid) WHERE id=$1',[activity,dish]);
      await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1200,'CNY',clock_timestamp()-interval '1 hour')`,[scope.tenantId,scope.storeId,dish]);
      const child=await buy(null,1,{purchaseKind:'single_dish',parentRegistrationPublicId:parent.id,productId:dish});await pay(child);
      await expect(cancelLegacyEntry(parent.id)).rejects.toMatchObject({code:'ACTIVITY_DEPENDENT_REFUND_REVIEW'});
      expect((await run(repo=>repo.registration(parent.id))).status).toBe('confirmed');
      expect((await run(repo=>repo.registration(child.publicId))).payment_status).toBe('paid');
      expect((await door(parent,'redeem')).meal!.lines.map(line=>line.registrationPublicId)).toEqual([child.publicId]);
    });
    it('still cancels an unused free v3 package through the existing operation',async()=>{
      const free=await registration([],{free:true}),contactId=randomUUID();
      await admin.query(`INSERT INTO mbox.community_activity_registration_contact_versions(tenant_id,store_id,public_id,registration_id,registration_cycle,version,status,contact_type,contact_hash,encrypted_contact,encryption_key_id,masked_contact,contact_source,created_by_customer_id,idempotency_key,request_sha256)
        VALUES($1,$2,$3,$4,1,1,'active','phone',$5,$6,'test-activity','138****8000','mini_program',$7,$8,$5)`,
        [scope.tenantId,scope.storeId,`ACV${contactId.replaceAll('-','').toUpperCase()}`,free.id,'a'.repeat(64),Buffer.from([1,...Array(31).fill(7)]),customer,contactId]);
      expect(await cancelLegacyEntry(free.id)).toMatchObject({status:'cancelled',paymentStatus:'not_required',serviceVersion:3});
      await expect(door(free,'admit',{arrivedCount:1})).rejects.toMatchObject({code:'ACTIVITY_NOT_PAID'});
    });
    it('requires an explicit fulfilment decision for any further refund after successful compensation',async()=>{
      const pkg=await salePackage(),purchase=await buy(pkg.id),payment=await pay(purchase);
      const partial=await requestRefund(payment.id,{amountMinor:1000,disposition:'retain_fulfillment',customerConfirmed:true});await completeRefund(payment,partial);
      await expect(requestRefund(payment.id)).rejects.toMatchObject({code:'ACTIVITY_COMPENSATION_DISPOSITION_REQUIRED'});
      expect((await admin.query('SELECT count(*)::int n FROM mbox.refunds WHERE payment_id=$1',[payment.id])).rows[0].n).toBe(1);
      const remainder=await requestRefund(payment.id,{amountMinor:4000,disposition:'retain_fulfillment',customerConfirmed:true});await completeRefund(payment,remainder);
      expect(await run(repo=>repo.registration(purchase.publicId))).toMatchObject({status:'confirmed',payment_status:'refunded',service_refund_disposition:'retain_fulfillment',reserved_seats:5});
    });

    it.each(['requested','approved','processing','failed'] as const)('prevents a plain refund while compensation is %s',async state=>{
      const pkg=await salePackage(),purchase=await buy(pkg.id),payment=await pay(purchase);
      const partial=await requestRefund(payment.id,{amountMinor:1000,disposition:'retain_fulfillment',customerConfirmed:true});
      if(state!=='requested'){
        const approver=randomUUID();await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'退款复核')",[approver,scope.tenantId,scope.storeId]);
        await runner.run(scope,tx=>new RefundRepository(tx).approve(partial.id,approver,'核对后同意补偿保留履约'));
        if(state!=='approved')await runner.run(scope,tx=>new RefundRepository(tx).beginExecution(partial.id));
        if(state==='failed'){
          const reference=partial.id.replaceAll('-','');
          await admin.query("UPDATE mbox.refunds SET merchant_refund_id=$2,provider_submission_started_at=clock_timestamp(),provider_submission_state='submitted' WHERE id=$1",[partial.id,reference]);
          await runner.run(scope,tx=>new RefundRepository(tx).completeProviderExecution({refundPublicId:reference,provider:'postar',succeeded:false,providerRefundId:`RF${reference}`,originalProviderTransactionId:payment.providerTransactionId!,reportedAmountMinor:1000,reportedCurrency:'CNY',providerSnapshot:{test:true}}));
        }
      }
      await expect(requestRefund(payment.id)).rejects.toMatchObject({code:'ACTIVITY_COMPENSATION_DISPOSITION_REQUIRED'});
      expect((await admin.query('SELECT count(*)::int n FROM mbox.refunds WHERE payment_id=$1',[payment.id])).rows[0].n).toBe(1);
    });
    it('allows a normal full refund after the pending compensation was rejected without a retained money decision',async()=>{
      const pkg=await salePackage(),purchase=await buy(pkg.id),payment=await pay(purchase);
      const partial=await requestRefund(payment.id,{amountMinor:1000,disposition:'retain_fulfillment',customerConfirmed:true});
      const approver=randomUUID();await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'退款复核')",[approver,scope.tenantId,scope.storeId]);
      await runner.run(scope,tx=>new RefundRepository(tx).reject(partial.id,approver,'补偿不通过，改为未使用整份退订'));
      const ordinary=await requestRefund(payment.id);expect(ordinary.amountMinor).toBe(5000);await completeRefund(payment,ordinary);
      expect(await run(repo=>repo.registration(purchase.publicId))).toMatchObject({status:'refunded',payment_status:'refunded',service_refund_disposition:null});
    });
    it('prevents compensation from taking money already reserved by an earlier normal whole refund',async()=>{
      const pkg=await salePackage(),purchase=await buy(pkg.id),payment=await pay(purchase);
      const ordinary=await requestRefund(payment.id);expect(ordinary.amountMinor).toBe(5000);
      await expect(requestRefund(payment.id,{amountMinor:1000,disposition:'retain_fulfillment',customerConfirmed:true})).rejects.toThrow('remaining');
      expect((await admin.query('SELECT count(*)::int n FROM mbox.refunds WHERE payment_id=$1',[payment.id])).rows[0].n).toBe(1);
      await completeRefund(payment,ordinary);expect((await run(repo=>repo.registration(purchase.publicId))).status).toBe('refunded');
    });
    it('serializes simultaneous normal and compensation requests without creating a mixed refund plan',async()=>{
      const pkg=await salePackage(),purchase=await buy(pkg.id),payment=await pay(purchase);
      const outcomes=await Promise.allSettled([requestRefund(payment.id),requestRefund(payment.id,{amountMinor:1000,disposition:'retain_fulfillment',customerConfirmed:true})]);
      expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
      const rows=(await admin.query('SELECT amount_minor::int amount,activity_disposition disposition FROM mbox.refunds WHERE payment_id=$1',[payment.id])).rows;
      expect(rows).toHaveLength(1);expect(rows[0]).toEqual(rows[0].disposition===null?{amount:5000,disposition:null}:{amount:1000,disposition:'retain_fulfillment'});
    });

});
