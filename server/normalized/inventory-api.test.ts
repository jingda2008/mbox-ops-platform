import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runNormalizedMigrations } from "../migrate-normalized.js";
import { NormalizedCommandExecutor } from "./command-executor.js";
import { inventoryApiPlugin } from "./inventory-api.js";
import { InventoryQueryService } from "./inventory-query-service.js";
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
  });

  it("receives a purchase batch once, keeps decimal cost, and redacts supplier data without cost permission", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/inventory/receipts",
      headers: headers(managerId, "receipt-create-0001"),
      payload: {
        supplierRef: "SUP-SECRET",
        supplierSnapshot: { name: "敏感供应商", phone: "13800000000" },
        invoiceTotalMinor: "10000",
        lines: [
          {
            scanCode: "690000000001",
            batchCode: "BATCH-A",
            quantity: "10",
            unitCostMinor: "12.345678",
            totalCostMinor: "10000",
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
    expect(managerView.statusCode).toBe(200);
    expect(managerView.json().data.receipts[0].supplier.name).toBe(
      "敏感供应商",
    );
    expect(
      managerView
        .json()
        .data.items.find((item: { id: string }) => item.id === spiritItemId)
        .latestUnitCostMinor,
    ).toBe("12.345678");
    expect(viewerView.statusCode).toBe(200);
    expect(viewerView.json().data.receipts[0]).not.toHaveProperty("supplier");
    expect(viewerView.json().data.receipts[0]).not.toHaveProperty(
      "supplierRef",
    );
    expect(
      viewerView
        .json()
        .data.items.find((item: { id: string }) => item.id === spiritItemId),
    ).not.toHaveProperty("latestUnitCostMinor");
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

  it("serializes competing deductions so stock cannot be overdrawn or rolled back by a stale click", async () => {
    const requests = [
      "waste-concurrent-one-0001",
      "waste-concurrent-two-0002",
    ].map((key) =>
      app.inject({
        method: "POST",
        url: `/api/inventory/items/${spiritItemId}/waste`,
        headers: headers(managerId, key),
        payload: { quantity: "7", reason: "并发扣减验证" },
      }),
    );
    const responses = await Promise.all(requests);
    expect(responses.map((item) => item.statusCode).toSorted()).toEqual([
      200, 409,
    ]);
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
    expect(balance.rows[0]).toEqual({ on_hand: "3.000000", waste_count: "1" });
    const movement = await pool.query<{ id: string }>(
      `
      SELECT id FROM mbox.inventory_movements
      WHERE tenant_id = $1 AND store_id = $2 AND inventory_item_id = $3
      ORDER BY occurred_at DESC LIMIT 1
    `,
      [tenantId, storeId, spiritItemId],
    );
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
            unitCostMinor: "1",
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

  async function createItem(
    sku: string,
    name: string,
    wholeUnitCount: boolean,
    key: string,
  ) {
    const result = await app.inject({
      method: "POST",
      url: "/api/inventory/items",
      headers: headers(managerId, key),
      payload: {
        sku,
        name,
        itemType: "food",
        baseUnit: "piece",
        categoryCode: "snack",
        wholeUnitCount,
        reasonableWasteQuantity: "1",
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
            unitCostMinor: "1",
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
    "inventory.manage",
    "inventory.receive",
    "inventory.count",
    "inventory.count.approve",
    "inventory.waste",
    "bottle.view",
    "bottle.manage",
    "bottle.manage.all",
  ];
  for (const code of permissions) {
    await pool.query(
      `
      INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name, category)
      VALUES ($1, $2, $3, $3, 'inventory')
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
