import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runNormalizedMigrations } from "../migrate-normalized.js";
import {
  CATALOG_PRICE_MANAGE_PERMISSION,
  CATALOG_PRODUCT_MANAGE_PERMISSION,
  catalogApiPlugin,
  type CatalogApiOptions,
} from "./catalog-api.js";
import type {
  CommandOutcome,
  IdempotentCommand,
  NormalizedCommandExecutor,
} from "./command-executor.js";
import { NormalizedCommandExecutor as CommandExecutor } from "./command-executor.js";
import type { NormalizedOperationsRequestContext } from "./normalized-operations-api.js";
import type {
  PostgresPool,
  PostgresQueryResult,
  ScopedTransaction,
  StoreScope,
  TransactionOptions,
} from "./transaction-runner.js";
import { ScopedPostgresTransactionRunner } from "./transaction-runner.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const storeId = "22222222-2222-4222-8222-222222222222";
const employeeId = "33333333-3333-4333-8333-333333333333";
const productId = "44444444-4444-4444-8444-444444444444";
const priceId = "55555555-5555-4555-8555-555555555555";
const integrationRoleId = "66666666-6666-4666-8666-666666666666";
const scope: StoreScope = { tenantId, storeId };
const businessDate = "2026-08-11";
const integrationRunToken = randomUUID().replaceAll("-", "").slice(0, 12);
const integrationProductCode = `CATALOG-REAL-${integrationRunToken}`;

function integrationKey(purpose: string): string {
  return `catalog:${purpose}:${integrationRunToken}`;
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("normalized catalog PostgreSQL integration", () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    await seedIdentity(pool);
    app = await createPostgresApp(pool);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("replays writes idempotently and commits audit and outbox evidence exactly once", async () => {
    await setPermission(pool, CATALOG_PRODUCT_MANAGE_PERMISSION, true);
    await setPermission(pool, CATALOG_PRICE_MANAGE_PERMISSION, true);

    const createRequest = {
      method: "POST" as const,
      url: "/api/catalog/products",
      headers: { "idempotency-key": integrationKey("create") },
      payload: {
        code: integrationProductCode,
        name: "真实数据库鸡尾酒",
        categoryCode: "cocktail",
        fulfillmentStation: "bar",
        productSnapshot: {
          aliases: ["青柠特调", "清爽特调"],
          specification: "330ml",
          pinyin: `qingning tediao ${integrationRunToken}`,
        },
      },
    };
    const created = await app.inject(createRequest);
    const replayedCreate = await app.inject(createRequest);

    expect(created.statusCode).toBe(201);
    expect(replayedCreate.statusCode).toBe(200);
    expect(replayedCreate.json().meta.replayed).toBe(true);
    const createdId = created.json().data.id as string;
    const createdUpdatedAt = created.json().data.updatedAt as string;
    expect(replayedCreate.json().data.id).toBe(createdId);
    await pool.query("SELECT pg_sleep(0.01)");

    const priceRequest = {
      method: "PUT" as const,
      url: `/api/catalog/products/${createdId}/standard-price`,
      headers: { "idempotency-key": integrationKey("price") },
      payload: {
        amountMinor: 12800,
        currency: "CNY",
        reason: "八月菜单正式定价",
      },
    };
    const priced = await app.inject(priceRequest);
    const replayedPrice = await app.inject(priceRequest);

    expect(priced.statusCode).toBe(200);
    expect(priced.json().data.standardPrice.amountMinor).toBe("12800");
    expect(Date.parse(priced.json().data.updatedAt)).toBeGreaterThan(
      Date.parse(createdUpdatedAt),
    );
    expect(replayedPrice.statusCode).toBe(200);
    expect(replayedPrice.json().meta.replayed).toBe(true);

    const evidence = await pool.query<{
      price_count: string;
      audit_count: string;
      outbox_count: string;
      price_reason: string;
    }>(
      `
      SELECT
        (SELECT count(*)::text FROM mbox.product_prices
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND product_id = $3::uuid) AS price_count,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND object_id = $3::text) AS audit_count,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND aggregate_id = $3::uuid) AS outbox_count,
        (SELECT reason FROM mbox.audit_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND object_id = $3::text
            AND action = 'catalog.standard_price.changed') AS price_reason
    `,
      [tenantId, storeId, createdId],
    );
    expect(evidence.rows[0]).toEqual({
      price_count: "1",
      audit_count: "2",
      outbox_count: "2",
      price_reason: "八月菜单正式定价",
    });

    const conflictingReplay = await app.inject({
      ...priceRequest,
      payload: { ...priceRequest.payload, amountMinor: 13800 },
    });
    expect(conflictingReplay.statusCode).toBe(409);
    expect(conflictingReplay.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("supports guest alias, specification and pinyin search without an employee identity", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/guest/catalog/products?search=${integrationRunToken}&category=cocktail`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        code: integrationProductCode,
        isAvailable: true,
      }),
    ]);
    const hiddenCode = `HIDDEN-${integrationRunToken}`;
    await pool.query(`WITH product AS (
      INSERT INTO mbox.products(tenant_id, store_id, code, name, category_code, fulfillment_station,
        product_snapshot, guest_visible, search_text)
      VALUES ($1,$2,$3,'内部组成商品','cocktail','bar','{"aliases":["内部隐藏"]}'::jsonb,
        false,$3 || ' 内部组成商品 内部隐藏')
      RETURNING id
    ) INSERT INTO mbox.product_prices(tenant_id, store_id, product_id, amount_minor, currency, valid_from)
      SELECT $1,$2,id,100,'CNY',clock_timestamp() FROM product`, [tenantId, storeId, hiddenCode]);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/guest/catalog/products?search=${hiddenCode}`,
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().data).toEqual([]);

    const forbiddenStatus = await app.inject({
      method: "GET",
      url: "/api/guest/catalog/products?status=inactive",
    });
    expect(forbiddenStatus.statusCode).toBe(400);
  });

  it("configures a structured bundle and returns its public components without double pricing", async () => {
    await setPermission(pool, CATALOG_PRODUCT_MANAGE_PERMISSION, true);
    await setPermission(pool, CATALOG_PRICE_MANAGE_PERMISSION, true);
    const component = await pool.query<{ id: string }>(`
      SELECT id FROM mbox.products
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND code = $3
    `, [tenantId, storeId, integrationProductCode]);
    const componentId = component.rows[0]!.id;
    const bundleCode = `BUNDLE-${integrationRunToken}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: { "idempotency-key": integrationKey("bundle-create") },
      payload: {
        code: bundleCode,
        name: "今夜双人精选",
        categoryCode: "combo",
        fulfillmentStation: "none",
        productKind: "bundle",
        bundleComponents: [{ productId: componentId, quantity: 2 }],
        productSnapshot: { description: "两杯今晚精选" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      code: bundleCode,
      productKind: "bundle",
      bundleComponents: [{ productId: componentId, quantity: 2 }],
    });
    const bundleId = created.json().data.id as string;
    const priced = await app.inject({
      method: "PUT",
      url: `/api/catalog/products/${bundleId}/standard-price`,
      headers: { "idempotency-key": integrationKey("bundle-price") },
      payload: { amountMinor: 22800, currency: "CNY", reason: "组合试销价" },
    });
    expect(priced.statusCode).toBe(200);
    const guest = await app.inject({
      method: "GET",
      url: `/api/guest/catalog/products?search=${bundleCode}`,
    });
    expect(guest.statusCode).toBe(200);
    expect(guest.json().data).toEqual([
      expect.objectContaining({
        productKind: "bundle",
        isAvailable: true,
        standardPrice: expect.objectContaining({ amountMinor: "22800" }),
        bundleComponents: [expect.objectContaining({ productId: componentId, quantity: 2 })],
      }),
    ]);
  });

  it("prevents overlapping open-ended price ranges at the database boundary", async () => {
    const product = await pool.query<{ id: string }>(
      `
      SELECT id FROM mbox.products
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND code = $3
    `,
      [tenantId, storeId, integrationProductCode],
    );
    const targetId = product.rows[0]!.id;

    await expect(
      pool.query(
        `
      INSERT INTO mbox.product_prices (
        tenant_id, store_id, product_id, price_type, amount_minor, currency, valid_from, valid_until
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'standard', 11800, 'CNY',
        clock_timestamp() - interval '1 hour', NULL
      )
    `,
        [tenantId, storeId, targetId],
      ),
    ).rejects.toMatchObject({ code: "23P01" });

    await expect(
      pool.query(
        `
      INSERT INTO mbox.product_prices (
        tenant_id, store_id, product_id, price_type, amount_minor, currency, valid_from, valid_until
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'standard', 1800, 'USD',
        clock_timestamp() - interval '1 hour', NULL
      )
    `,
        [tenantId, storeId, targetId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("updates updated_at and enforces product and price permissions independently", async () => {
    const product = await pool.query<{ id: string; updated_at: string }>(
      `
      SELECT id, updated_at::text FROM mbox.products
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND code = $3
    `,
      [tenantId, storeId, integrationProductCode],
    );
    const targetId = product.rows[0]!.id;
    const originalUpdatedAt = product.rows[0]!.updated_at;
    await pool.query("SELECT pg_sleep(0.01)");

    await setPermission(pool, CATALOG_PRODUCT_MANAGE_PERMISSION, true);
    await setPermission(pool, CATALOG_PRICE_MANAGE_PERMISSION, false);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/catalog/products/${targetId}`,
      headers: { "idempotency-key": integrationKey("patch") },
      payload: { name: "真实数据库青柠鸡尾酒" },
    });
    expect(patched.statusCode).toBe(200);
    expect(Date.parse(patched.json().data.updatedAt)).toBeGreaterThan(
      Date.parse(originalUpdatedAt),
    );

    const deniedPrice = await app.inject({
      method: "PUT",
      url: `/api/catalog/products/${targetId}/standard-price`,
      headers: { "idempotency-key": integrationKey("price-denied") },
      payload: {
        amountMinor: 13800,
        currency: "CNY",
        reason: "无权限调价测试",
      },
    });
    expect(deniedPrice.statusCode).toBe(403);

    await setPermission(pool, CATALOG_PRODUCT_MANAGE_PERMISSION, false);
    await setPermission(pool, CATALOG_PRICE_MANAGE_PERMISSION, true);
    const deniedProduct = await app.inject({
      method: "PATCH",
      url: `/api/catalog/products/${targetId}`,
      headers: { "idempotency-key": integrationKey("patch-denied") },
      payload: { status: "sold_out" },
    });
    expect(deniedProduct.statusCode).toBe(403);
  });
});

describe("normalized catalog HTTP API", () => {
  it("uses a separately injected guest context and the normalized search field for customer search", async () => {
    const fixture = await createFixture({
      failStaffContext: true,
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: "/api/guest/catalog/products?search=%E6%B8%85%E7%88%BD&category=wine&limit=20&offset=5",
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.guestContextCalls).toBe(1);
    expect(fixture.staffContextCalls).toBe(0);
    const query = fixture.calls.find((call) =>
      call.sql.includes("FROM mbox.products AS product"),
    );
    expect(query?.sql).toContain("product.search_text");
    expect(query?.sql).not.toContain("product_snapshot ->");
    expect(query?.values).toEqual([
      tenantId,
      storeId,
      "清爽",
      "wine",
      "active",
      20,
      5,
      true,
    ]);
    expect(response.json().data[0].productSnapshot.costAmount).toBeUndefined();
  });

  it("requires an idempotency key and emits audit and outbox data from the command outcome", async () => {
    const fixture = await createFixture();
    const missingKey = await fixture.app.inject({
      method: "POST",
      url: "/api/catalog/products",
      payload: createPayload(),
    });
    expect(missingKey.statusCode).toBe(400);
    expect(fixture.commandCalls).toHaveLength(0);

    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: { "idempotency-key": "catalog-create-unit-001" },
      payload: createPayload(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().meta.replayed).toBe(false);
    expect(fixture.commandCalls[0]).toMatchObject({
      operationScope: "catalog.product.create",
      idempotencyKey: "catalog-create-unit-001",
    });
    expect(fixture.commandCalls[0]?.requestFingerprint).toContain(
      "COCKTAIL-01",
    );
    expect(fixture.outcomes[0]?.auditEvents).toEqual([
      expect.objectContaining({
        action: "catalog.product.created",
        objectType: "product",
        objectId: productId,
      }),
    ]);
    expect(fixture.outcomes[0]?.outboxMessages).toEqual([
      expect.objectContaining({
        aggregateType: "product",
        aggregateId: productId,
        eventType: "catalog.product.created.v1",
      }),
    ]);
  });

  it("checks separate live permissions and requires a nonempty price-change reason", async () => {
    const productOnly = await createFixture({
      grantedPermissions: [CATALOG_PRODUCT_MANAGE_PERMISSION],
    });
    const productWrite = await productOnly.app.inject({
      method: "PATCH",
      url: `/api/catalog/products/${productId}`,
      headers: { "idempotency-key": "catalog-patch-unit-001" },
      payload: { status: "sold_out" },
    });
    expect(productWrite.statusCode).toBe(200);

    const deniedPrice = await productOnly.app.inject({
      method: "PUT",
      url: `/api/catalog/products/${productId}/standard-price`,
      headers: { "idempotency-key": "catalog-price-unit-001" },
      payload: { amountMinor: 9800, currency: "CNY", reason: "更新菜单价格" },
    });
    expect(deniedPrice.statusCode).toBe(403);

    const priceOnly = await createFixture({
      grantedPermissions: [CATALOG_PRICE_MANAGE_PERMISSION],
    });
    const missingReason = await priceOnly.app.inject({
      method: "PUT",
      url: `/api/catalog/products/${productId}/standard-price`,
      headers: { "idempotency-key": "catalog-price-unit-002" },
      payload: { amountMinor: 9800, currency: "CNY" },
    });
    expect(missingReason.statusCode).toBe(400);

    const deniedProduct = await priceOnly.app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: { "idempotency-key": "catalog-create-unit-002" },
      payload: createPayload(),
    });
    expect(deniedProduct.statusCode).toBe(403);
  });

  it("configures price commands for serializable conflict retry and maps exhausted conflicts to 409", async () => {
    const exhausted = await createFixture({ serializationFailures: 1 });
    const conflict = await exhausted.app.inject({
      method: "PUT",
      url: `/api/catalog/products/${productId}/standard-price`,
      headers: { "idempotency-key": "catalog-retry-unit-002" },
      payload: { amountMinor: 9800, currency: "CNY", reason: "并发更新测试" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(exhausted.commandAttempts).toBe(1);
    expect(exhausted.priceTransactionOptions).toEqual([
      { isolation: "serializable", retryOnConflict: 3 },
    ]);
    expect(conflict.json()).toEqual({
      error: {
        code: "CATALOG_RETRY_REQUIRED",
        message: "商品资料正在被其他人修改，请刷新后重试",
      },
    });
  });

  it("returns a required reason in the price audit and keeps product locking", async () => {
    const fixture = await createFixture({
      grantedPermissions: [CATALOG_PRICE_MANAGE_PERMISSION],
    });
    const response = await fixture.app.inject({
      method: "PUT",
      url: `/api/catalog/products/${productId}/standard-price`,
      headers: { "idempotency-key": "catalog-price-unit-003" },
      payload: {
        amountMinor: 9800,
        currency: "CNY",
        reason: "供应成本发生变化",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(fixture.calls.some((call) => call.sql.includes("FOR UPDATE"))).toBe(
      true,
    );
    expect(fixture.outcomes[0]?.auditEvents[0]).toMatchObject({
      action: "catalog.standard_price.changed",
      reason: "供应成本发生变化",
    });
    expect(fixture.commandCalls[0]?.requestFingerprint).toContain(
      "供应成本发生变化",
    );
  });
});

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

interface FixtureOptions {
  grantedPermissions?: readonly string[];
  categoryRows?: Array<Record<string, unknown>>;
  serializationFailures?: number;
  failStaffContext?: boolean;
}

async function createFixture(options: FixtureOptions = {}) {
  const calls: QueryCall[] = [];
  const runs: TransactionOptions[] = [];
  const commandCalls: Array<Readonly<IdempotentCommand<unknown>>> = [];
  const outcomes: Array<CommandOutcome<unknown>> = [];
  let commandAttempts = 0;
  let remainingSerializationFailures = options.serializationFailures ?? 0;
  let staffContextCalls = 0;
  let guestContextCalls = 0;
  const priceTransactionOptions: TransactionOptions[] = [];
  const transaction: ScopedTransaction = {
    scope,
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return fakeQuery(sql, options);
    }),
  };
  const transactions = {
    run: vi.fn(
      async <Result>(
        runScope: Readonly<StoreScope>,
        operation: (value: ScopedTransaction) => Promise<Result>,
        transactionOptions: Readonly<TransactionOptions> = {},
      ) => {
        expect(runScope).toEqual(scope);
        runs.push({ ...transactionOptions });
        return operation(transaction);
      },
    ),
  };
  const execute: NormalizedCommandExecutor["execute"] = async <Result>(
    command: Readonly<IdempotentCommand<Result>>,
    handler: (value: ScopedTransaction) => Promise<CommandOutcome<Result>>,
  ) => {
    commandAttempts += 1;
    commandCalls.push(command as Readonly<IdempotentCommand<unknown>>);
    if (remainingSerializationFailures > 0) {
      remainingSerializationFailures -= 1;
      throw Object.assign(new Error("serialization failure"), {
        code: "40001",
      });
    }
    const outcome = await handler(transaction);
    outcomes.push(outcome as CommandOutcome<unknown>);
    return { value: outcome.result, replayed: false };
  };
  const context: NormalizedOperationsRequestContext = {
    scope,
    employeeId,
    businessDate,
    capabilities: [],
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  const pluginOptions: CatalogApiOptions = {
    transactions,
    commandExecutor: { execute },
    resolveContext: () => {
      staffContextCalls += 1;
      if (options.failStaffContext)
        throw new Error("staff context must not be used");
      return context;
    },
    resolveGuestContext: () => {
      guestContextCalls += 1;
      return { scope };
    },
    createCommandExecutor: (_transactions, transactionOptions) => {
      priceTransactionOptions.push({ ...transactionOptions });
      return { execute };
    },
  };
  app.register(catalogApiPlugin, { ...pluginOptions, prefix: "/api" });
  await app.ready();
  return {
    app,
    calls,
    runs,
    commandCalls,
    outcomes,
    priceTransactionOptions,
    get commandAttempts() {
      return commandAttempts;
    },
    get staffContextCalls() {
      return staffContextCalls;
    },
    get guestContextCalls() {
      return guestContextCalls;
    },
  };
}

function fakeQuery(
  sql: string,
  options: FixtureOptions,
): PostgresQueryResult<Record<string, unknown>> {
  if (sql.includes("FROM mbox.employees")) {
    return result([
      {
        id: employeeId,
        employee_code: "LIYAN",
        display_name: "李艳",
        status: "active",
      },
    ]);
  }
  if (
    sql.includes("SELECT r.code, r.name") &&
    sql.includes("FROM mbox.employee_roles")
  )
    return result([]);
  if (sql.includes("permission_facts")) {
    const granted = options.grantedPermissions ?? [
      CATALOG_PRODUCT_MANAGE_PERMISSION,
      CATALOG_PRICE_MANAGE_PERMISSION,
    ];
    return result(
      granted.map((code) => ({
        code,
        role_granted: true,
        override_granted: false,
        override_denied: false,
      })),
    );
  }
  if (sql.includes("FROM mbox.role_data_scopes")) return result([]);
  if (sql.includes("FROM mbox.role_approval_limits")) return result([]);
  if (sql.includes("FROM mbox.role_navigation_items")) return result([]);
  if (sql.includes("GROUP BY product.category_code"))
    return result(options.categoryRows ?? []);
  if (sql.includes("SELECT clock_timestamp()::text AS effective_at")) {
    return result([{ effective_at: "2026-08-11T12:00:00.000Z" }]);
  }
  if (
    sql.includes("FROM mbox.product_prices") &&
    sql.includes("valid_from >=") &&
    sql.includes("FOR UPDATE")
  ) {
    return result([]);
  }
  if (sql.includes("FROM mbox.products") && sql.includes("FOR UPDATE"))
    return result([{ id: productId }]);
  if (
    sql.includes("UPDATE mbox.product_prices") ||
    sql.includes("INSERT INTO mbox.product_prices")
  ) {
    return result([]);
  }
  if (sql.includes("INSERT INTO mbox.products"))
    return result([productRow(false)]);
  if (sql.includes("UPDATE mbox.products")) return result([{ id: productId }]);
  if (sql.includes("FROM mbox.products AS product"))
    return result([productRow(true)]);
  return result([]);
}

function createPayload() {
  return {
    code: "COCKTAIL-01",
    name: "招牌鸡尾酒",
    categoryCode: "wine",
    fulfillmentStation: "bar",
    productSnapshot: {
      aliases: ["清爽特调"],
      specification: "330ml",
      pinyin: "qingshuang",
    },
  };
}

function productRow(withPrice: boolean): Record<string, unknown> {
  return {
    id: productId,
    code: "COCKTAIL-01",
    name: "招牌鸡尾酒",
    category_code: "wine",
    fulfillment_station: "bar",
    product_snapshot: {
      aliases: ["清爽特调"],
      specification: "330ml",
      pinyin: "qingshuang",
    },
    guest_visible: true,
    search_text: "COCKTAIL-01 招牌鸡尾酒 清爽特调 qingshuang 330ml",
    recommendation_enabled: false,
    recommendation_min_guests: 1,
    recommendation_max_guests: 100,
    recommendation_priority: 100,
    recommendation_scene_tags: [],
    recommendation_intent_tags: [],
    recommendation_taste_tags: [],
    recommendation_dwell_tags: [],
    recommendation_single_wave_eligible: true,
    recommendation_expected_prep_minutes: 8,
    recommendation_hold_minutes: 10,
    recommendation_upgrade_product_id: null,
    menu_sort_order: 999,
    available_from: null,
    available_until: null,
    allowed_channels: ['guest_qr', 'staff_assisted', 'cashier', 'reservation', 'integration'],
    max_order_quantity: 50,
    kds_priority: 100,
    fulfillment_sla_seconds: null,
    cost_amount_minor: "1050",
    status: "active",
    standard_price_id: withPrice ? priceId : null,
    amount_minor: withPrice ? "8800" : null,
    currency: withPrice ? "CNY" : null,
    price_valid_from: withPrice ? "2026-08-11T10:00:00.000Z" : null,
    price_valid_until: null,
    created_at: "2026-08-11T09:00:00.000Z",
    updated_at: "2026-08-11T09:00:00.000Z",
  };
}

function result(
  rows: Array<Record<string, unknown>>,
): PostgresQueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length };
}

async function seedIdentity(pool: Pool): Promise<void> {
  await pool.query(
    `
    INSERT INTO mbox.tenants(id, code, name)
    VALUES ($1::uuid, 'catalog-api-tenant', 'Catalog API Tenant')
    ON CONFLICT (id) DO NOTHING
  `,
    [tenantId],
  );
  await pool.query(
    `
    INSERT INTO mbox.stores(id, tenant_id, code, name)
    VALUES ($1::uuid, $2::uuid, 'catalog-api-store', 'Catalog API Store')
    ON CONFLICT (id) DO NOTHING
  `,
    [storeId, tenantId],
  );
  await pool.query(
    `
    INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'catalog-manager', 'Catalog Manager')
    ON CONFLICT (id) DO UPDATE SET status = 'active'
  `,
    [employeeId, tenantId, storeId],
  );
  await pool.query(
    `
    INSERT INTO mbox.roles(id, tenant_id, store_id, code, name)
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'CATALOG_MANAGER', 'Catalog Manager')
    ON CONFLICT (id) DO UPDATE SET status = 'active'
  `,
    [integrationRoleId, tenantId, storeId],
  );
  await pool.query(
    `
    INSERT INTO mbox.employee_roles(tenant_id, store_id, employee_id, role_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
    ON CONFLICT (tenant_id, store_id, employee_id, role_id, ends_at) DO NOTHING
  `,
    [tenantId, storeId, employeeId, integrationRoleId],
  );
}

async function createPostgresApp(pool: Pool): Promise<FastifyInstance> {
  const postgresPool: PostgresPool = {
    connect: async () => pool.connect(),
    end: async () => pool.end(),
  };
  const transactions = new ScopedPostgresTransactionRunner(postgresPool);
  const app = Fastify({ logger: false });
  app.register(catalogApiPlugin, {
    prefix: "/api",
    transactions,
    commandExecutor: new CommandExecutor(transactions),
    resolveContext: () => ({
      scope,
      employeeId,
      businessDate,
      capabilities: [],
    }),
    resolveGuestContext: () => ({ scope }),
  });
  await app.ready();
  return app;
}

async function setPermission(
  pool: Pool,
  code: string,
  enabled: boolean,
): Promise<void> {
  const permission = await pool.query<{ id: string }>(
    `
    INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name)
    VALUES ($1::uuid, $2::uuid, $3, $3)
    ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET status = 'active'
    RETURNING id
  `,
    [tenantId, storeId, code],
  );
  if (enabled) {
    await pool.query(
      `
      INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
      ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING
    `,
      [tenantId, storeId, integrationRoleId, permission.rows[0]!.id],
    );
  } else {
    await pool.query(
      `
      DELETE FROM mbox.role_permission_assignments
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND role_id = $3::uuid AND permission_id = $4::uuid
    `,
      [tenantId, storeId, integrationRoleId, permission.rows[0]!.id],
    );
  }
}
