import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type {
  CommandExecution,
  CommandOutcome,
  IdempotentCommand,
  JsonCodec,
  JsonObject,
  JsonValue,
} from "./command-executor.js";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  NormalizedCommandExecutor,
  OutboxMessageConflictError,
} from "./command-executor.js";
import type { NormalizedOperationsRequestContext } from "./normalized-operations-api.js";
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from "./normalized-request-context.js";
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
  StaffNotFoundError,
} from "./staff-access-repository.js";
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
  TransactionOptions,
} from "./transaction-runner.js";
import {
  extractProductOperationalFields,
  type ProductOperationalFields,
} from "./product-operational-fields.js";
import { isPublicMiniProgramImageUrl } from './media-asset-url.js';

export const CATALOG_PRODUCT_MANAGE_PERMISSION = "catalog.product.manage";
export const CATALOG_PRICE_MANAGE_PERMISSION = "catalog.price.manage";
export const INVENTORY_COST_VIEW_PERMISSION = "inventory.cost.view";

type TransactionRunnerPort = Pick<ScopedPostgresTransactionRunner, "run">;
type CommandExecutorPort = Pick<NormalizedCommandExecutor, "execute">;

export interface GuestCatalogReadContext {
  scope: Readonly<StoreScope>;
}

export interface CatalogApiOptions {
  transactions: TransactionRunnerPort;
  commandExecutor: CommandExecutorPort;
  resolveContext(
    request: FastifyRequest,
  ):
    | Promise<NormalizedOperationsRequestContext>
    | NormalizedOperationsRequestContext;
  resolveGuestContext(
    request: FastifyRequest,
  ): Promise<GuestCatalogReadContext> | GuestCatalogReadContext;
  createCommandExecutor?(
    transactions: TransactionRunnerPort,
    transactionOptions: Readonly<TransactionOptions>,
  ): CommandExecutorPort;
}

type ProductStatus = "active" | "sold_out" | "inactive";
type FulfillmentStation = "bar" | "kitchen" | "cashier" | "none";
type ProductKind = "single" | "bundle";
type InventoryControlMode = "tracked" | "not_managed";

interface BundleComponent {
  productId: string;
  code: string;
  name: string;
  quantity: number;
  sortOrder: number;
  note: string | null;
}

interface BundleComponentInput extends JsonObject {
  productId: string;
  quantity: number;
  sortOrder: number;
  note: string | null;
}

interface ProductRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  category_code: string;
  fulfillment_station: FulfillmentStation;
  product_kind: ProductKind;
  inventory_control_mode: InventoryControlMode;
  bundle_components: JsonValue;
  bundle_components_available: boolean;
  inventory_configuration_complete: boolean;
  inventory_available: boolean;
  product_snapshot: JsonObject;
  guest_visible: boolean;
  search_text: string;
  recommendation_enabled: boolean;
  recommendation_min_guests: number;
  recommendation_max_guests: number;
  recommendation_priority: number;
  recommendation_scene_tags: string[];
  recommendation_intent_tags: string[];
  recommendation_taste_tags: string[];
  recommendation_dwell_tags: string[];
  recommendation_single_wave_eligible: boolean;
  recommendation_expected_prep_minutes: number;
  recommendation_hold_minutes: number;
  recommendation_upgrade_product_id: string | null;
  menu_sort_order: number;
  available_from: string | null;
  available_until: string | null;
  allowed_channels: string[];
  max_order_quantity: number;
  kds_priority: number;
  fulfillment_sla_seconds: number | null;
  cost_amount_minor: string | null;
  status: ProductStatus;
  standard_price_id: string | null;
  amount_minor: string | null;
  currency: string | null;
  price_valid_from: string | null;
  price_valid_until: string | null;
  created_at: string;
  updated_at: string;
}

interface CatalogProduct {
  id: string;
  code: string;
  name: string;
  categoryCode: string;
  fulfillmentStation: FulfillmentStation;
  productKind: ProductKind;
  inventoryControlMode: InventoryControlMode;
  bundleComponents: BundleComponent[];
  productSnapshot: JsonObject;
  guestVisible: boolean;
  searchText: string;
  recommendationEnabled: boolean;
  recommendationMinGuests: number;
  recommendationMaxGuests: number;
  recommendationPriority: number;
  recommendationSceneTags: string[];
  recommendationIntentTags: string[];
  recommendationTasteTags: string[];
  recommendationDwellTags: string[];
  recommendationSingleWaveEligible: boolean;
  recommendationExpectedPrepMinutes: number;
  recommendationHoldMinutes: number;
  recommendationUpgradeProductId: string | null;
  menuSortOrder: number;
  availableFrom: string | null;
  availableUntil: string | null;
  allowedChannels: string[];
  maxOrderQuantity: number;
  kdsPriority: number;
  fulfillmentSlaSeconds: number | null;
  costAmountMinor?: number | null;
  status: ProductStatus;
  isAvailable: boolean;
  inventoryConfigurationComplete: boolean;
  inventoryAvailable: boolean;
  standardPrice: {
    id: string;
    amountMinor: string | null;
    currency: string | null;
    validFrom: string | null;
    validUntil: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface CategoryRow extends Record<string, unknown> {
  category_code: string;
  product_count: string;
  available_count: string;
}

interface TimestampRow extends Record<string, unknown> {
  effective_at: string;
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

interface ProductListQuery {
  search: string;
  categoryCode: string | null;
  status: ProductStatus | "all";
  guest: boolean;
  limit: number;
  offset: number;
}

interface StandardPriceInput {
  amountMinor: number;
  currency: string;
  reason: string;
}

interface ApiErrorBody {
  error: { code: string; message: string };
}

class CatalogRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogRequestError";
  }
}

class CatalogProductNotFoundError extends Error {
  constructor() {
    super("商品不存在或不属于当前门店");
    this.name = "CatalogProductNotFoundError";
  }
}

class CatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogConflictError";
  }
}

export const catalogApiPlugin: FastifyPluginAsync<CatalogApiOptions> = async (
  app,
  options,
) => {
  const priceCommandExecutor = (
    options.createCommandExecutor ?? createConfiguredCommandExecutor
  )(options.transactions, { isolation: "serializable", retryOnConflict: 3 });

  app.get("/catalog/products", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await resolveStaffContext(options, request);
      const query = readProductListQuery(request.query, false);
      return sendProductList(
        reply,
        options.transactions,
        context.scope,
        query,
        context.employeeId,
      );
    }),
  );

  app.get("/catalog/categories", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await resolveStaffContext(options, request);
      return sendCategoryList(reply, options.transactions, context.scope, false, context.employeeId);
    }),
  );

  app.get("/guest/catalog/products", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await resolveGuestContext(options, request);
      const query = readProductListQuery(request.query, true);
      return sendProductList(
        reply,
        options.transactions,
        context.scope,
        query,
      );
    }),
  );

  app.get("/guest/catalog/categories", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await resolveGuestContext(options, request);
      return sendCategoryList(reply, options.transactions, context.scope, true);
    }),
  );

  app.post("/catalog/products", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await resolveStaffContext(options, request);
      const input = readCreateProduct(request.body);
      const operational = input.operationalFields;
      const idempotencyKey = readIdempotencyKey(request);
      const command = catalogCommand(
        request,
        context,
        "catalog.product.create",
        idempotencyKey,
        input,
      );
      const execution = await options.commandExecutor.execute(
        command,
        async (transaction) => {
          await assertLivePermission(
            transaction,
            context.employeeId,
            CATALOG_PRODUCT_MANAGE_PERMISSION,
          );
          if (input.standardPrice !== null) {
            await assertLivePermission(
              transaction,
              context.employeeId,
              CATALOG_PRICE_MANAGE_PERMISSION,
            );
          }
          const result = await transaction.query<IdRow>(
            `
        INSERT INTO mbox.products (
          tenant_id, store_id, code, name, category_code,
          fulfillment_station, product_kind, product_snapshot, status,
          guest_visible, search_text, recommendation_enabled,
          recommendation_min_guests, recommendation_max_guests,
          recommendation_priority, recommendation_scene_tags, recommendation_intent_tags,
          recommendation_taste_tags, recommendation_dwell_tags,
          recommendation_single_wave_eligible, recommendation_expected_prep_minutes,
          recommendation_hold_minutes, recommendation_upgrade_product_id,
          menu_sort_order, available_from, available_until, allowed_channels,
          max_order_quantity, kds_priority, fulfillment_sla_seconds, cost_amount_minor,
          inventory_control_mode
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9,
          $10::boolean, $11::text, $12::boolean, $13::smallint, $14::smallint,
          $15::smallint, $16::text[], $17::text[], $18::text[], $19::text[],
          $20::boolean, $21::smallint, $22::smallint, $23::uuid,
          $24::integer, $25::time, $26::time, $27::text[],
          $28::smallint, $29::smallint, $30::integer, $31::bigint, $32::text)
        RETURNING id
      `,
            [
              transaction.scope.tenantId,
              transaction.scope.storeId,
              input.code,
              input.name,
              input.categoryCode,
              input.fulfillmentStation,
              input.productKind,
              JSON.stringify(persistedDisplaySnapshot(operational)),
              input.status,
              operational.guestVisible,
              operational.searchText,
              operational.recommendationEnabled,
              operational.recommendationMinGuests,
              operational.recommendationMaxGuests,
              operational.recommendationPriority,
              operational.recommendationSceneTags,
              operational.recommendationIntentTags,
              operational.recommendationTasteTags,
              operational.recommendationDwellTags,
              operational.recommendationSingleWaveEligible,
              operational.recommendationExpectedPrepMinutes,
              operational.recommendationHoldMinutes,
              operational.recommendationUpgradeProductId,
              operational.menuSortOrder,
              operational.availableFrom,
              operational.availableUntil,
              operational.allowedChannels,
              operational.maxOrderQuantity,
              operational.kdsPriority,
              operational.fulfillmentSlaSeconds,
              operational.costAmountMinor,
              input.inventoryControlMode,
            ],
          );
          const productId = result.rows[0]?.id;
          if (productId === undefined) throw new Error("Product insert did not return an id");
          await replaceBundleComponents(transaction, productId, input.bundleComponents);
          if (input.standardPrice !== null) {
            await replaceCurrentStandardPrice(transaction, productId, input.standardPrice);
          }
          const product = mapProduct(await getProduct(transaction, productId));
          return catalogOutcome(
            request,
            context,
            idempotencyKey,
            "catalog.product.created",
            "catalog.product.created.v1",
            product,
            null,
            product,
            input.standardPrice?.reason ?? null,
          );
        },
      );
      return reply
        .code(execution.replayed ? 200 : 201)
        .send(executionResponse(execution));
    }),
  );

  app.patch<{ Params: { productId: string } }>(
    "/catalog/products/:productId",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await resolveStaffContext(options, request);
        const productId = readUuid(request.params.productId, "productId");
        const patch = readUpdateProduct(request.body);
        const idempotencyKey = readIdempotencyKey(request);
        const command = catalogCommand(
          request,
          context,
          "catalog.product.update",
          idempotencyKey,
          { productId, ...patch },
        );
        const execution = await options.commandExecutor.execute(
          command,
          async (transaction) => {
            await assertLivePermission(
              transaction,
              context.employeeId,
              CATALOG_PRODUCT_MANAGE_PERMISSION,
            );
            if (patch.standardPrice !== null) {
              await assertLivePermission(
                transaction,
                context.employeeId,
                CATALOG_PRICE_MANAGE_PERMISSION,
              );
            }
            await lockProduct(transaction, productId);
            const before = mapProduct(await getProduct(transaction, productId));
            const displaySnapshot = patch.productSnapshot ?? before.productSnapshot;
            const operational = strongProductOperationalFields(
              patch.operationalInput,
              { code: before.code, name: patch.name ?? before.name },
              displaySnapshot,
              before,
            );
            assertActiveProductCost(patch.status ?? before.status, operational.costAmountMinor);
            const targetKind = patch.productKind ?? before.productKind;
            const targetStation = patch.fulfillmentStation ?? before.fulfillmentStation;
            const targetComponents = patch.bundleComponents ?? before.bundleComponents.map(componentInput);
            assertProductShape(targetKind, targetStation, targetComponents);
            if (before.productKind === "single" && targetKind === "bundle") {
              await assertProductIsNotAComponent(transaction, productId);
            }
            if (before.productKind === "bundle" && targetKind === "single") {
              await deleteBundleComponents(transaction, productId);
            }
            const result = await transaction.query<IdRow>(
              `
          UPDATE mbox.products
          SET name = COALESCE($4::text, name),
              category_code = COALESCE($5::text, category_code),
              fulfillment_station = COALESCE($6::text, fulfillment_station),
              product_kind = COALESCE($7::text, product_kind),
              product_snapshot = $8::jsonb,
              status = COALESCE($9::text, status),
              guest_visible = $10::boolean,
              search_text = $11::text,
              recommendation_enabled = $12::boolean,
              recommendation_min_guests = $13::smallint,
              recommendation_max_guests = $14::smallint,
              recommendation_priority = $15::smallint,
              recommendation_scene_tags = $16::text[],
              recommendation_intent_tags = $17::text[],
              recommendation_taste_tags = $18::text[],
              recommendation_dwell_tags = $19::text[],
              recommendation_single_wave_eligible = $20::boolean,
              recommendation_expected_prep_minutes = $21::smallint,
              recommendation_hold_minutes = $22::smallint,
              recommendation_upgrade_product_id = $23::uuid,
              menu_sort_order = $24::integer,
              available_from = $25::time,
              available_until = $26::time,
              allowed_channels = $27::text[],
              max_order_quantity = $28::smallint,
              kds_priority = $29::smallint,
              fulfillment_sla_seconds = $30::integer,
              cost_amount_minor = $31::bigint,
              cost_source = CASE
                WHEN $31::bigint IS DISTINCT FROM cost_amount_minor THEN 'manual'
                ELSE cost_source
              END,
              recipe_cost_version_id = CASE
                WHEN $31::bigint IS DISTINCT FROM cost_amount_minor THEN NULL
                ELSE recipe_cost_version_id
              END,
              inventory_control_mode = COALESCE($32::text, inventory_control_mode),
              updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
          RETURNING id
        `,
              [
                transaction.scope.tenantId,
                transaction.scope.storeId,
                productId,
                patch.name,
                patch.categoryCode,
                patch.fulfillmentStation,
                patch.productKind,
                JSON.stringify(persistedDisplaySnapshot(operational)),
                patch.status,
                operational.guestVisible,
                operational.searchText,
                operational.recommendationEnabled,
                operational.recommendationMinGuests,
                operational.recommendationMaxGuests,
                operational.recommendationPriority,
                operational.recommendationSceneTags,
                operational.recommendationIntentTags,
                operational.recommendationTasteTags,
                operational.recommendationDwellTags,
                operational.recommendationSingleWaveEligible,
                operational.recommendationExpectedPrepMinutes,
                operational.recommendationHoldMinutes,
                operational.recommendationUpgradeProductId,
                operational.menuSortOrder,
                operational.availableFrom,
                operational.availableUntil,
                operational.allowedChannels,
                operational.maxOrderQuantity,
                operational.kdsPriority,
                operational.fulfillmentSlaSeconds,
                operational.costAmountMinor,
                patch.inventoryControlMode,
              ],
            );
            if (result.rowCount !== 1) throw new CatalogProductNotFoundError();
            if (
              targetKind === "bundle" &&
              (patch.bundleComponents !== null || before.productKind !== targetKind)
            ) {
              await replaceBundleComponents(transaction, productId, targetComponents);
            }
            if (patch.standardPrice !== null) {
              await replaceCurrentStandardPrice(transaction, productId, patch.standardPrice);
            }
            const product = mapProduct(
              await getProduct(transaction, productId),
            );
            return catalogOutcome(
              request,
              context,
              idempotencyKey,
              "catalog.product.updated",
              "catalog.product.updated.v1",
              product,
              before,
              product,
              patch.standardPrice?.reason ?? null,
            );
          },
        );
        return reply.send(executionResponse(execution));
      }),
  );

  app.put<{ Params: { productId: string } }>(
    "/catalog/products/:productId/standard-price",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await resolveStaffContext(options, request);
        const productId = readUuid(request.params.productId, "productId");
        const price = readStandardPrice(request.body);
        const idempotencyKey = readIdempotencyKey(request);
        const command = catalogCommand(
          request,
          context,
          "catalog.standard-price.replace",
          idempotencyKey,
          { productId, ...price },
        );
        const execution = await priceCommandExecutor.execute(
          command,
          async (transaction) => {
            await assertLivePermission(
              transaction,
              context.employeeId,
              CATALOG_PRICE_MANAGE_PERMISSION,
            );
            await lockProduct(transaction, productId);
            const before = mapProduct(await getProduct(transaction, productId));
            await replaceCurrentStandardPrice(transaction, productId, price);
            const product = mapProduct(
              await getProduct(transaction, productId),
            );
            return catalogOutcome(
              request,
              context,
              idempotencyKey,
              "catalog.standard_price.changed",
              "catalog.standard_price.changed.v1",
              product,
              before,
              product,
              price.reason,
            );
          },
        );
        return reply.send(executionResponse(execution));
      }),
  );
};

async function sendProductList(
  reply: FastifyReply,
  transactions: TransactionRunnerPort,
  scope: Readonly<StoreScope>,
  query: Readonly<ProductListQuery>,
  employeeId?: string,
): Promise<FastifyReply> {
  const result = await transactions.run(
    scope,
    async (transaction) => {
      let includeCost = false;
      if (employeeId !== undefined) {
        await assertLivePermission(transaction, employeeId, CATALOG_PRODUCT_MANAGE_PERMISSION);
        try {
          await assertLivePermission(transaction, employeeId, INVENTORY_COST_VIEW_PERMISSION);
          includeCost = true;
        } catch (error) {
          if (!(error instanceof StaffAccessDeniedError)) throw error;
        }
      }
      return { products: await listProducts(transaction, query), includeCost };
    },
    { readOnly: true },
  );
  return reply.send({
    data: result.products.map((row) => mapProduct(row, query.guest, result.includeCost)),
    page: {
      limit: query.limit,
      offset: query.offset,
      returned: result.products.length,
    },
  });
}

async function sendCategoryList(
  reply: FastifyReply,
  transactions: TransactionRunnerPort,
  scope: Readonly<StoreScope>,
  guest: boolean,
  employeeId?: string,
): Promise<FastifyReply> {
  const categories = await transactions.run(scope, async (transaction) => {
    if (employeeId !== undefined) {
      await assertLivePermission(transaction, employeeId, CATALOG_PRODUCT_MANAGE_PERMISSION);
    }
    return listCategories(transaction, guest);
  }, {
    readOnly: true,
  });
  return reply.send({
    data: categories.map((row) => ({
      code: row.category_code,
      productCount: Number(row.product_count),
      availableCount: Number(row.available_count),
    })),
  });
}

async function listProducts(
  transaction: ScopedTransaction,
  query: Readonly<ProductListQuery>,
): Promise<ProductRow[]> {
  const result = await transaction.query<ProductRow>(
    `
    SELECT product.id, product.code, product.name, product.category_code,
      product.fulfillment_station, product.product_kind, product.inventory_control_mode,
      COALESCE(component_list.items, '[]'::jsonb) AS bundle_components,
      COALESCE(component_list.all_available, false) AS bundle_components_available,
      COALESCE(inventory_readiness.configuration_complete, false) AS inventory_configuration_complete,
      COALESCE(inventory_stock.available, false) AS inventory_available,
      product.product_snapshot, product.guest_visible, product.search_text,
      product.recommendation_enabled, product.recommendation_min_guests,
      product.recommendation_max_guests, product.recommendation_priority,
      product.recommendation_scene_tags, product.recommendation_intent_tags,
      product.recommendation_taste_tags, product.recommendation_dwell_tags,
      product.recommendation_single_wave_eligible,
      product.recommendation_expected_prep_minutes, product.recommendation_hold_minutes,
      product.recommendation_upgrade_product_id,
      product.menu_sort_order, to_char(product.available_from, 'HH24:MI') AS available_from,
      to_char(product.available_until, 'HH24:MI') AS available_until,
      product.allowed_channels, product.max_order_quantity, product.kds_priority,
      product.fulfillment_sla_seconds,
      product.cost_amount_minor::text, product.status,
      price.id AS standard_price_id, price.amount_minor::text,
      price.currency, price.valid_from::text AS price_valid_from,
      price.valid_until::text AS price_valid_until,
      product.created_at::text, product.updated_at::text
    FROM mbox.products AS product
    JOIN mbox.stores AS store
      ON store.tenant_id = product.tenant_id AND store.id = product.store_id
    LEFT JOIN LATERAL (
      SELECT candidate.id, candidate.amount_minor, candidate.currency,
        candidate.valid_from, candidate.valid_until
      FROM mbox.product_prices AS candidate
      WHERE candidate.tenant_id = product.tenant_id
        AND candidate.store_id = product.store_id
        AND candidate.product_id = product.id
        AND candidate.price_type = 'standard'
        AND candidate.currency = store.currency
        AND candidate.valid_from <= statement_timestamp()
        AND (candidate.valid_until IS NULL OR candidate.valid_until > statement_timestamp())
      ORDER BY candidate.valid_from DESC, candidate.id DESC
      LIMIT 1
    ) AS price ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'productId', component_product.id,
          'code', component_product.code,
          'name', component_product.name,
          'quantity', component.quantity,
          'sortOrder', component.sort_order,
          'note', component.note
        ) ORDER BY component.sort_order, component.id
      ) AS items,
      count(*) > 0 AND bool_and(component_product.status = 'active') AS all_available
      FROM mbox.product_bundle_components AS component
      JOIN mbox.products AS component_product
        ON component_product.tenant_id = component.tenant_id
        AND component_product.store_id = component.store_id
        AND component_product.id = component.component_product_id
      WHERE component.tenant_id = product.tenant_id
        AND component.store_id = product.store_id
        AND component.bundle_product_id = product.id
    ) AS component_list ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(bool_and(
        required_product.inventory_control_mode = 'not_managed'
        OR required_product.fulfillment_station NOT IN ('bar', 'kitchen')
        OR EXISTS (
          SELECT 1
          FROM mbox.recipes AS recipe
          WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
            AND recipe.product_id=required_product.product_id
            AND recipe.status='active' AND recipe.effective_at<=statement_timestamp()
            AND EXISTS (
              SELECT 1 FROM mbox.recipe_items AS recipe_item
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM mbox.recipe_items AS recipe_item
              LEFT JOIN mbox.inventory_items AS inventory_item
                ON inventory_item.tenant_id=recipe_item.tenant_id
               AND inventory_item.store_id=recipe_item.store_id
               AND inventory_item.id=recipe_item.inventory_item_id
              LEFT JOIN mbox.inventory_balances AS balance
                ON balance.tenant_id=recipe_item.tenant_id
               AND balance.store_id=recipe_item.store_id
               AND balance.inventory_item_id=recipe_item.inventory_item_id
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
                AND (inventory_item.id IS NULL OR inventory_item.status<>'active' OR balance.id IS NULL)
            )
        )
      ), true) AS configuration_complete
      FROM (
        SELECT product.id AS product_id, product.fulfillment_station, product.inventory_control_mode
        WHERE COALESCE(product.product_kind, 'single')<>'bundle'
        UNION ALL
        SELECT component_product.id, component_product.fulfillment_station, component_product.inventory_control_mode
        FROM mbox.product_bundle_components AS component
        JOIN mbox.products AS component_product
          ON component_product.tenant_id=component.tenant_id
         AND component_product.store_id=component.store_id
         AND component_product.id=component.component_product_id
        WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
          AND component.bundle_product_id=product.id
          AND COALESCE(product.product_kind, 'single')='bundle'
      ) AS required_product
    ) AS inventory_readiness ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(bool_and(
        required_product.inventory_control_mode='not_managed'
        OR required_product.fulfillment_station NOT IN ('bar','kitchen')
        OR EXISTS (
          SELECT 1 FROM mbox.recipes recipe
          WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
            AND recipe.product_id=required_product.product_id
            AND recipe.status='active' AND recipe.effective_at<=statement_timestamp()
            AND EXISTS (
              SELECT 1 FROM mbox.recipe_items recipe_item
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM mbox.recipe_items recipe_item
              LEFT JOIN mbox.inventory_items inventory_item
                ON inventory_item.tenant_id=recipe_item.tenant_id
               AND inventory_item.store_id=recipe_item.store_id
               AND inventory_item.id=recipe_item.inventory_item_id
              LEFT JOIN mbox.inventory_balances balance
                ON balance.tenant_id=recipe_item.tenant_id AND balance.store_id=recipe_item.store_id
               AND balance.inventory_item_id=recipe_item.inventory_item_id
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
                AND (inventory_item.id IS NULL OR inventory_item.status<>'active' OR balance.id IS NULL
                  OR balance.on_hand_quantity-balance.reserved_quantity
                    < recipe_item.quantity*required_product.multiplier)
            )
        )
      ),true) AS available
      FROM (
        SELECT product.id AS product_id,product.fulfillment_station,product.inventory_control_mode,
          1::numeric AS multiplier
        WHERE COALESCE(product.product_kind,'single')<>'bundle'
        UNION ALL
        SELECT component_product.id,component_product.fulfillment_station,
          component_product.inventory_control_mode,component.quantity::numeric
        FROM mbox.product_bundle_components component
        JOIN mbox.products component_product
          ON component_product.tenant_id=component.tenant_id
         AND component_product.store_id=component.store_id
         AND component_product.id=component.component_product_id
        WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
          AND component.bundle_product_id=product.id
          AND COALESCE(product.product_kind,'single')='bundle'
      ) required_product
    ) AS inventory_stock ON true
    WHERE product.tenant_id = $1::uuid AND product.store_id = $2::uuid
      AND (
        $3 = ''
        OR strpos(lower(product.name), lower($3)) > 0
        OR strpos(lower(product.code), lower($3)) > 0
        OR strpos(lower(product.search_text), lower($3)) > 0
      )
      AND ($4::text IS NULL OR product.category_code = $4)
      AND ($5 = 'all' OR product.status = $5)
      AND (NOT $8::boolean OR product.guest_visible)
    ORDER BY product.category_code, product.name, product.code, product.id
    LIMIT $6::integer OFFSET $7::integer
  `,
    [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      query.search,
      query.categoryCode,
      query.status,
      query.limit,
      query.offset,
      query.guest,
    ],
  );
  return result.rows;
}

async function listCategories(
  transaction: ScopedTransaction,
  guest: boolean,
): Promise<CategoryRow[]> {
  const result = await transaction.query<CategoryRow>(
    `
    SELECT product.category_code,
      count(*)::text AS product_count,
      count(*) FILTER (
        WHERE product.status = 'active' AND EXISTS (
          SELECT 1 FROM mbox.product_prices AS price
          WHERE price.tenant_id = product.tenant_id
            AND price.store_id = product.store_id
            AND price.product_id = product.id
            AND price.price_type = 'standard'
            AND price.currency = store.currency
            AND price.valid_from <= statement_timestamp()
            AND (price.valid_until IS NULL OR price.valid_until > statement_timestamp())
        )
      )::text AS available_count
    FROM mbox.products AS product
    JOIN mbox.stores AS store
      ON store.tenant_id = product.tenant_id AND store.id = product.store_id
    WHERE product.tenant_id = $1::uuid AND product.store_id = $2::uuid
      AND product.status <> 'inactive'
      AND (NOT $3::boolean OR product.guest_visible)
    GROUP BY product.category_code, store.currency
    ORDER BY product.category_code
  `,
    [transaction.scope.tenantId, transaction.scope.storeId, guest],
  );
  return result.rows;
}

function componentInput(component: BundleComponent): BundleComponentInput {
  return {
    productId: component.productId,
    quantity: component.quantity,
    sortOrder: component.sortOrder,
    note: component.note,
  };
}

function assertProductShape(
  productKind: ProductKind,
  fulfillmentStation: FulfillmentStation,
  components: readonly BundleComponentInput[],
): void {
  if (productKind === "bundle") {
    if (fulfillmentStation !== "none") {
      throw new CatalogRequestError("组合商品的出品岗位必须为none，由组成单品分别出品");
    }
    if (components.length === 0) {
      throw new CatalogRequestError("组合商品至少需要一个组成单品");
    }
    return;
  }
  if (components.length > 0) {
    throw new CatalogRequestError("普通单品不能配置组合组成清单");
  }
}

async function assertProductIsNotAComponent(
  transaction: ScopedTransaction,
  productId: string,
): Promise<void> {
  const result = await transaction.query<IdRow>(`
    SELECT id FROM mbox.product_bundle_components
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND component_product_id = $3::uuid
    LIMIT 1
  `, [transaction.scope.tenantId, transaction.scope.storeId, productId]);
  if ((result.rowCount ?? 0) > 0) {
    throw new CatalogConflictError("该商品正在被其他组合使用，不能改为组合商品");
  }
}

async function deleteBundleComponents(
  transaction: ScopedTransaction,
  productId: string,
): Promise<void> {
  await transaction.query(`
    DELETE FROM mbox.product_bundle_components
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND bundle_product_id = $3::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, productId]);
}

async function replaceBundleComponents(
  transaction: ScopedTransaction,
  productId: string,
  components: readonly BundleComponentInput[],
): Promise<void> {
  await deleteBundleComponents(transaction, productId);
  if (components.length === 0) return;
  const productIds = components.map((component) => component.productId);
  const validation = await transaction.query<{ id: string }>(`
    SELECT id
    FROM mbox.products
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND id = ANY($3::uuid[])
      AND id <> $4::uuid
      AND product_kind = 'single'
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    productIds,
    productId,
  ]);
  if (validation.rows.length !== productIds.length) {
    throw new CatalogConflictError("组合中包含不存在、重复、嵌套或跨门店的商品");
  }
  await transaction.query(`
    INSERT INTO mbox.product_bundle_components (
      tenant_id, store_id, bundle_product_id, component_product_id,
      quantity, sort_order, note
    )
    SELECT $1::uuid, $2::uuid, $3::uuid,
      input.product_id, input.quantity, input.sort_order, input.note
    FROM jsonb_to_recordset($4::jsonb) AS input(
      product_id uuid, quantity integer, sort_order integer, note text
    )
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    productId,
    JSON.stringify(components.map((component) => ({
      product_id: component.productId,
      quantity: component.quantity,
      sort_order: component.sortOrder,
      note: component.note,
    }))),
  ]);
}

async function assertLivePermission(
  transaction: ScopedTransaction,
  employeeId: string,
  permission: string,
): Promise<void> {
  await new StaffAccessRepository(transaction).assertPermission(
    employeeId,
    permission,
  );
}

async function lockProduct(
  transaction: ScopedTransaction,
  productId: string,
): Promise<void> {
  const result = await transaction.query<IdRow>(
    `
    SELECT id FROM mbox.products
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    FOR UPDATE
  `,
    [transaction.scope.tenantId, transaction.scope.storeId, productId],
  );
  if (result.rowCount !== 1) throw new CatalogProductNotFoundError();
}

async function readDatabaseTimestamp(
  transaction: ScopedTransaction,
): Promise<string> {
  const result = await transaction.query<TimestampRow>(`
    SELECT clock_timestamp()::text AS effective_at
  `);
  const value = result.rows[0]?.effective_at;
  if (value === undefined) throw new Error("Database clock was unavailable");
  return value;
}

async function rejectFutureStandardPrice(
  transaction: ScopedTransaction,
  productId: string,
  currency: string,
  effectiveAt: string,
): Promise<void> {
  const result = await transaction.query<IdRow>(
    `
    SELECT id FROM mbox.product_prices
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND product_id = $3::uuid AND price_type = 'standard' AND currency = $4
      AND valid_from >= $5::timestamptz
    FOR UPDATE
    LIMIT 1
  `,
    [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      productId,
      currency,
      effectiveAt,
    ],
  );
  if ((result.rowCount ?? 0) > 0) {
    throw new CatalogConflictError(
      "商品已有未来生效的标准售价，请先处理排期价格",
    );
  }
}

async function replaceCurrentStandardPrice(
  transaction: ScopedTransaction,
  productId: string,
  price: Readonly<StandardPriceInput>,
): Promise<void> {
  const effectiveAt = await readDatabaseTimestamp(transaction);
  await rejectFutureStandardPrice(transaction, productId, price.currency, effectiveAt);
  await transaction.query(
    `
      UPDATE mbox.product_prices
      SET valid_until = $5::timestamptz
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND product_id = $3::uuid AND price_type = 'standard' AND currency = $4
        AND valid_from < $5::timestamptz
        AND (valid_until IS NULL OR valid_until > $5::timestamptz)
    `,
    [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      productId,
      price.currency,
      effectiveAt,
    ],
  );
  await transaction.query(
    `
      INSERT INTO mbox.product_prices (
        tenant_id, store_id, product_id, price_type,
        amount_minor, currency, valid_from
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'standard', $4::bigint, $5, $6::timestamptz)
    `,
    [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      productId,
      price.amountMinor.toString(),
      price.currency,
      effectiveAt,
    ],
  );
  await transaction.query(
    `
      UPDATE mbox.products
      SET updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `,
    [transaction.scope.tenantId, transaction.scope.storeId, productId],
  );
}

async function getProduct(
  transaction: ScopedTransaction,
  productId: string,
): Promise<ProductRow> {
  const result = await transaction.query<ProductRow>(
    `
    SELECT product.id, product.code, product.name, product.category_code,
      product.fulfillment_station, product.product_kind, product.inventory_control_mode,
      COALESCE(component_list.items, '[]'::jsonb) AS bundle_components,
      COALESCE(component_list.all_available, false) AS bundle_components_available,
      COALESCE(inventory_readiness.configuration_complete, false) AS inventory_configuration_complete,
      COALESCE(inventory_stock.available, false) AS inventory_available,
      product.product_snapshot, product.guest_visible, product.search_text,
      product.recommendation_enabled, product.recommendation_min_guests,
      product.recommendation_max_guests, product.recommendation_priority,
      product.recommendation_scene_tags, product.recommendation_intent_tags,
      product.recommendation_taste_tags, product.recommendation_dwell_tags,
      product.recommendation_single_wave_eligible,
      product.recommendation_expected_prep_minutes, product.recommendation_hold_minutes,
      product.recommendation_upgrade_product_id,
      product.menu_sort_order, to_char(product.available_from, 'HH24:MI') AS available_from,
      to_char(product.available_until, 'HH24:MI') AS available_until,
      product.allowed_channels, product.max_order_quantity, product.kds_priority,
      product.fulfillment_sla_seconds,
      product.cost_amount_minor::text, product.status,
      price.id AS standard_price_id, price.amount_minor::text,
      price.currency, price.valid_from::text AS price_valid_from,
      price.valid_until::text AS price_valid_until,
      product.created_at::text, product.updated_at::text
    FROM mbox.products AS product
    JOIN mbox.stores AS store
      ON store.tenant_id = product.tenant_id AND store.id = product.store_id
    LEFT JOIN LATERAL (
      SELECT candidate.id, candidate.amount_minor, candidate.currency,
        candidate.valid_from, candidate.valid_until
      FROM mbox.product_prices AS candidate
      WHERE candidate.tenant_id = product.tenant_id
        AND candidate.store_id = product.store_id
        AND candidate.product_id = product.id
        AND candidate.price_type = 'standard'
        AND candidate.currency = store.currency
        AND candidate.valid_from <= statement_timestamp()
        AND (candidate.valid_until IS NULL OR candidate.valid_until > statement_timestamp())
      ORDER BY candidate.valid_from DESC, candidate.id DESC
      LIMIT 1
    ) AS price ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'productId', component_product.id,
          'code', component_product.code,
          'name', component_product.name,
          'quantity', component.quantity,
          'sortOrder', component.sort_order,
          'note', component.note
        ) ORDER BY component.sort_order, component.id
      ) AS items,
      count(*) > 0 AND bool_and(component_product.status = 'active') AS all_available
      FROM mbox.product_bundle_components AS component
      JOIN mbox.products AS component_product
        ON component_product.tenant_id = component.tenant_id
        AND component_product.store_id = component.store_id
        AND component_product.id = component.component_product_id
      WHERE component.tenant_id = product.tenant_id
        AND component.store_id = product.store_id
        AND component.bundle_product_id = product.id
    ) AS component_list ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(bool_and(
        required_product.inventory_control_mode = 'not_managed'
        OR required_product.fulfillment_station NOT IN ('bar', 'kitchen')
        OR EXISTS (
          SELECT 1
          FROM mbox.recipes AS recipe
          WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
            AND recipe.product_id=required_product.product_id
            AND recipe.status='active' AND recipe.effective_at<=statement_timestamp()
            AND EXISTS (
              SELECT 1 FROM mbox.recipe_items AS recipe_item
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM mbox.recipe_items AS recipe_item
              LEFT JOIN mbox.inventory_items AS inventory_item
                ON inventory_item.tenant_id=recipe_item.tenant_id
               AND inventory_item.store_id=recipe_item.store_id
               AND inventory_item.id=recipe_item.inventory_item_id
              LEFT JOIN mbox.inventory_balances AS balance
                ON balance.tenant_id=recipe_item.tenant_id
               AND balance.store_id=recipe_item.store_id
               AND balance.inventory_item_id=recipe_item.inventory_item_id
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
                AND (inventory_item.id IS NULL OR inventory_item.status<>'active' OR balance.id IS NULL)
            )
        )
      ), true) AS configuration_complete
      FROM (
        SELECT product.id AS product_id, product.fulfillment_station, product.inventory_control_mode
        WHERE COALESCE(product.product_kind, 'single')<>'bundle'
        UNION ALL
        SELECT component_product.id, component_product.fulfillment_station, component_product.inventory_control_mode
        FROM mbox.product_bundle_components AS component
        JOIN mbox.products AS component_product
          ON component_product.tenant_id=component.tenant_id
         AND component_product.store_id=component.store_id
         AND component_product.id=component.component_product_id
        WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
          AND component.bundle_product_id=product.id
          AND COALESCE(product.product_kind, 'single')='bundle'
      ) AS required_product
    ) AS inventory_readiness ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(bool_and(
        required_product.inventory_control_mode='not_managed'
        OR required_product.fulfillment_station NOT IN ('bar','kitchen')
        OR EXISTS (
          SELECT 1 FROM mbox.recipes recipe
          WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
            AND recipe.product_id=required_product.product_id
            AND recipe.status='active' AND recipe.effective_at<=statement_timestamp()
            AND EXISTS (
              SELECT 1 FROM mbox.recipe_items recipe_item
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM mbox.recipe_items recipe_item
              LEFT JOIN mbox.inventory_items inventory_item
                ON inventory_item.tenant_id=recipe_item.tenant_id
               AND inventory_item.store_id=recipe_item.store_id
               AND inventory_item.id=recipe_item.inventory_item_id
              LEFT JOIN mbox.inventory_balances balance
                ON balance.tenant_id=recipe_item.tenant_id AND balance.store_id=recipe_item.store_id
               AND balance.inventory_item_id=recipe_item.inventory_item_id
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
                AND (inventory_item.id IS NULL OR inventory_item.status<>'active' OR balance.id IS NULL
                  OR balance.on_hand_quantity-balance.reserved_quantity
                    < recipe_item.quantity*required_product.multiplier)
            )
        )
      ),true) AS available
      FROM (
        SELECT product.id AS product_id,product.fulfillment_station,product.inventory_control_mode,
          1::numeric AS multiplier
        WHERE COALESCE(product.product_kind,'single')<>'bundle'
        UNION ALL
        SELECT component_product.id,component_product.fulfillment_station,
          component_product.inventory_control_mode,component.quantity::numeric
        FROM mbox.product_bundle_components component
        JOIN mbox.products component_product
          ON component_product.tenant_id=component.tenant_id
         AND component_product.store_id=component.store_id
         AND component_product.id=component.component_product_id
        WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
          AND component.bundle_product_id=product.id
          AND COALESCE(product.product_kind,'single')='bundle'
      ) required_product
    ) AS inventory_stock ON true
    WHERE product.tenant_id = $1::uuid AND product.store_id = $2::uuid
      AND product.id = $3::uuid
  `,
    [transaction.scope.tenantId, transaction.scope.storeId, productId],
  );
  return requiredProduct(result.rows[0]);
}

function mapProduct(row: ProductRow, guest = false, includeCost = true): CatalogProduct {
  const standardPrice =
    row.standard_price_id === null
      ? null
      : {
          id: row.standard_price_id,
          amountMinor: row.amount_minor,
          currency: row.currency,
          validFrom: row.price_valid_from,
          validUntil: row.price_valid_until,
        };
  const catalogAvailable = row.status === "active" && standardPrice !== null
    && (row.product_kind !== "bundle" || row.bundle_components_available === true);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    categoryCode: row.category_code,
    fulfillmentStation: row.fulfillment_station,
    productKind: row.product_kind ?? "single",
    inventoryControlMode: row.inventory_control_mode,
    bundleComponents: readStoredBundleComponents(row.bundle_components ?? []),
    productSnapshot: guest ? guestProductSnapshot(row.product_snapshot) : row.product_snapshot,
    guestVisible: row.guest_visible,
    searchText: row.search_text,
    recommendationEnabled: row.recommendation_enabled,
    recommendationMinGuests: row.recommendation_min_guests,
    recommendationMaxGuests: row.recommendation_max_guests,
    recommendationPriority: row.recommendation_priority,
    recommendationSceneTags: row.recommendation_scene_tags,
    recommendationIntentTags: row.recommendation_intent_tags,
    recommendationTasteTags: row.recommendation_taste_tags,
    recommendationDwellTags: row.recommendation_dwell_tags,
    recommendationSingleWaveEligible: row.recommendation_single_wave_eligible,
    recommendationExpectedPrepMinutes: row.recommendation_expected_prep_minutes,
    recommendationHoldMinutes: row.recommendation_hold_minutes,
    recommendationUpgradeProductId: row.recommendation_upgrade_product_id,
    menuSortOrder: row.menu_sort_order,
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    allowedChannels: row.allowed_channels,
    maxOrderQuantity: row.max_order_quantity,
    kdsPriority: row.kds_priority,
    fulfillmentSlaSeconds: row.fulfillment_sla_seconds,
    ...(includeCost ? { costAmountMinor: row.cost_amount_minor === null ? null : Number(row.cost_amount_minor) } : {}),
    status: row.status,
    isAvailable: catalogAvailable && row.inventory_available
      && (!guest || row.inventory_configuration_complete),
    inventoryConfigurationComplete: row.inventory_configuration_complete,
    inventoryAvailable: row.inventory_available,
    standardPrice,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function persistedDisplaySnapshot(fields: Readonly<ProductOperationalFields>): JsonObject {
  return fields.displaySnapshot
}

function catalogOutcome(
  request: FastifyRequest,
  context: NormalizedOperationsRequestContext,
  idempotencyKey: string,
  action: string,
  eventType: string,
  product: CatalogProduct,
  before: CatalogProduct | null,
  after: CatalogProduct,
  reason: string | null,
): CommandOutcome<CatalogProduct> {
  return {
    result: product,
    auditEvents: [
      {
        actor: { type: "employee", employeeId: context.employeeId },
        action,
        objectType: "product",
        objectId: product.id,
        businessDate: context.businessDate,
        beforeData: before === null ? null : catalogProductToJson(before),
        afterData: catalogProductToJson(after),
        reason,
        requestId: request.id,
      },
    ],
    outboxMessages: [
      {
        businessEventKey: catalogEventKey(action, idempotencyKey),
        aggregateType: "product",
        aggregateId: product.id,
        aggregateVersion: 1,
        eventType,
        payload: {
          product: catalogProductToJson(product),
          ...(reason === null ? {} : { reason }),
        },
      },
    ],
  };
}

function catalogEventKey(action: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${action}:${idempotencyKey}`, "utf8")
    .digest("hex");
  return `catalog:${digest}`;
}

function catalogCommand(
  request: FastifyRequest,
  context: NormalizedOperationsRequestContext,
  operationScope: string,
  idempotencyKey: string,
  payload: unknown,
): IdempotentCommand<CatalogProduct> {
  return {
    scope: context.scope,
    operationScope,
    idempotencyKey,
    requestFingerprint: stableStringify({
      method: request.method,
      path:
        request.routeOptions.url ?? request.url.split("?")[0] ?? request.url,
      tenantId: context.scope.tenantId,
      storeId: context.scope.storeId,
      employeeId: context.employeeId,
      payload: jsonFingerprintValue(payload),
    }),
    resultCodec: catalogProductCodec,
  };
}

function jsonFingerprintValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function createConfiguredCommandExecutor(
  transactions: TransactionRunnerPort,
  transactionOptions: Readonly<TransactionOptions>,
): CommandExecutorPort {
  const configuredTransactions: TransactionRunnerPort = {
    run: (scope, operation) =>
      transactions.run(scope, operation, transactionOptions),
  };
  return new NormalizedCommandExecutor(
    configuredTransactions as ScopedPostgresTransactionRunner,
  );
}

async function resolveStaffContext(
  options: CatalogApiOptions,
  request: FastifyRequest,
): Promise<NormalizedOperationsRequestContext> {
  const context = await options.resolveContext(request);
  assertScope(context.scope);
  assertUuid(context.employeeId, "employeeId");
  return context;
}

async function resolveGuestContext(
  options: CatalogApiOptions,
  request: FastifyRequest,
): Promise<GuestCatalogReadContext> {
  const context = await options.resolveGuestContext(request);
  assertScope(context.scope);
  return context;
}

function assertScope(scope: Readonly<StoreScope>): void {
  assertUuid(scope.tenantId, "tenantId");
  assertUuid(scope.storeId, "storeId");
}

function readProductListQuery(
  value: unknown,
  guest: boolean,
): ProductListQuery {
  const query = readRecord(value, "查询参数");
  if (guest && query.status !== undefined && query.status !== "active") {
    throw new CatalogRequestError("客户菜单只能查询在售商品");
  }
  const search = optionalText(query.search, "search", 80) ?? "";
  const categoryCode = optionalCode(
    query.category ?? query.categoryCode,
    "category",
  );
  const status = guest
    ? "active"
    : query.status === undefined
      ? "active"
      : readStatus(query.status, true);
  return {
    search,
    categoryCode,
    status,
    guest,
    limit: optionalInteger(query.limit, "limit", 1, 100) ?? 40,
    offset: optionalInteger(query.offset, "offset", 0, 10_000) ?? 0,
  };
}

function guestProductSnapshot(snapshot: JsonObject): JsonObject {
  return redact(snapshot) as JsonObject
}

function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => entry !== undefined && !/(cost|margin|purchase.?price)/i.test(key))
    .map(([key, entry]) => [key, redact(entry as JsonValue)]))
}

function readCreateProduct(value: unknown): {
  code: string;
  name: string;
  categoryCode: string;
  fulfillmentStation: FulfillmentStation;
  productKind: ProductKind;
  inventoryControlMode: InventoryControlMode;
  bundleComponents: BundleComponentInput[];
  productSnapshot: JsonObject;
  operationalFields: ProductOperationalFields;
  status: ProductStatus;
  standardPrice: StandardPriceInput | null;
} {
  const body = readJsonObject(value, "请求正文");
  const code = requiredCode(body.code, "code");
  const name = requiredText(body.name, "name", 160);
  const productKind = readProductKind(body.productKind);
  const fulfillmentStation = readStation(body.fulfillmentStation);
  const bundleComponents = readBundleComponents(body.bundleComponents, productKind === "bundle");
  const productSnapshot = optionalJsonObject(body.productSnapshot);
  assertDisplayOnlyProductSnapshot(productSnapshot);
  assertProductShape(productKind, fulfillmentStation, bundleComponents);
  const operationalFields = strongProductOperationalFields(body, { code, name }, productSnapshot);
  const status = body.status === undefined ? "active" : readStatus(body.status, false);
  const standardPrice = body.standardPrice === undefined ? null : readStandardPrice(body.standardPrice);
  const inventoryControlMode = body.inventoryControlMode === undefined
    ? (requiredCode(body.categoryCode, "categoryCode") === "food" ? "not_managed" : "tracked")
    : readInventoryControlMode(body.inventoryControlMode);
  assertActiveProductCost(status, operationalFields.costAmountMinor);
  return {
    code,
    name,
    categoryCode: requiredCode(body.categoryCode, "categoryCode"),
    fulfillmentStation,
    productKind,
    inventoryControlMode,
    bundleComponents,
    productSnapshot,
    operationalFields,
    status,
    standardPrice,
  };
}

function readUpdateProduct(value: unknown): {
  name: string | null;
  categoryCode: string | null;
  fulfillmentStation: FulfillmentStation | null;
  productKind: ProductKind | null;
  inventoryControlMode: InventoryControlMode | null;
  bundleComponents: BundleComponentInput[] | null;
  productSnapshot: JsonObject | null;
  operationalInput: JsonObject;
  status: ProductStatus | null;
  standardPrice: StandardPriceInput | null;
} {
  const body = readJsonObject(value, "请求正文");
  const productSnapshot = body.productSnapshot === undefined
    ? null : optionalJsonObject(body.productSnapshot);
  if (productSnapshot !== null) assertDisplayOnlyProductSnapshot(productSnapshot);
  const patch = {
    name: body.name === undefined ? null : requiredText(body.name, "name", 160),
    categoryCode:
      body.categoryCode === undefined
        ? null
        : requiredCode(body.categoryCode, "categoryCode"),
    fulfillmentStation:
      body.fulfillmentStation === undefined
        ? null
        : readStation(body.fulfillmentStation),
    productKind:
      body.productKind === undefined ? null : readProductKind(body.productKind),
    inventoryControlMode: body.inventoryControlMode === undefined
      ? null : readInventoryControlMode(body.inventoryControlMode),
    bundleComponents:
      body.bundleComponents === undefined
        ? null
        : readBundleComponents(body.bundleComponents, false),
    productSnapshot,
    operationalInput: body,
    status: body.status === undefined ? null : readStatus(body.status, false),
    standardPrice: body.standardPrice === undefined ? null : readStandardPrice(body.standardPrice),
  };
  if ([patch.name, patch.categoryCode, patch.fulfillmentStation, patch.productKind, patch.inventoryControlMode,
    patch.bundleComponents, patch.productSnapshot, patch.status, patch.standardPrice].every((item) => item === null)
    && !PRODUCT_OPERATIONAL_INPUT_KEYS.some((key) => body[key] !== undefined)) {
    throw new CatalogRequestError("至少提供一个可修改字段");
  }
  return patch;
}

const PRODUCT_OPERATIONAL_INPUT_KEYS = [
  'guestVisible', 'searchText', 'recommendationEnabled', 'recommendationMinGuests',
  'recommendationMaxGuests', 'recommendationPriority', 'recommendationSceneTags',
  'recommendationIntentTags', 'recommendationTasteTags', 'recommendationDwellTags',
  'recommendationSingleWaveEligible', 'recommendationExpectedPrepMinutes',
  'recommendationHoldMinutes', 'recommendationUpgradeProductId', 'menuSortOrder',
  'availableFrom', 'availableUntil', 'allowedChannels', 'maxOrderQuantity',
  'kdsPriority', 'fulfillmentSlaSeconds', 'costAmountMinor',
] as const;

function strongProductOperationalFields(
  input: Readonly<JsonObject>,
  identity: Readonly<{ code: string; name: string }>,
  displaySnapshot: Readonly<JsonObject>,
  fallback?: Readonly<CatalogProduct>,
): ProductOperationalFields {
  const value = <Key extends typeof PRODUCT_OPERATIONAL_INPUT_KEYS[number]>(
    key: Key,
    defaultValue: JsonValue,
  ): JsonValue => input[key] === undefined
    ? (fallback?.[key] as JsonValue | undefined) ?? defaultValue
    : input[key] as JsonValue;
  const defaultSearchText = `${identity.code} ${identity.name}`;
  const requestedSearchText = value('searchText', defaultSearchText);
  const operational = extractProductOperationalFields({
    guestVisible: value('guestVisible', true),
    searchText: typeof requestedSearchText === 'string' && requestedSearchText.trim() === ''
      ? defaultSearchText : requestedSearchText,
    sortOrder: value('menuSortOrder', 999),
    availableFrom: value('availableFrom', null),
    availableUntil: value('availableUntil', null),
    allowedChannels: value('allowedChannels', ['guest_qr', 'staff_assisted', 'cashier', 'reservation', 'integration']),
    maxOrderQuantity: value('maxOrderQuantity', 50),
    kdsPriority: value('kdsPriority', 100),
    fulfillmentSlaSeconds: value('fulfillmentSlaSeconds', null),
    costAmount: value('costAmountMinor', null),
    recommendation: {
      enabled: value('recommendationEnabled', false),
      minimumPartySize: value('recommendationMinGuests', 1),
      maximumPartySize: value('recommendationMaxGuests', 100),
      priority: value('recommendationPriority', 100),
      sceneTags: value('recommendationSceneTags', []),
      intentTags: value('recommendationIntentTags', []),
      tasteTags: value('recommendationTasteTags', []),
      dwellTags: value('recommendationDwellTags', []),
      singleWaveEligible: value('recommendationSingleWaveEligible', true),
      expectedPrepMinutes: value('recommendationExpectedPrepMinutes', 8),
      holdMinutes: value('recommendationHoldMinutes', 10),
      upgradeProductId: value('recommendationUpgradeProductId', null),
    },
  }, identity);
  return { ...operational, displaySnapshot: { ...displaySnapshot } };
}

function assertDisplayOnlyProductSnapshot(snapshot: Readonly<JsonObject>): void {
  const imageUrl = snapshot.imageUrl;
  if (imageUrl !== undefined && imageUrl !== null
    && (typeof imageUrl !== 'string' || (imageUrl.trim() !== '' && !isPublicMiniProgramImageUrl(imageUrl)))) {
    throw new CatalogRequestError('商品图片必须从受控菜单素材或站内图片库选择，单张不超过200KB');
  }
  const topLevel = new Set([
    'guestVisible', 'searchText', 'sortOrder', 'availableFrom', 'availableUntil',
    'allowedChannels', 'maxOrderQuantity', 'kdsPriority', 'fulfillmentSlaSeconds',
    'costAmount', 'orderWindows',
  ]);
  if (Object.keys(snapshot).some((key) => topLevel.has(key))) {
    throw new CatalogRequestError('productSnapshot只能保存图片、描述等展示信息，经营字段必须使用强类型字段');
  }
  const nestedKeys = new Set([
    'enabled', 'minimumPartySize', 'maximumPartySize', 'priority', 'sceneTags',
    'intentTags', 'tasteTags', 'dwellTags', 'singleWaveEligible',
    'expectedPrepMinutes', 'holdMinutes', 'upgradeProductId',
  ]);
  for (const key of ['recommendation', 'source']) {
    const nested = snapshot[key];
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      && Object.keys(nested).some((entry) => nestedKeys.has(entry) || topLevel.has(entry))) {
      throw new CatalogRequestError('productSnapshot中的经营字段已停用，请改用强类型字段');
    }
  }
}

function assertActiveProductCost(status: ProductStatus, costAmountMinor: number | null): void {
  if (status === "active" && costAmountMinor === null) {
    throw new CatalogRequestError("在售商品必须配置成本金额；未知成本请先保存为停用，避免错误经营归因");
  }
}

function readStandardPrice(value: unknown): StandardPriceInput {
  const body = readJsonObject(value, "请求正文");
  const amountMinor = readInteger(
    body.amountMinor,
    "amountMinor",
    0,
    100_000_000,
  );
  const currency =
    body.currency === undefined
      ? "CNY"
      : requiredText(body.currency, "currency", 3);
  if (!/^[A-Z]{3}$/.test(currency))
    throw new CatalogRequestError("currency必须是3位大写货币代码");
  return {
    amountMinor,
    currency,
    reason: requiredText(body.reason, "reason", 500),
  };
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (Array.isArray(value) || typeof value !== "string") {
    throw new CatalogRequestError("缺少Idempotency-Key请求头");
  }
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(normalized)) {
    throw new CatalogRequestError("Idempotency-Key格式无效");
  }
  return normalized;
}

function readStation(value: JsonValue | undefined): FulfillmentStation {
  if (
    value === "bar" ||
    value === "kitchen" ||
    value === "cashier" ||
    value === "none"
  )
    return value;
  throw new CatalogRequestError("fulfillmentStation无效");
}

function readProductKind(value: JsonValue | undefined): ProductKind {
  if (value === undefined || value === "single") return "single";
  if (value === "bundle") return value;
  throw new CatalogRequestError("productKind无效");
}

function readInventoryControlMode(value: JsonValue | undefined): InventoryControlMode {
  if (value === "tracked" || value === "not_managed") return value;
  throw new CatalogRequestError("inventoryControlMode无效");
}

function readBundleComponents(
  value: JsonValue | undefined,
  required: boolean,
): BundleComponentInput[] {
  if (value === undefined) {
    if (required) throw new CatalogRequestError("组合商品至少需要一个组成单品");
    return [];
  }
  if (!Array.isArray(value) || value.length > 50) {
    throw new CatalogRequestError("bundleComponents必须是最多50项的数组");
  }
  const seen = new Set<string>();
  const components = value.map((item, index) => {
    const component = readRecord(item, `bundleComponents[${index}]`);
    const productId = readUuid(component.productId, `bundleComponents[${index}].productId`);
    if (seen.has(productId)) {
      throw new CatalogRequestError("同一个组成单品不能重复添加");
    }
    seen.add(productId);
    return {
      productId,
      quantity: readInteger(component.quantity, `bundleComponents[${index}].quantity`, 1, 999),
      sortOrder: optionalInteger(component.sortOrder, `bundleComponents[${index}].sortOrder`, 0, 10_000)
        ?? (index + 1) * 10,
      note: optionalText(component.note, `bundleComponents[${index}].note`, 500),
    };
  });
  if (required && components.length === 0) {
    throw new CatalogRequestError("组合商品至少需要一个组成单品");
  }
  return components;
}

function readStatus(value: unknown, allowAll: true): ProductStatus | "all";
function readStatus(value: unknown, allowAll: false): ProductStatus;
function readStatus(value: unknown, allowAll: boolean): ProductStatus | "all" {
  if (value === "active" || value === "sold_out" || value === "inactive")
    return value;
  if (allowAll && value === "all") return value;
  throw new CatalogRequestError("status无效");
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogRequestError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function readJsonObject(value: unknown, label: string): JsonObject {
  const record = readRecord(value, label);
  if (!isJsonValue(record))
    throw new CatalogRequestError(`${label}包含无效JSON值`);
  return record;
}

function optionalJsonObject(value: JsonValue | undefined): JsonObject {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogRequestError("productSnapshot必须是JSON对象");
  }
  return value;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string")
    throw new CatalogRequestError(`${label}必须是字符串`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new CatalogRequestError(`${label}长度必须为1到${maximum}个字符`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, label, maximum);
}

function requiredCode(value: unknown, label: string): string {
  const code = requiredText(value, label, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(code)) {
    throw new CatalogRequestError(`${label}格式无效`);
  }
  return code;
}

function optionalCode(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredCode(value, label);
}

function readInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    !Number.isSafeInteger(parsed) ||
    (parsed as number) < minimum ||
    (parsed as number) > maximum
  ) {
    throw new CatalogRequestError(`${label}必须是${minimum}到${maximum}的整数`);
  }
  return parsed as number;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  return readInteger(value, label, minimum, maximum);
}

function readUuid(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new CatalogRequestError(`${label}格式无效`);
  assertUuid(value, label);
  return value;
}

function assertUuid(value: string, label: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new CatalogRequestError(`${label}格式无效`);
  }
}

function requiredProduct(row: ProductRow | undefined): ProductRow {
  if (row === undefined) throw new CatalogProductNotFoundError();
  return row;
}

function readStoredBundleComponents(value: JsonValue): BundleComponent[] {
  if (!Array.isArray(value)) throw new TypeError("Stored bundle components are invalid");
  return value.map((item) => {
    if (!isJsonObject(item)) throw new TypeError("Stored bundle component is invalid");
    if (
      typeof item.productId !== "string" ||
      typeof item.code !== "string" ||
      typeof item.name !== "string" ||
      !Number.isSafeInteger(item.quantity) ||
      !Number.isSafeInteger(item.sortOrder) ||
      (item.note !== null && typeof item.note !== "string")
    ) {
      throw new TypeError("Stored bundle component is invalid");
    }
    return {
      productId: item.productId,
      code: item.code,
      name: item.name,
      quantity: item.quantity as number,
      sortOrder: item.sortOrder as number,
      note: item.note,
    };
  });
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    isJsonValue(value) &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function catalogProductToJson(product: CatalogProduct): JsonObject {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    categoryCode: product.categoryCode,
    fulfillmentStation: product.fulfillmentStation,
    productKind: product.productKind,
    inventoryControlMode: product.inventoryControlMode,
    bundleComponents: product.bundleComponents.map((component) => ({ ...component })),
    productSnapshot: product.productSnapshot,
    guestVisible: product.guestVisible,
    searchText: product.searchText,
    recommendationEnabled: product.recommendationEnabled,
    recommendationMinGuests: product.recommendationMinGuests,
    recommendationMaxGuests: product.recommendationMaxGuests,
    recommendationPriority: product.recommendationPriority,
    recommendationSceneTags: product.recommendationSceneTags,
    recommendationIntentTags: product.recommendationIntentTags,
    recommendationTasteTags: product.recommendationTasteTags,
    recommendationDwellTags: product.recommendationDwellTags,
    recommendationSingleWaveEligible: product.recommendationSingleWaveEligible,
    recommendationExpectedPrepMinutes: product.recommendationExpectedPrepMinutes,
    recommendationHoldMinutes: product.recommendationHoldMinutes,
    recommendationUpgradeProductId: product.recommendationUpgradeProductId,
    menuSortOrder: product.menuSortOrder,
    availableFrom: product.availableFrom,
    availableUntil: product.availableUntil,
    allowedChannels: product.allowedChannels,
    maxOrderQuantity: product.maxOrderQuantity,
    kdsPriority: product.kdsPriority,
    fulfillmentSlaSeconds: product.fulfillmentSlaSeconds,
    costAmountMinor: product.costAmountMinor ?? null,
    status: product.status,
    isAvailable: product.isAvailable,
    inventoryConfigurationComplete: product.inventoryConfigurationComplete,
    inventoryAvailable: product.inventoryAvailable,
    standardPrice:
      product.standardPrice === null ? null : { ...product.standardPrice },
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

const catalogProductCodec: JsonCodec<CatalogProduct> = {
  encode: catalogProductToJson,
  decode(value: unknown): CatalogProduct {
    if (!isJsonObject(value))
      throw new TypeError("Stored catalog product is invalid");
    const requiredStrings = [
      "id",
      "code",
      "name",
      "categoryCode",
      "fulfillmentStation",
      "productKind",
      "inventoryControlMode",
      "status",
      "createdAt",
      "updatedAt",
    ];
    if (requiredStrings.some((field) => typeof value[field] !== "string")) {
      throw new TypeError("Stored catalog product is invalid");
    }
    if (
      typeof value.isAvailable !== "boolean" ||
      typeof value.inventoryConfigurationComplete !== "boolean" ||
      typeof value.inventoryAvailable !== "boolean" ||
      (value.inventoryControlMode !== "tracked" && value.inventoryControlMode !== "not_managed") ||
      typeof value.guestVisible !== "boolean" ||
      typeof value.searchText !== "string" ||
      typeof value.recommendationEnabled !== "boolean" ||
      typeof value.recommendationSingleWaveEligible !== "boolean" ||
      !isJsonObject(value.productSnapshot) ||
      !Array.isArray(value.bundleComponents)
    ) {
      throw new TypeError("Stored catalog product is invalid");
    }
    const numberFields = [
      "recommendationMinGuests", "recommendationMaxGuests", "recommendationPriority",
      "recommendationExpectedPrepMinutes", "recommendationHoldMinutes", "menuSortOrder",
      "maxOrderQuantity", "kdsPriority",
    ];
    const stringArrayFields = [
      "recommendationSceneTags", "recommendationIntentTags", "recommendationTasteTags",
      "recommendationDwellTags", "allowedChannels",
    ];
    if (numberFields.some((field) => !Number.isSafeInteger(value[field]))
      || stringArrayFields.some((field) => !Array.isArray(value[field])
        || (value[field] as JsonValue[]).some((entry) => typeof entry !== "string"))
      || !nullableString(value.recommendationUpgradeProductId)
      || !nullableString(value.availableFrom)
      || !nullableString(value.availableUntil)
      || !nullableSafeInteger(value.fulfillmentSlaSeconds)
      || !nullableSafeInteger(value.costAmountMinor)) {
      throw new TypeError("Stored catalog product is invalid");
    }
    return value as unknown as CatalogProduct;
  },
};

function nullableString(value: JsonValue | undefined): boolean {
  return value === null || typeof value === "string";
}

function nullableSafeInteger(value: JsonValue | undefined): boolean {
  return value === null || Number.isSafeInteger(value);
}

function executionResponse(execution: CommandExecution<CatalogProduct>) {
  return { data: execution.value, meta: { replayed: execution.replayed } };
}

async function handleRoute(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    return sendError(reply, error);
  }
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CatalogRequestError || error instanceof TypeError) {
    return apiError(reply, 400, "CATALOG_REQUEST_INVALID", error.message);
  }
  if (error instanceof NormalizedAuthenticationRequiredError) {
    return apiError(
      reply,
      401,
      "AUTH_REQUIRED",
      "登录信息无效或已过期，请重新登录",
    );
  }
  if (
    error instanceof StaffAccessDeniedError ||
    error instanceof StaffNotFoundError
  ) {
    return apiError(
      reply,
      403,
      "CATALOG_PERMISSION_DENIED",
      "当前员工没有所需的商品或价格配置权限",
    );
  }
  if (
    error instanceof TrustedStoreScopeError ||
    error instanceof NormalizedStoreUnavailableError
  ) {
    return apiError(
      reply,
      403,
      "STORE_SCOPE_FORBIDDEN",
      "当前门店不可用或设备未绑定",
    );
  }
  if (error instanceof CatalogProductNotFoundError) {
    return apiError(reply, 404, "CATALOG_PRODUCT_NOT_FOUND", error.message);
  }
  if (error instanceof IdempotencyConflictError) {
    return apiError(
      reply,
      409,
      "IDEMPOTENCY_CONFLICT",
      "该请求编号已用于不同内容，请重新提交",
    );
  }
  if (error instanceof IdempotencyInProgressError) {
    return apiError(
      reply,
      409,
      "IDEMPOTENCY_IN_PROGRESS",
      "相同请求正在处理中，请稍后查看结果",
    );
  }
  if (error instanceof IdempotencyRecordError) {
    return apiError(
      reply,
      500,
      "IDEMPOTENCY_STORAGE_ERROR",
      "请求处理记录异常，请稍后重试",
    );
  }
  if (error instanceof OutboxMessageConflictError) {
    return apiError(
      reply,
      409,
      "CATALOG_EVENT_CONFLICT",
      "商品变更事件发生冲突，请刷新后重试",
    );
  }
  if (isSerializationFailure(error) || isDeadlockFailure(error)) {
    return apiError(
      reply,
      409,
      "CATALOG_RETRY_REQUIRED",
      "商品资料正在被其他人修改，请刷新后重试",
    );
  }
  if (isExclusionViolation(error)) {
    return apiError(
      reply,
      409,
      "CATALOG_PRICE_OVERLAP",
      "商品价格有效期发生重叠",
    );
  }
  if (error instanceof CatalogConflictError || isUniqueViolation(error)) {
    return apiError(
      reply,
      409,
      "CATALOG_CONFLICT",
      error instanceof CatalogConflictError
        ? error.message
        : "商品编码或价格版本发生冲突",
    );
  }
  reply.log.error({ err: error }, "normalized catalog API failed");
  return apiError(reply, 500, "INTERNAL_ERROR", "系统暂时无法处理，请稍后重试");
}

function databaseErrorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function isUniqueViolation(error: unknown): boolean {
  return databaseErrorCode(error) === "23505";
}

function isExclusionViolation(error: unknown): boolean {
  return databaseErrorCode(error) === "23P01";
}

function isSerializationFailure(error: unknown): boolean {
  return databaseErrorCode(error) === "40001";
}

function isDeadlockFailure(error: unknown): boolean {
  return databaseErrorCode(error) === "40P01";
}

function apiError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.code(statusCode).send(body);
}
