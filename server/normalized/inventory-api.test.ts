import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadNormalizedMigrations,
  runNormalizedMigrations,
  unwrapNormalizedMigrationTransaction,
} from "../migrate-normalized.js";
import { NormalizedCommandExecutor } from "./command-executor.js";
import { inventoryApiPlugin } from "./inventory-api.js";
import { InventoryQueryService } from "./inventory-query-service.js";
import { InventoryRepository } from "./inventory-repository.js";
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from "./transaction-runner.js";

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const tenantId = randomUUID();
const storeId = randomUUID();
const areaId = randomUUID();
const tableOneId = randomUUID();
const tableTwoId = randomUUID();
const tableOneSessionId = randomUUID();
const tableTwoSessionId = randomUUID();
const managerId = randomUUID();
const viewerId = randomUUID();
const approverId = randomUUID();
const managerRoleId = randomUUID();
const viewerRoleId = randomUUID();
const approverRoleId = randomUUID();
const productId = randomUUID();

integration("normalized inventory API PostgreSQL integration", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let spiritItemId = "";
  let snackItemId = "";
  let bottleItemId = "";

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl, max: 12 });
    await seed(pool);
    const runner = new ScopedPostgresTransactionRunner(
      pool as unknown as PostgresPool,
    );
    app = Fastify();
    await app.register(inventoryApiPlugin, {
      prefix: "/api",
      commands: new NormalizedCommandExecutor(runner),
      query: new InventoryQueryService(runner),
      resolveContext(request) {
        const raw = request.headers["x-employee-id"];
        return {
          scope: { tenantId, storeId },
          employeeId: typeof raw === "string" ? raw : managerId,
          businessDate: "2026-08-11",
          capabilities: [],
        };
      },
      createPublicId(kind) {
        return `${kind}-${randomUUID()}`;
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("creates an inventory item idempotently with one audit event and one outbox message", async () => {
    const request = {
      method: "POST" as const,
      url: "/api/inventory/items",
      headers: headers(managerId, "inventory-item-create-0001"),
      payload: {
        sku: "GIN-ML",
        name: "金酒原液",
        itemType: "ingredient",
        baseUnit: "ml",
        categoryCode: "spirits",
        lowStockThreshold: "200",
        reasonableWasteQuantity: "10",
        packageVolumeMl: "750",
      },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().meta.replayed).toBe(true);
    spiritItemId = first.json().data.id;

    const evidence = await pool.query<{
      audit_count: string;
      outbox_count: string;
    }>(
      `
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND action = 'inventory.item.create' AND object_id = $3) AS audit_count,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND aggregate_id = $3::uuid) AS outbox_count
    `,
      [tenantId, storeId, spiritItemId],
    );
    expect(evidence.rows[0]).toEqual({ audit_count: "1", outbox_count: "1" });
    expect(first.json().data.packageVolumeMl).toBe("750.000000");
  });

  it("updates historical inventory metadata without rewriting SKU or base unit", async () => {
    const update = {
      method: "PATCH" as const,
      url: `/api/inventory/items/${spiritItemId}`,
      headers: headers(managerId, "inventory-item-update-0001"),
      payload: {
        name: "金酒原液（750ml）",
        categoryCode: "spirits.gin",
        lowStockThreshold: "180",
        packageVolumeMl: "750",
      },
    };
    const first = await app.inject(update);
    const replay = await app.inject(update);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().meta.replayed).toBe(true);
    expect(first.json().data).toMatchObject({
      id: spiritItemId,
      sku: "GIN-ML",
      baseUnit: "ml",
      name: "金酒原液（750ml）",
      categoryCode: "spirits.gin",
      lowStockThreshold: "180.000000",
      packageVolumeMl: "750.000000",
    });

    const denied = await app.inject({
      ...update,
      headers: headers(viewerId, "inventory-item-update-denied-0002"),
    });
    expect(denied.statusCode).toBe(403);

    const invalidVolume = await app.inject({
      ...update,
      headers: headers(managerId, "inventory-item-update-invalid-volume-0003"),
      payload: { ...update.payload, packageVolumeMl: "0" },
    });
    expect(invalidVolume.statusCode).toBe(400);

    const persisted = await pool.query<{
      sku: string;
      base_unit: string;
      category_code: string;
      package_volume_ml: string;
    }>(`
      SELECT sku, base_unit, category_code, package_volume_ml::text
      FROM mbox.inventory_items
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [tenantId, storeId, spiritItemId]);
    expect(persisted.rows[0]).toEqual({
      sku: "GIN-ML",
      base_unit: "ml",
      category_code: "spirits.gin",
      package_volume_ml: "750.000000",
    });
  });

  it("does not silently relabel a historical bottle-count item as liquid inventory", async () => {
    const legacy = await createItem(
      "LEGACY-BOTTLE-COUNT",
      "历史瓶数酒水",
      false,
      "inventory-item-create-legacy-bottle-0001",
      "ingredient",
      "bottle",
      "legacy.inventory",
    );
    const relabel = await app.inject({
      method: "PATCH",
      url: `/api/inventory/items/${legacy.id}`,
      headers: headers(managerId, "inventory-item-relabel-legacy-bottle-0002"),
      payload: {
        name: "历史瓶数酒水",
        categoryCode: "spirits.whisky",
        packageVolumeMl: "700",
      },
    });
    expect(relabel.statusCode).toBe(409);
    expect(relabel.json().error.message).toContain("不能直接改成酒水品类");
  });

  it("binds duplicate scans to the same item but rejects one code bound to another item", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/inventory/items/${spiritItemId}/barcodes`,
      headers: headers(managerId, "barcode-bind-first-0001"),
      payload: { code: "690000000001", packageQuantity: "750" },
    });
    const repeatedScan = await app.inject({
      method: "POST",
      url: `/api/inventory/items/${spiritItemId}/barcodes`,
      headers: headers(managerId, "barcode-bind-second-0002"),
      payload: { code: "690000000001", packageQuantity: "750" },
    });
    expect(first.statusCode).toBe(200);
    expect(repeatedScan.statusCode).toBe(200);
    expect(repeatedScan.json().data.replayed).toBe(true);

    const snack = await createItem(
      "SNACK-PIECE",
      "坚果小食",
      true,
      "inventory-item-create-snack-0001",
    );
    snackItemId = snack.id;
    const bottle = await app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: headers(managerId, "inventory-item-create-bottle-0001"),
      payload: {
        sku: "GIN-BOTTLE",
        name: "客户瓶存金酒",
        itemType: "bottle",
        baseUnit: "ml",
        categoryCode: "bottled_spirits",
        packageVolumeMl: "750",
      },
    });
    expect(bottle.statusCode).toBe(201);
    bottleItemId = bottle.json().data.id;
    const conflict = await app.inject({
      method: "POST",
      url: `/api/inventory/items/${snackItemId}/barcodes`,
      headers: headers(managerId, "barcode-bind-conflict-0003"),
      payload: { code: "690000000001", packageQuantity: "1" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("stores BOM quantities as decimal values and keeps one active recipe", async () => {
    const result = await app.inject({
      method: "PUT",
      url: `/api/inventory/products/${productId}/recipe`,
      headers: headers(managerId, "recipe-replace-0001"),
      payload: {
        yieldQuantity: 1,
        components: [
          {
            inventoryItemId: spiritItemId,
            quantity: "45.5",
            expectedWasteQuantity: "1.25",
          },
        ],
      },
    });
    expect(result.statusCode).toBe(200);
    const row = await pool.query<{
      quantity: string;
      waste: string;
      active_count: string;
    }>(
      `
      SELECT item.quantity::text AS quantity, item.expected_waste_quantity::text AS waste,
        (SELECT count(*)::text FROM mbox.recipes WHERE tenant_id = $1 AND store_id = $2
          AND product_id = $3 AND status = 'active') AS active_count
      FROM mbox.recipe_items AS item JOIN mbox.recipes AS recipe ON recipe.id = item.recipe_id
      WHERE item.tenant_id = $1 AND item.store_id = $2 AND recipe.product_id = $3
    `,
      [tenantId, storeId, productId],
    );
    expect(row.rows[0]).toMatchObject({
      quantity: "45.500000",
      waste: "1.250000",
      active_count: "1",
    });

    const readable = await app.inject({
      method: "GET",
      url: `/api/inventory/products/${productId}/recipe`,
      headers: { "x-employee-id": managerId },
    });
    expect(readable.statusCode).toBe(200);
    expect(readable.json().data).toMatchObject({
      productId,
      version: 1,
      yieldQuantity: 1,
      components: [{
        inventoryItemId: spiritItemId,
        sku: "GIN-ML",
        name: "金酒原液（750ml）",
        baseUnit: "ml",
        quantity: "45.500000",
        expectedWasteQuantity: "1.250000",
      }],
    });

    const denied = await app.inject({
      method: "GET",
      url: `/api/inventory/products/${productId}/recipe`,
      headers: { "x-employee-id": viewerId },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("allows an explicitly not-managed food product without a recipe or fake stock", async () => {
    const foodProductId = randomUUID();
    await pool.query(
      `
      INSERT INTO mbox.products (
        tenant_id, store_id, id, code, name, category_code, fulfillment_station,
        product_snapshot, status, cost_amount_minor, inventory_control_mode
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'FRUIT-PLATE', '鲜果盘', 'food', 'kitchen',
        '{}'::jsonb, 'active', 1800, 'not_managed')
      `,
      [tenantId, storeId, foodProductId],
    );
    const runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool);
    const result = await runner.run({ tenantId, storeId }, (transaction) => (
      new InventoryRepository(transaction).consumeForOrderItems([{
        id: randomUUID(),
        orderId: randomUUID(),
        productId: foodProductId,
        quantity: 1,
        unitPriceMinor: 5800,
        discountAmountMinor: 0,
        totalAmountMinor: 5800,
        currency: 'CNY',
        fulfillmentStation: 'kitchen',
        productSnapshot: {},
        costSnapshot: {},
        status: 'submitted',
        note: null,
      }])
    ));
    expect(result).toEqual([]);
    const movements = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mbox.inventory_movements
       WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND reference_type='order_item'`,
      [tenantId, storeId],
    );
    expect(movements.rows[0]?.count).toBe('0');
  });

  it("turns a mobile scan package count and total cost into ml stock without requiring a manual batch or unit cost", async () => {
    const mobileItem = await createItem(
      "MOBILE-SCAN-ML",
      "手机扫码测试酒水",
      false,
      "inventory-mobile-item-0001",
      'bottle',
      'ml',
      'spirits.whisky',
    );
    const bind = await app.inject({
      method: 'POST',
      url: `/api/inventory/items/${mobileItem.id}/barcodes`,
      headers: headers(managerId, 'inventory-mobile-bind-0001'),
      payload: { code: 'MBOX-QR-CASE-0001', codeType: 'qr', packageQuantity: '750' },
    });
    expect(bind.statusCode).toBe(200);
    const rejectedOverride = await app.inject({
      method: 'POST',
      url: '/api/inventory/receipts',
      headers: headers(managerId, 'inventory-mobile-receipt-override-0001'),
      payload: {
        invoiceTotalMinor: '18000',
        lines: [{
          scanCode: 'MBOX-QR-CASE-0001',
          batchCode: 'MOBILE-BATCH-OVERRIDE',
          packages: '3',
          quantity: '999',
          unitCostMinor: '1',
          totalCostMinor: '18000',
        }],
      },
    });
    expect(rejectedOverride.statusCode).toBe(400);
    const created = await app.inject({
      method: 'POST',
      url: '/api/inventory/receipts',
      headers: headers(managerId, 'inventory-mobile-receipt-0001'),
      payload: {
        supplierSnapshot: { name: '手机扫码供应商' },
        invoiceTotalMinor: '18000',
        lines: [{
          scanCode: 'MBOX-QR-CASE-0001',
          packages: '3',
          totalCostMinor: '18000',
          metadata: { entryMethod: 'staff_mobile_camera' },
        }],
      },
    });
    expect(created.statusCode).toBe(201);
    const receiptId = created.json().data.id as string;
    const draft = await pool.query<{ quantity: string; unit_cost: string; on_hand: string; entry_method: string }>(
      `SELECT line.quantity::text AS quantity, line.unit_cost_minor::text AS unit_cost,
        balance.on_hand_quantity::text AS on_hand,
        line.metadata->>'entryMethod' AS entry_method
       FROM mbox.purchase_receipt_lines AS line
       JOIN mbox.inventory_balances AS balance
         ON balance.tenant_id=line.tenant_id AND balance.store_id=line.store_id
        AND balance.inventory_item_id=line.inventory_item_id
       WHERE line.tenant_id=$1::uuid AND line.store_id=$2::uuid AND line.receipt_id=$3::uuid`,
      [tenantId, storeId, receiptId],
    );
    expect(draft.rows[0]).toEqual({ quantity: '2250.000000', unit_cost: '8.000000', on_hand: '0.000000', entry_method: 'staff_mobile_camera' });
    const dashboard = await app.inject({
      method: 'GET',
      url: '/api/inventory',
      headers: { 'x-employee-id': managerId },
    });
    expect(dashboard.statusCode).toBe(200);
    const recoverableDraft = (dashboard.json().data.receipts as Array<Record<string, unknown>>)
      .find((receipt) => receipt.id === receiptId);
    expect(recoverableDraft).toEqual(expect.objectContaining({
      status: 'draft',
      lineCount: 1,
      invoiceTotalMinor: '18000',
      lines: [expect.objectContaining({
        inventoryItemId: mobileItem.id,
        itemName: '手机扫码测试酒水',
        batchCode: 'AUTO-20260811-01',
        quantity: '2250.000000',
        baseUnit: 'ml',
        packageCount: '3',
        packageVolumeMl: '750.000000',
        unitCostMinor: '8.000000',
        perPackageCostMinor: '6000.000000',
        totalCostMinor: '18000',
      })],
    }));
    const received = await app.inject({
      method: 'POST',
      url: `/api/inventory/receipts/${receiptId}/receive`,
      headers: headers(managerId, 'inventory-mobile-receive-0001'),
    });
    expect(received.statusCode).toBe(200);
    const balance = await pool.query<{ on_hand: string }>(
      `SELECT on_hand_quantity::text AS on_hand FROM mbox.inventory_balances
       WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid`,
      [tenantId, storeId, mobileItem.id],
    );
    expect(balance.rows[0]?.on_hand).toBe('2250.000000');

    const selectedItemReceipt = await app.inject({
      method: 'POST',
      url: '/api/inventory/receipts',
      headers: headers(managerId, 'inventory-mobile-selected-item-0003'),
      payload: {
        lines: [{
          inventoryItemId: mobileItem.id,
          packages: '2',
          totalCostMinor: '12000',
          metadata: { entryMethod: 'staff_mobile_selection' },
        }],
      },
    });
    expect(selectedItemReceipt.statusCode).toBe(201);
    const selectedLine = await pool.query<{
      batch_code: string;
      quantity: string;
      unit_cost: string;
    }>(`
      SELECT batch_code,quantity::text,unit_cost_minor::text AS unit_cost
      FROM mbox.purchase_receipt_lines
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND receipt_id=$3::uuid
    `, [tenantId, storeId, selectedItemReceipt.json().data.id as string]);
    expect(selectedLine.rows[0]).toEqual({
      batch_code: 'AUTO-20260811-01',
      quantity: '1500.000000',
      unit_cost: '8.000000',
    });
  });

  it("receives a purchase batch once, keeps decimal cost, and redacts supplier data without cost permission", async () => {
    const rejectsManualUnitCost = await app.inject({
      method: "POST",
      url: "/api/inventory/receipts",
      headers: headers(managerId, "receipt-create-reject-manual-unit-cost-0001"),
      payload: {
        lines: [{
          inventoryItemId: spiritItemId,
          batchCode: "REJECT-MANUAL-UNIT-COST",
          quantity: "1",
          unitCostMinor: "99",
          totalCostMinor: "99",
        }],
      },
    });
    expect(rejectsManualUnitCost.statusCode).toBe(400);
    expect(rejectsManualUnitCost.json().error.message).toContain("不再录入单位成本");

    const created = await app.inject({
      method: "POST",
      url: "/api/inventory/receipts",
      headers: headers(managerId, "receipt-create-0001"),
      payload: {
        supplierRef: "SUP-SECRET",
        supplierSnapshot: { name: "敏感供应商", phone: "13800000000" },
        invoiceTotalMinor: "123",
        lines: [
          {
            inventoryItemId: spiritItemId,
            batchCode: "BATCH-A",
            quantity: "10",
            totalCostMinor: "123",
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const receiptId = created.json().data.id as string;
    const receiveRequest = {
      method: "POST" as const,
      url: `/api/inventory/receipts/${receiptId}/receive`,
      headers: headers(managerId, "receipt-receive-0001"),
    };
    expect((await app.inject(receiveRequest)).statusCode).toBe(200);
    expect((await app.inject(receiveRequest)).json().meta.replayed).toBe(true);

    const managerView = await app.inject({
      method: "GET",
      url: "/api/inventory",
      headers: { "x-employee-id": managerId },
    });
    const viewerView = await app.inject({
      method: "GET",
      url: "/api/inventory",
      headers: { "x-employee-id": viewerId },
    });
    const managerReceipt = (managerView.json().data.receipts as Array<Record<string, unknown>>)
      .find((receipt) => receipt.id === receiptId);
    const viewerReceipt = (viewerView.json().data.receipts as Array<Record<string, unknown>>)
      .find((receipt) => receipt.id === receiptId);
    expect(managerView.statusCode).toBe(200);
    expect(managerReceipt?.supplier).toMatchObject({ name: "敏感供应商" });
    expect(managerReceipt?.invoiceTotalMinor).toBe("123");
    expect(managerReceipt?.lines).toEqual([
      expect.objectContaining({
        inventoryItemId: spiritItemId,
        quantity: "10.000000",
        totalCostMinor: "123",
        unitCostMinor: "12.300000",
      }),
    ]);
    const managerItem = managerView
      .json()
      .data.items.find((item: { id: string }) => item.id === spiritItemId);
    expect(managerItem.weightedUnitCostMinor).toBe("12.300000");
    expect(managerItem.latestPurchaseUnitCostMinor).toBe("12.300000");
    expect(managerItem.latestReceivedAt).toEqual(expect.any(String));
    expect(viewerView.statusCode).toBe(200);
    expect(viewerReceipt).not.toHaveProperty("supplier");
    expect(viewerReceipt).not.toHaveProperty(
      "supplierRef",
    );
    expect(
      viewerView
        .json()
        .data.items.find((item: { id: string }) => item.id === spiritItemId),
    ).not.toHaveProperty("weightedUnitCostMinor");
    const receiptLine = await pool.query<{ id: string }>(
      `
      SELECT id FROM mbox.purchase_receipt_lines
      WHERE tenant_id = $1 AND store_id = $2 AND receipt_id = $3
    `,
      [tenantId, storeId, receiptId],
    );
    await expect(
      pool.query(
        `UPDATE mbox.purchase_receipt_lines SET quantity = 999 WHERE id = $1`,
        [receiptLine.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("uses moving weighted cost for later receipts and automatically refreshes tracked recipe cost", async () => {
    const bundleProductId = randomUUID();
    await pool.query(
      `INSERT INTO mbox.products(
        id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,
        product_snapshot,status,cost_amount_minor,inventory_control_mode,cost_source
      ) VALUES($1,$2,$3,'COST-ROLLUP-BUNDLE','成本联动组合','combo','none','bundle',
        '{}'::jsonb,'inactive',0,'tracked','manual')`,
      [bundleProductId, tenantId, storeId],
    );
    await pool.query(
      `INSERT INTO mbox.product_bundle_components(
        tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order
      ) VALUES($1,$2,$3,$4,2,10)`,
      [tenantId, storeId, bundleProductId, productId],
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/inventory/receipts",
      headers: headers(managerId, "receipt-create-weighted-average-0001"),
      payload: {
        invoiceTotalMinor: "900",
        lines: [{
          inventoryItemId: spiritItemId,
          batchCode: "BATCH-B",
          quantity: "30",
          totalCostMinor: "900",
        }],
      },
    });
    expect(created.statusCode).toBe(201);
    const receiptId = created.json().data.id as string;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/inventory/receipts/${receiptId}/receive`,
          headers: headers(managerId, "receipt-receive-weighted-average-0002"),
        })
      ).statusCode,
    ).toBe(200);

    const evidence = await pool.query<{
      on_hand: string;
      weighted_cost: string;
      status: string;
      product_cost: string;
      product_cost_source: string;
      bundle_cost: string;
      bundle_cost_source: string;
      versions: string;
      basis: string;
    }>(`
      SELECT balance.on_hand_quantity::text AS on_hand,
        balance.weighted_unit_cost_minor::text AS weighted_cost,
        balance.cost_status AS status,
        product.cost_amount_minor::text AS product_cost,
        product.cost_source AS product_cost_source,
        (SELECT bundle.cost_amount_minor::text FROM mbox.products bundle
          WHERE bundle.tenant_id=$1::uuid AND bundle.store_id=$2::uuid AND bundle.id=$5::uuid) AS bundle_cost,
        (SELECT bundle.cost_source FROM mbox.products bundle
          WHERE bundle.tenant_id=$1::uuid AND bundle.store_id=$2::uuid AND bundle.id=$5::uuid) AS bundle_cost_source,
        (SELECT count(*)::text FROM mbox.recipe_cost_versions version
          WHERE version.tenant_id=$1::uuid AND version.store_id=$2::uuid AND version.product_id=$3::uuid) AS versions,
        (SELECT component.cost_basis FROM mbox.recipe_cost_components component
          JOIN mbox.recipe_cost_versions version
            ON version.tenant_id=component.tenant_id AND version.store_id=component.store_id
           AND version.id=component.recipe_cost_version_id
          WHERE version.tenant_id=$1::uuid AND version.store_id=$2::uuid AND version.product_id=$3::uuid
          ORDER BY version.calculated_at DESC,version.id DESC LIMIT 1) AS basis
      FROM mbox.inventory_balances balance
      JOIN mbox.products product
        ON product.tenant_id=balance.tenant_id AND product.store_id=balance.store_id AND product.id=$3::uuid
      WHERE balance.tenant_id=$1::uuid AND balance.store_id=$2::uuid AND balance.inventory_item_id=$4::uuid
    `, [tenantId, storeId, productId, spiritItemId, bundleProductId]);
    expect(evidence.rows[0]).toEqual({
      on_hand: "40.000000",
      weighted_cost: "25.575000",
      status: "complete",
      product_cost: "1196",
      product_cost_source: "recipe",
      bundle_cost: "2392",
      bundle_cost_source: "bundle",
      versions: "2",
      basis: "moving_weighted_average",
    });
  });

  it("allows only an auditable permissioned correction when a current inventory cost must be reviewed", async () => {
    const denied = await app.inject({
      method: "POST",
      url: `/api/inventory/items/${spiritItemId}/cost-corrections`,
      headers: headers(viewerId, "inventory-cost-correction-denied-0001"),
      payload: { weightedUnitCostMinor: "26.125", reason: "复核进货单" },
    });
    expect(denied.statusCode).toBe(403);

    // A correction changes a financial valuation and must display the old and
    // new basis. Granting only the write capability cannot leak that cost
    // data; the store administrator has to configure both permissions.
    await grant(pool, viewerRoleId, ["inventory.cost.correct"]);
    const cannotReviewCost = await app.inject({
      method: "POST",
      url: `/api/inventory/items/${spiritItemId}/cost-corrections`,
      headers: headers(viewerId, "inventory-cost-correction-no-view-0002"),
      payload: { weightedUnitCostMinor: "26.125", reason: "复核进货单" },
    });
    expect(cannotReviewCost.statusCode).toBe(403);

    const corrected = await app.inject({
      method: "POST",
      url: `/api/inventory/items/${spiritItemId}/cost-corrections`,
      headers: headers(managerId, "inventory-cost-correction-apply-0002"),
      payload: { weightedUnitCostMinor: "26.125", reason: "盘点后核对到原始进货单" },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().data).toMatchObject({
      inventoryItemId: spiritItemId,
      previousWeightedUnitCostMinor: "25.575000",
      weightedUnitCostMinor: "26.125000",
      differenceWeightedUnitCostMinor: "0.550000",
    });
    const correctionId = corrected.json().data.id as string;

    const evidence = await pool.query<{
      weighted_cost: string;
      status: string;
      basis: string;
      correction_count: string;
      audit_count: string;
      outbox_count: string;
      product_cost: string;
      recipe_basis: string;
      bundle_cost: string;
      bundle_source: string;
    }>(`
      SELECT balance.weighted_unit_cost_minor::text AS weighted_cost,
        balance.cost_status AS status,
        balance.cost_basis AS basis,
        (SELECT count(*)::text FROM mbox.inventory_cost_corrections correction
          WHERE correction.tenant_id=$1::uuid AND correction.store_id=$2::uuid
            AND correction.inventory_item_id=$3::uuid) AS correction_count,
        (SELECT count(*)::text FROM mbox.audit_events audit
          WHERE audit.tenant_id=$1::uuid AND audit.store_id=$2::uuid
            AND audit.action='inventory.cost.correct' AND audit.object_id=$5::text) AS audit_count,
        (SELECT count(*)::text FROM mbox.outbox_messages outbox
          WHERE outbox.tenant_id=$1::uuid AND outbox.store_id=$2::uuid
            AND outbox.aggregate_id=$5::uuid) AS outbox_count,
        (SELECT product.cost_amount_minor::text FROM mbox.products product
          WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid AND product.id=$4::uuid) AS product_cost,
        (SELECT component.cost_basis FROM mbox.recipe_cost_components component
          JOIN mbox.recipe_cost_versions version
            ON version.tenant_id=component.tenant_id AND version.store_id=component.store_id
           AND version.id=component.recipe_cost_version_id
          WHERE version.tenant_id=$1::uuid AND version.store_id=$2::uuid AND version.product_id=$4::uuid
          ORDER BY version.calculated_at DESC,version.id DESC LIMIT 1) AS recipe_basis,
        (SELECT bundle.cost_amount_minor::text FROM mbox.products bundle
          WHERE bundle.tenant_id=$1::uuid AND bundle.store_id=$2::uuid AND bundle.code='COST-ROLLUP-BUNDLE') AS bundle_cost,
        (SELECT bundle.cost_source FROM mbox.products bundle
          WHERE bundle.tenant_id=$1::uuid AND bundle.store_id=$2::uuid AND bundle.code='COST-ROLLUP-BUNDLE') AS bundle_source
      FROM mbox.inventory_balances balance
      WHERE balance.tenant_id=$1::uuid AND balance.store_id=$2::uuid AND balance.inventory_item_id=$3::uuid
    `, [tenantId, storeId, spiritItemId, productId, correctionId]);
    expect(evidence.rows[0]).toEqual({
      weighted_cost: "26.125000",
      status: "complete",
      basis: "manual_correction",
      correction_count: "1",
      audit_count: "1",
      outbox_count: "1",
      product_cost: "1221",
      recipe_basis: "manual_correction",
      bundle_cost: "2442",
      bundle_source: "bundle",
    });
  });

  it("previews the selected receipt cost, rolls back a blocked publication, then atomically applies the new cost and publishes", async () => {
    const launchItem = await createItem(
      "LAUNCH-SPIRIT-ML",
      "发布测试酒液",
      false,
      "inventory-launch-item-0001",
      "ingredient",
      "ml",
      "spirits",
    );
    const bound = await app.inject({
      method: "POST",
      url: `/api/inventory/items/${launchItem.id}/barcodes`,
      headers: headers(managerId, "inventory-launch-bind-0001"),
      payload: { code: "6970000000123", packageQuantity: "750" },
    });
    expect(bound.statusCode).toBe(200);

    const launchProductId = randomUUID();
    await pool.query(
      `INSERT INTO mbox.products(
        id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,
        product_snapshot,status,cost_amount_minor,inventory_control_mode,guest_visible,allowed_channels
      ) VALUES($1,$2,$3,'LAUNCH-GLASS','发布测试单杯','spirits','bar','single',
        '{"salesSpecificationType":"glass"}'::jsonb,'inactive',100,'tracked',true,ARRAY['guest_qr']::text[])
      `,
      [launchProductId, tenantId, storeId],
    );
    await pool.query(
      `INSERT INTO mbox.product_prices(
        tenant_id,store_id,product_id,price_type,currency,amount_minor,valid_from
      ) VALUES($1,$2,$3,'standard','CNY',6800,clock_timestamp())`,
      [tenantId, storeId, launchProductId],
    );
    const recipe = await app.inject({
      method: "PUT",
      url: `/api/inventory/products/${launchProductId}/recipe`,
      headers: headers(managerId, "inventory-launch-recipe-0001"),
      payload: {
        yieldQuantity: 1,
        components: [{ inventoryItemId: launchItem.id, quantity: "50", expectedWasteQuantity: "0" }],
      },
    });
    expect(recipe.statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: "/api/inventory/receipts",
      headers: headers(managerId, "inventory-launch-receipt-0001"),
      payload: {
        invoiceTotalMinor: "30000",
        lines: [{ scanCode: "6970000000123", batchCode: "LAUNCH-BATCH", packages: "2", totalCostMinor: "30000" }],
      },
    });
    expect(created.statusCode).toBe(201);
    const receiptId = created.json().data.id as string;

    const preview = await app.inject({
      method: "POST",
      url: `/api/inventory/receipts/${receiptId}/receive-and-publish-preview`,
      headers: headers(managerId, "inventory-launch-preview-0001"),
      payload: { productId: launchProductId },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data).toMatchObject({
      productId: launchProductId,
      salesSpecificationType: "glass",
      costAmountMinor: 1000,
      standardPriceMinor: 6800,
      grossProfitMinor: 5800,
      marginBasisPoints: 8529,
      sellableServings: 30,
      guestVisible: true,
      allowedChannels: ["guest_qr"],
      components: [{
        inventoryItemId: launchItem.id,
        incomingQuantity: "1500.000000",
        totalAvailableAfterReceipt: "1500.000000",
        perServingDeduction: "50.0000000000000000",
        sourceUnitCostMinor: "20.000000",
      }],
    });
    const before = await pool.query<{ status: string; on_hand: string; cost: string }>(
      `SELECT receipt.status,balance.on_hand_quantity::text AS on_hand,product.cost_amount_minor::text AS cost
       FROM mbox.purchase_receipts receipt
       JOIN mbox.purchase_receipt_lines line ON line.receipt_id=receipt.id
       JOIN mbox.inventory_balances balance ON balance.inventory_item_id=line.inventory_item_id
        AND balance.tenant_id=line.tenant_id AND balance.store_id=line.store_id
       JOIN mbox.products product ON product.id=$4
       WHERE receipt.tenant_id=$1 AND receipt.store_id=$2 AND receipt.id=$3`,
      [tenantId, storeId, receiptId, launchProductId],
    );
    expect(before.rows[0]).toEqual({ status: "draft", on_hand: "0.000000", cost: null });

    const blocked = await app.inject({
      method: "POST",
      url: `/api/inventory/receipts/${receiptId}/receive-and-publish`,
      headers: headers(managerId, "inventory-launch-publish-blocked-0001"),
      payload: { productId: launchProductId },
    });
    expect(blocked.statusCode).toBe(409);
    const rolledBack = await pool.query<{ status: string; on_hand: string; cost: string; cost_versions: string }>(
      `SELECT receipt.status,balance.on_hand_quantity::text AS on_hand,product.cost_amount_minor::text AS cost,
        (SELECT count(*)::text FROM mbox.recipe_cost_versions version WHERE version.product_id=$4) AS cost_versions
       FROM mbox.purchase_receipts receipt
       JOIN mbox.purchase_receipt_lines line ON line.receipt_id=receipt.id
       JOIN mbox.inventory_balances balance ON balance.inventory_item_id=line.inventory_item_id
        AND balance.tenant_id=line.tenant_id AND balance.store_id=line.store_id
       JOIN mbox.products product ON product.id=$4
       WHERE receipt.tenant_id=$1 AND receipt.store_id=$2 AND receipt.id=$3`,
      [tenantId, storeId, receiptId, launchProductId],
    );
    expect(rolledBack.rows[0]).toEqual({ status: "draft", on_hand: "0.000000", cost: null, cost_versions: "0" });

    await pool.query(
      `UPDATE mbox.products SET allowed_channels=ARRAY['guest_qr','staff_assisted']::text[] WHERE id=$1`,
      [launchProductId],
    );
    const published = await app.inject({
      method: "POST",
      url: `/api/inventory/receipts/${receiptId}/receive-and-publish`,
      headers: headers(managerId, "inventory-launch-publish-0002"),
      payload: { productId: launchProductId },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().data).toMatchObject({
      productId: launchProductId,
      productStatus: "active",
      salesSpecificationType: "glass",
      costAmountMinor: 1000,
      standardPriceMinor: 6800,
      grossProfitMinor: 5800,
    });
    const authoritative = await pool.query<{ status: string; on_hand: string; cost: string; version_id: string | null }>(
      `SELECT receipt.status,balance.on_hand_quantity::text AS on_hand,product.cost_amount_minor::text AS cost,
        product.recipe_cost_version_id::text AS version_id
       FROM mbox.purchase_receipts receipt
       JOIN mbox.purchase_receipt_lines line ON line.receipt_id=receipt.id
       JOIN mbox.inventory_balances balance ON balance.inventory_item_id=line.inventory_item_id
        AND balance.tenant_id=line.tenant_id AND balance.store_id=line.store_id
       JOIN mbox.products product ON product.id=$4
       WHERE receipt.tenant_id=$1 AND receipt.store_id=$2 AND receipt.id=$3`,
      [tenantId, storeId, receiptId, launchProductId],
    );
    expect(authoritative.rows[0]).toMatchObject({ status: "received", on_hand: "1500.000000", cost: "1000" });
    expect(authoritative.rows[0]?.version_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("serializes competing deductions so stock cannot be overdrawn or rolled back by a stale click", async () => {
    const requests = [
      "waste-concurrent-one-0001",
      "waste-concurrent-two-0002",
    ].map((key) =>
      app.inject({
        method: "POST",
        url: `/api/inventory/items/${spiritItemId}/waste`,
        headers: headers(managerId, key),
        payload: {
          quantity: "25",
          wasteType: "mixing_failure",
          reason: "并发扣减验证",
        },
      }),
    );
    const responses = await Promise.all(requests);
    expect(responses.map((item) => item.statusCode).toSorted()).toEqual([
      200, 409,
    ]);
    expect(responses.find((item) => item.statusCode === 200)?.json().data).toMatchObject({
      remainingQuantity: "15.000000",
      baseUnit: "ml",
      wasteType: "mixing_failure",
      unitCostMinor: "26.125000",
      wasteCostMinor: "653",
    });
    const balance = await pool.query<{ on_hand: string; waste_count: string }>(
      `
      SELECT balance.on_hand_quantity::text AS on_hand,
        (SELECT count(*)::text FROM mbox.inventory_movements AS movement
          WHERE movement.tenant_id = $1 AND movement.store_id = $2
            AND movement.inventory_item_id = $3 AND movement.movement_type = 'waste') AS waste_count
      FROM mbox.inventory_balances AS balance
      WHERE balance.tenant_id = $1 AND balance.store_id = $2 AND balance.inventory_item_id = $3
    `,
      [tenantId, storeId, spiritItemId],
    );
    expect(balance.rows[0]).toEqual({ on_hand: "15.000000", waste_count: "1" });
    const movement = await pool.query<{ id: string; unit_cost_minor: string; waste_type: string }>(
      `
      SELECT id, unit_cost_minor::text, metadata->>'wasteType' AS waste_type
      FROM mbox.inventory_movements
      WHERE tenant_id = $1 AND store_id = $2 AND inventory_item_id = $3
      ORDER BY occurred_at DESC LIMIT 1
    `,
      [tenantId, storeId, spiritItemId],
    );
    expect(movement.rows[0]).toMatchObject({ unit_cost_minor: "26.125000", waste_type: "mixing_failure" });
    await expect(
      pool.query(
        `UPDATE mbox.inventory_movements SET reason = '篡改' WHERE id = $1`,
        [movement.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("requires independent stock-count approval and enforces integer snack counts in PostgreSQL", async () => {
    await receiveStock(snackItemId, "3", "snack-receipt");
    const invalid = await app.inject({
      method: "POST",
      url: "/api/inventory/stock-counts",
      headers: headers(managerId, "stock-count-invalid-0001"),
      payload: {
        lines: [{ inventoryItemId: snackItemId, countedQuantity: "1.5" }],
      },
    });
    expect(invalid.statusCode).toBe(409);

    const created = await app.inject({
      method: "POST",
      url: "/api/inventory/stock-counts",
      headers: headers(managerId, "stock-count-create-0002"),
      payload: {
        lines: [{ inventoryItemId: spiritItemId, countedQuantity: "2" }],
      },
    });
    const countId = created.json().data.id as string;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/inventory/stock-counts/${countId}/submit`,
          headers: headers(managerId, "stock-count-submit-0003"),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/inventory/stock-counts/${countId}/approve`,
          headers: headers(managerId, "stock-count-self-approve-0004"),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/inventory/stock-counts/${countId}/approve`,
          headers: headers(approverId, "stock-count-approve-0005"),
        })
      ).statusCode,
    ).toBe(200);
    const balance = await pool.query<{ quantity: string }>(
      `
      SELECT on_hand_quantity::text AS quantity FROM mbox.inventory_balances
      WHERE tenant_id = $1 AND store_id = $2 AND inventory_item_id = $3
    `,
      [tenantId, storeId, spiritItemId],
    );
    expect(balance.rows[0]?.quantity).toBe("2.000000");

    const rejectable = await app.inject({
      method: "POST",
      url: "/api/inventory/stock-counts",
      headers: headers(managerId, "stock-count-reject-create-0006"),
      payload: {
        lines: [{ inventoryItemId: snackItemId, countedQuantity: "2" }],
      },
    });
    const rejectableId = rejectable.json().data.id as string;
    await app.inject({
      method: "POST",
      url: `/api/inventory/stock-counts/${rejectableId}/submit`,
      headers: headers(managerId, "stock-count-reject-submit-0007"),
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/inventory/stock-counts/${rejectableId}/reject`,
      headers: headers(approverId, "stock-count-reject-0008"),
      payload: { reason: "盘点依据不足，需要重新清点" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().data.status).toBe("rejected");
  });

  it("checks current table responsibility before bottle storage and denies unauthorized inventory writes", async () => {
    const deniedReceipt = await app.inject({
      method: "POST",
      url: "/api/inventory/receipts",
      headers: headers(viewerId, "viewer-receipt-denied-0001"),
      payload: {
        lines: [
          {
            inventoryItemId: spiritItemId,
            batchCode: "DENIED",
            quantity: "1",
            totalCostMinor: "1",
          },
        ],
      },
    });
    expect(deniedReceipt.statusCode).toBe(403);

    const stored = await app.inject({
      method: "POST",
      url: "/api/inventory/stored-bottles",
      headers: headers(managerId, "bottle-store-allowed-0001"),
      payload: {
        inventoryItemId: bottleItemId,
        tableSessionId: tableOneSessionId,
        quantity: "500",
        holderDisplayName: "王女士",
      },
    });
    expect(stored.statusCode).toBe(201);
    const bottleId = stored.json().data.id as string;
    const used = await app.inject({
      method: "POST",
      url: `/api/inventory/stored-bottles/${bottleId}/use`,
      headers: headers(managerId, "bottle-use-0002"),
      payload: { quantity: "100" },
    });
    expect(used.statusCode).toBe(200);
    expect(used.json().data.remainingQuantity).toBe("400.000000");
    const deniedTransfer = await app.inject({
      method: "POST",
      url: `/api/inventory/stored-bottles/${bottleId}/transfer`,
      headers: headers(managerId, "bottle-transfer-denied-0003"),
      payload: { toTableSessionId: tableTwoSessionId, reason: "客人更换桌位" },
    });
    expect(deniedTransfer.statusCode).toBe(403);
    await pool.query(
      `
      INSERT INTO mbox.table_assignments(tenant_id, store_id, table_id, employee_id, role_id, reason)
      VALUES ($1, $2, $3, $4, $5, '瓶存转桌责任测试')
    `,
      [tenantId, storeId, tableTwoId, managerId, managerRoleId],
    );
    const transferred = await app.inject({
      method: "POST",
      url: `/api/inventory/stored-bottles/${bottleId}/transfer`,
      headers: headers(managerId, "bottle-transfer-allowed-0004"),
      payload: { toTableSessionId: tableTwoSessionId, reason: "客人更换桌位" },
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json().data.tableSessionId).toBe(tableTwoSessionId);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/inventory/stored-bottles/${bottleId}/void`,
          headers: headers(managerId, "bottle-void-0005"),
          payload: { reason: "客户确认放弃瓶存" },
        })
      ).statusCode,
    ).toBe(200);
    const unassigned = await app.inject({
      method: "POST",
      url: "/api/inventory/stored-bottles",
      headers: headers(approverId, "bottle-store-unassigned-0002"),
      payload: {
        inventoryItemId: bottleItemId,
        tableSessionId: tableTwoSessionId,
        quantity: "500",
      },
    });
    expect(unassigned.statusCode).toBe(403);
  });

  it("marks legacy tracked costs incomplete before they can be copied into new margin data", async () => {
    const legacyItem = await createItem(
      "MIGRATION-LEGACY-ML",
      "待核对历史威士忌",
      false,
      "inventory-migration-legacy-item-0001",
      "ingredient",
      "ml",
      "spirits.whisky",
    );
    const legacyProductId = randomUUID();
    const legacyBundleId = randomUUID();
    const legacyRecipeId = randomUUID();
    const historicalOrderId = randomUUID();
    const historicalOrderItemId = randomUUID();
    await pool.query(
      `UPDATE mbox.inventory_balances
       SET on_hand_quantity=700,weighted_unit_cost_minor=NULL,
         latest_purchase_unit_cost_minor=NULL,cost_status='needs_review',cost_basis='none'
       WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid`,
      [tenantId, storeId, legacyItem.id],
    );
    await pool.query(
      `INSERT INTO mbox.products(
        id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,
        status,cost_amount_minor,inventory_control_mode,cost_source
      ) VALUES($1,$2,$3,'MIGRATION-LEGACY-GLASS','历史单杯','spirits','bar','single',
        'active',4200,'tracked','manual'),
        ($4,$2,$3,'MIGRATION-LEGACY-BUNDLE','历史组合','combo','none','bundle',
        'active',8400,'tracked','bundle')`,
      [legacyProductId, tenantId, storeId, legacyBundleId],
    );
    await pool.query(
      `INSERT INTO mbox.recipes(
        id,tenant_id,store_id,product_id,version,yield_quantity,status,effective_at
      ) VALUES($1,$2,$3,$4,1,1,'active',clock_timestamp())`,
      [legacyRecipeId, tenantId, storeId, legacyProductId],
    );
    await pool.query(
      `INSERT INTO mbox.recipe_items(
        tenant_id,store_id,recipe_id,inventory_item_id,quantity,expected_waste_quantity
      ) VALUES($1,$2,$3,$4,45,0)`,
      [tenantId, storeId, legacyRecipeId, legacyItem.id],
    );
    await pool.query(
      `INSERT INTO mbox.product_bundle_components(
        tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order
      ) VALUES($1,$2,$3,$4,2,1)`,
      [tenantId, storeId, legacyBundleId, legacyProductId],
    );
    await pool.query(
      `INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,total_amount_minor
      ) VALUES($1,$2,$3,$4,'migration-historical-order','cashier','submitted','unpaid',6800,6800)`,
      [historicalOrderId, tenantId, storeId, tableOneSessionId],
    );
    await pool.query(
      `INSERT INTO mbox.order_items(
        id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,
        fulfillment_station,product_snapshot,cost_snapshot,status
      ) VALUES($1,$2,$3,$4,$5,1,6800,6800,'bar','{}'::jsonb,
        '{"source":"legacy","unitCostMinor":4200}'::jsonb,'submitted')`,
      [historicalOrderItemId, tenantId, storeId, historicalOrderId, legacyProductId],
    );

    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === "154");
    expect(migration).toBeDefined();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(unwrapNormalizedMigrationTransaction(migration!.sql));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const evidence = await pool.query<{
      product_cost: string | null;
      product_source: string;
      bundle_cost: string | null;
      bundle_source: string;
      historical_cost: string | null;
    }>(`
      SELECT
        (SELECT cost_amount_minor::text FROM mbox.products
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid) AS product_cost,
        (SELECT cost_source FROM mbox.products
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid) AS product_source,
        (SELECT cost_amount_minor::text FROM mbox.products
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$4::uuid) AS bundle_cost,
        (SELECT cost_source FROM mbox.products
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$4::uuid) AS bundle_source,
        (SELECT cost_snapshot->>'unitCostMinor' FROM mbox.order_items
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$5::uuid) AS historical_cost
    `, [tenantId, storeId, legacyProductId, legacyBundleId, historicalOrderItemId]);
    expect(evidence.rows[0]).toEqual({
      product_cost: null,
      product_source: "incomplete",
      bundle_cost: null,
      bundle_source: "incomplete",
      historical_cost: "4200",
    });
  });

  async function createItem(
    sku: string,
    name: string,
    wholeUnitCount: boolean,
    key: string,
    itemType = 'food',
    baseUnit = 'piece',
    categoryCode = 'snack',
  ) {
    const result = await app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: headers(managerId, key),
      payload: {
        sku,
        name,
        itemType,
        baseUnit,
        categoryCode,
        wholeUnitCount,
        reasonableWasteQuantity: "1",
        ...(baseUnit === "ml" ? { packageVolumeMl: "750" } : {}),
      },
    });
    expect(result.statusCode).toBe(201);
    return result.json().data as { id: string };
  }

  async function receiveStock(
    itemId: string,
    quantity: string,
    keyPrefix: string,
  ) {
    const created = await app.inject({
      method: "POST",
      url: "/api/inventory/receipts",
      headers: headers(managerId, `${keyPrefix}-create-0001`),
      payload: {
        lines: [
          {
            inventoryItemId: itemId,
            batchCode: keyPrefix,
            quantity,
            totalCostMinor: "1",
          },
        ],
      },
    });
    return app.inject({
      method: "POST",
      url: `/api/inventory/receipts/${created.json().data.id}/receive`,
      headers: headers(managerId, `${keyPrefix}-receive-0002`),
    });
  }
});

function headers(employeeId: string, idempotencyKey: string) {
  return { "x-employee-id": employeeId, "idempotency-key": idempotencyKey };
}

async function seed(pool: Pool) {
  await pool.query(
    `INSERT INTO mbox.tenants(id, code, name) VALUES ($1, $2, 'Inventory Test')`,
    [tenantId, `inv-${tenantId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES ($1, $2, 'store', 'Inventory Store')`,
    [storeId, tenantId],
  );
  await pool.query(
    `INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type) VALUES ($1, $2, $3, 'A', 'A区', 'indoor')`,
    [areaId, tenantId, storeId],
  );
  await pool.query(
    `
    INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
    VALUES ($1, $3, $4, $5, 'L01', 'L01', 6), ($2, $3, $4, $5, 'L02', 'L02', 6)
  `,
    [tableOneId, tableTwoId, tenantId, storeId, areaId],
  );
  await pool.query(
    `
    INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
    VALUES ($1, $4, $5, 'manager', 'Manager'), ($2, $4, $5, 'viewer', 'Viewer'), ($3, $4, $5, 'approver', 'Approver')
  `,
    [managerId, viewerId, approverId, tenantId, storeId],
  );
  await pool.query(
    `
    INSERT INTO mbox.roles(id, tenant_id, store_id, code, name)
    VALUES ($1, $4, $5, 'INV_MANAGER', 'Inventory Manager'),
      ($2, $4, $5, 'INV_VIEWER', 'Inventory Viewer'),
      ($3, $4, $5, 'INV_APPROVER', 'Inventory Approver')
  `,
    [managerRoleId, viewerRoleId, approverRoleId, tenantId, storeId],
  );
  await pool.query(
    `
    INSERT INTO mbox.employee_roles(tenant_id, store_id, employee_id, role_id)
    VALUES ($1, $2, $3, $6), ($1, $2, $4, $7), ($1, $2, $5, $8)
  `,
    [
      tenantId,
      storeId,
      managerId,
      viewerId,
      approverId,
      managerRoleId,
      viewerRoleId,
      approverRoleId,
    ],
  );

  const permissions = [
    "inventory.view",
    "inventory.cost.view",
    "inventory.cost.correct",
    "inventory.manage",
    "inventory.receive",
    "inventory.count",
    "inventory.count.approve",
    "inventory.waste",
    "bottle.view",
    "bottle.manage",
    "bottle.manage.all",
    "catalog.product.manage",
  ];
  for (const code of permissions) {
    await pool.query(
      `
      INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name, category)
      VALUES ($1, $2, $3, $3, 'inventory')
      ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET status='active'
    `,
      [tenantId, storeId, code],
    );
  }
  await grant(
    pool,
    managerRoleId,
    permissions.filter((permission) => permission !== "bottle.manage.all"),
  );
  await grant(pool, viewerRoleId, ["inventory.view", "bottle.view"]);
  await grant(pool, approverRoleId, [
    "inventory.view",
    "inventory.count.approve",
    "bottle.manage",
  ]);

  await pool.query(
    `
    INSERT INTO mbox.table_sessions(id, tenant_id, store_id, table_id, public_id, business_date, guest_count, capacity_at_open)
    VALUES ($1, $3, $4, $5, 'table-session-one', '2026-08-11', 2, 6),
      ($2, $3, $4, $6, 'table-session-two', '2026-08-11', 2, 6)
  `,
    [
      tableOneSessionId,
      tableTwoSessionId,
      tenantId,
      storeId,
      tableOneId,
      tableTwoId,
    ],
  );
  await pool.query(
    `
    INSERT INTO mbox.table_assignments(tenant_id, store_id, table_id, employee_id, role_id, reason)
    VALUES ($1, $2, $3, $4, $5, '库存瓶存责任测试')
  `,
    [tenantId, storeId, tableOneId, managerId, managerRoleId],
  );
  await pool.query(
    `
    INSERT INTO mbox.products(id, tenant_id, store_id, code, name, category_code, fulfillment_station)
    VALUES ($1, $2, $3, 'COCKTAIL-TEST', '测试鸡尾酒', 'cocktail', 'bar')
  `,
    [productId, tenantId, storeId],
  );
}

async function grant(
  pool: Pool,
  roleId: string,
  permissions: readonly string[],
) {
  await pool.query(
    `
    INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
    SELECT $1, $2, $3, id FROM mbox.staff_permission_definitions
    WHERE tenant_id = $1 AND store_id = $2 AND code = ANY($4::text[])
  `,
    [tenantId, storeId, roleId, permissions],
  );
}
