import { createHash, randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type {
  CommandExecution,
  JsonCodec,
  JsonObject,
  JsonValue,
  NormalizedCommandExecutor,
} from "./command-executor.js";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
} from "./command-executor.js";
import type {
  InventoryDashboard,
  InventoryQueryService,
} from "./inventory-query-service.js";
import { assertInventoryPermission } from './inventory-query-service.js';
import type {
  CreateInventoryItemInput,
  CreatePurchaseReceiptInput,
  InventoryItemRecord,
  PurchaseReceiptLineInput,
  PurchaseReceiptRecord,
  ReplaceRecipeInput,
  StockCountLineInput,
  StockCountRecord,
  StoredBottleRecord,
  AppliedRecipeCost,
} from "./inventory-repository.js";
import {
  InsufficientInventoryError,
  InventoryConflictError,
  InventoryNotFoundError,
  InventoryRepository,
} from "./inventory-repository.js";
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
import type { ScopedTransaction } from "./transaction-runner.js";

export interface InventoryApiOptions {
  commands: Pick<NormalizedCommandExecutor, "execute">;
  query: Pick<InventoryQueryService, "getDashboard" | "getActiveRecipe" | "getRecipeCostPreview">;
  resolveContext(
    request: FastifyRequest,
  ):
    | Promise<NormalizedOperationsRequestContext>
    | NormalizedOperationsRequestContext;
  createInventoryRepository?(
    transaction: ScopedTransaction,
  ): InventoryRepository;
  createStaffAccessRepository?(
    transaction: ScopedTransaction,
  ): StaffAccessRepository;
  createPublicId?(kind: "receipt" | "stock-count" | "stored-bottle"): string;
}

interface ReceiveAndPublishProductResult {
  id: string;
  receiptPublicId: string;
  receiptStatus: "received";
  productId: string;
  productName: string;
  productStatus: "active";
  salesSpecificationType: string;
  publishedAt: string;
  recipeCostVersionId: string;
  costAmountMinor: number;
  standardPriceMinor: number;
  grossProfitMinor: number;
}

interface ReceiveAndPublishPreviewResult {
  id: string;
  receiptId: string;
  productId: string;
  productName: string;
  salesSpecificationType: string;
  recipeId: string;
  recipeVersion: number;
  yieldQuantity: number;
  costAmountMinor: number;
  standardPriceMinor: number;
  grossProfitMinor: number;
  marginBasisPoints: number;
  sellableServings: number;
  guestVisible: boolean;
  allowedChannels: string[];
  components: Array<{
    inventoryItemId: string;
    itemName: string;
    baseUnit: string;
    totalAvailableAfterReceipt: string;
    incomingQuantity: string;
    perServingDeduction: string;
    sourceUnitCostMinor: string;
    perServingCostMinor: string;
  }>;
}

interface PublishProductRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  product_kind: string;
  sales_specification_type: string;
  inventory_control_mode: string;
  guest_visible: boolean;
  allowed_channels: string[];
  cost_amount_minor: string | null;
  has_price: boolean;
  updated_at: string;
}

interface PublishRecipeRow extends Record<string, unknown> {
  id: string;
  yield_quantity: number;
  component_count: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

export const inventoryApiPlugin: FastifyPluginAsync<
  InventoryApiOptions
> = async (app, options) => {
  const createInventory =
    options.createInventoryRepository ??
    ((transaction) => new InventoryRepository(transaction));
  const createPublicId =
    options.createPublicId ?? ((kind) => `${kind}-${randomUUID()}`);

  app.get("/inventory", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveContext(request);
      const data = await options.query.getDashboard(
        context.scope,
        context.employeeId,
      );
      return reply.send({ data });
    }),
  );

  app.get<{ Params: { productId: string } }>(
    "/inventory/products/:productId/recipe",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await options.resolveContext(request);
        const productId = readUuid(request.params.productId, "productId");
        const data = await options.query.getActiveRecipe(
          context.scope,
          context.employeeId,
          productId,
        );
        return reply.send({ data });
      }),
  );

  app.get<{ Params: { productId: string } }>(
    "/inventory/products/:productId/recipe-cost",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await options.resolveContext(request);
        const data = await options.query.getRecipeCostPreview(
          context.scope, context.employeeId, readUuid(request.params.productId, 'productId'),
        );
        return reply.send({ data });
      }),
  );

  app.post("/inventory/items", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveContext(request);
      const body = readObject(request.body);
      const input = readInventoryItem(body);
      const execution = await execute(
        options,
        context,
        request,
        "inventory.item.create",
        "inventory.manage",
        inventoryItemCodec,
        async (transaction) => createInventory(transaction).createItem(input),
      );
      return reply
        .code(execution.replayed ? 200 : 201)
        .send(response(execution));
    }),
  );

  app.post<{ Params: { itemId: string } }>(
    "/inventory/items/:itemId/barcodes",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await options.resolveContext(request);
        const itemId = readUuid(request.params.itemId, "itemId");
        const body = readObject(request.body);
        const resultCodec = codec<{ id: string; replayed: boolean }>();
        const execution = await execute(
          options,
          context,
          request,
          "inventory.barcode.bind",
          "inventory.manage",
          resultCodec,
          async (transaction) =>
            createInventory(transaction).bindBarcode({
              inventoryItemId: itemId,
              code: readString(body.code, "code", 128),
              codeType: readEnum(body.codeType ?? "barcode", "codeType", [
                "barcode",
                "qr",
                "internal",
              ]),
              packageQuantity: readDecimal(
                body.packageQuantity ?? "1",
                "packageQuantity",
                false,
              ),
              employeeId: context.employeeId,
            }),
        );
        return reply.send(response(execution));
      }),
  );

  app.put<{ Params: { productId: string } }>(
    "/inventory/products/:productId/recipe",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await options.resolveContext(request);
        const body = readObject(request.body);
        const components = readArray(body.components, "components", 100).map(
          (raw) => {
            const component = readObject(raw);
            return {
              inventoryItemId: readUuid(
                component.inventoryItemId,
                "inventoryItemId",
              ),
              quantity: readDecimal(component.quantity, "quantity", false),
              expectedWasteQuantity: readDecimal(
                component.expectedWasteQuantity ?? "0",
                "expectedWasteQuantity",
                true,
              ),
            };
          },
        );
        const input: ReplaceRecipeInput = {
          productId: readUuid(request.params.productId, "productId"),
          yieldQuantity: readInteger(
            body.yieldQuantity ?? 1,
            "yieldQuantity",
            1,
            1000,
          ),
          instructionsSnapshot: readJsonObject(
            body.instructionsSnapshot ?? {},
            "instructionsSnapshot",
          ),
          components,
        };
        const execution = await execute(
          options,
          context,
          request,
          "inventory.recipe.replace",
          "inventory.manage",
          codec<{ id: string; version: number }>(),
          async (transaction) =>
            createInventory(transaction).replaceActiveRecipe(input),
        );
        return reply.send(response(execution));
      }),
  );

  app.post<{ Params: { productId: string } }>(
    "/inventory/products/:productId/recipe-cost/apply",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await options.resolveContext(request);
        const body = readObject(request.body);
        const productId = readUuid(request.params.productId, 'productId');
        const execution = await execute(
          options, context, request, 'inventory.recipe.cost.apply', 'catalog.product.manage',
          codec<AppliedRecipeCost>(), async (transaction, permissions) => {
            assertInventoryPermission(permissions, 'inventory.cost.view');
            return createInventory(transaction).applyRecipeCost(
              productId, context.employeeId, readString(body.reason, 'reason', 500),
            );
          },
        );
        return reply.send(response(execution));
      }),
  );

  app.post("/inventory/receipts", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveContext(request);
      const body = readObject(request.body);
      const pendingLines = readArray(body.lines, "lines", 200).map((raw) => {
        const line = readObject(raw);
        const inventoryItemId = readOptionalUuid(
          line.inventoryItemId,
          "inventoryItemId",
        );
        const scanCode = readOptionalString(line.scanCode, "scanCode", 128);
        if ((inventoryItemId === null) === (scanCode === null)) {
          throw new InventoryRequestError(
            "每条收货明细必须且只能提供inventoryItemId或scanCode",
          );
        }
        if (scanCode !== null && line.quantity !== undefined) {
          throw new InventoryRequestError(
            "扫码收货数量必须由已绑定包装量和packages计算",
          );
        }
        if (scanCode !== null && line.unitCostMinor !== undefined) {
          throw new InventoryRequestError(
            "扫码收货单位成本必须由totalCostMinor和实际数量计算",
          );
        }
        if (inventoryItemId !== null && line.quantity === undefined) {
          throw new InventoryRequestError(
            "按物料收货必须提供quantity",
          );
        }
        return {
          inventoryItemId,
          scanCode,
          batchCode: readString(line.batchCode, "batchCode", 128),
          quantity:
            line.quantity === undefined
              ? null
              : readDecimal(line.quantity, "quantity", false),
          packages:
            line.packages === undefined
              ? "1"
              : readDecimal(line.packages, "packages", false),
          unitCostMinor:
            line.unitCostMinor === undefined
              ? null
              : readDecimal(line.unitCostMinor, "unitCostMinor", true),
          totalCostMinor: readIntegerString(
            line.totalCostMinor,
            "totalCostMinor",
          ),
          expiresOn: readOptionalDate(line.expiresOn, "expiresOn"),
          metadata: readJsonObject(line.metadata ?? {}, "metadata"),
        };
      });
      const input: CreatePurchaseReceiptInput = {
        publicId: createPublicId("receipt"),
        employeeId: context.employeeId,
        lines: [],
        supplierRef: readOptionalString(body.supplierRef, "supplierRef", 128),
        supplierSnapshot: readJsonObject(
          body.supplierSnapshot ?? {},
          "supplierSnapshot",
        ),
        currency: readCurrency(body.currency ?? "CNY"),
        invoiceTotalMinor:
          body.invoiceTotalMinor === undefined
            ? null
            : readIntegerString(body.invoiceTotalMinor, "invoiceTotalMinor"),
        note: readOptionalString(body.note, "note", 1000),
      };
      const execution = await execute(
        options,
        context,
        request,
        "inventory.receipt.create",
        "inventory.receive",
        receiptCodec,
        async (transaction) => {
          const repository = createInventory(transaction);
          const lines: PurchaseReceiptLineInput[] = [];
          for (const line of pendingLines) {
            const barcode =
              line.scanCode === null
                ? null
                : await repository.resolveBarcode(line.scanCode);
            lines.push({
              inventoryItemId: line.inventoryItemId ?? barcode!.inventoryItemId,
              batchCode: line.batchCode,
              quantity:
                line.quantity ??
                multiplyDecimal(barcode!.packageQuantity, line.packages),
              unitCostMinor: line.unitCostMinor,
              totalCostMinor: line.totalCostMinor,
              expiresOn: line.expiresOn,
              metadata: line.metadata,
            });
          }
          return repository.createPurchaseReceipt({ ...input, lines });
        },
      );
      return reply
        .code(execution.replayed ? 200 : 201)
        .send(response(execution));
    }),
  );

  app.post<{ Params: { receiptId: string } }>(
    "/inventory/receipts/:receiptId/receive",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await options.resolveContext(request);
        const receiptId = readUuid(request.params.receiptId, "receiptId");
        const execution = await execute(
          options,
          context,
          request,
          "inventory.receipt.receive",
          "inventory.receive",
          receiptCodec,
          async (transaction) =>
            createInventory(transaction).receivePurchaseReceipt(
              receiptId,
              context.employeeId,
            ),
        );
        return reply.send(response(execution));
      }),
  );

  app.post<{ Params: { receiptId: string } }>(
    "/inventory/receipts/:receiptId/receive-and-publish-preview",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await options.resolveContext(request);
        const receiptId = readUuid(request.params.receiptId, "receiptId");
        const body = readObject(request.body);
        const productId = readUuid(body.productId, "productId");
        const execution = await execute(
          options, context, request, "inventory.receipt.receive-and-publish-preview",
          "inventory.receive", codec<ReceiveAndPublishPreviewResult>(),
          async (transaction, permissions) => {
            assertInventoryPermission(permissions, "catalog.product.manage");
            assertInventoryPermission(permissions, "inventory.cost.view");
            return previewReceiveAndPublishProduct(
              transaction, createInventory(transaction), receiptId, productId,
            );
          },
        );
        return reply.send(response(execution));
      }),
  );

  app.post<{ Params: { receiptId: string } }>(
    "/inventory/receipts/:receiptId/receive-and-publish",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await options.resolveContext(request);
        const receiptId = readUuid(request.params.receiptId, "receiptId");
        const body = readObject(request.body);
        const productId = readUuid(body.productId, "productId");
        const execution = await execute(
          options,
          context,
          request,
          "inventory.receipt.receive-and-publish",
          "inventory.receive",
          codec<ReceiveAndPublishProductResult>(),
          async (transaction, permissions) => {
            assertInventoryPermission(permissions, "catalog.product.manage");
            assertInventoryPermission(permissions, "inventory.cost.view");
            return receiveAndPublishProduct(
              transaction,
              createInventory(transaction),
              receiptId,
              productId,
              context.employeeId,
            );
          },
        );
        return reply.send(response(execution));
      }),
  );

  app.post("/inventory/stock-counts", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveContext(request);
      const body = readObject(request.body);
      const lines: StockCountLineInput[] = readArray(
        body.lines,
        "lines",
        500,
      ).map((raw) => {
        const line = readObject(raw);
        return {
          inventoryItemId: readUuid(line.inventoryItemId, "inventoryItemId"),
          countedQuantity: readDecimal(
            line.countedQuantity,
            "countedQuantity",
            true,
          ),
          reason: readOptionalString(line.reason, "reason", 500),
        };
      });
      const publicId = createPublicId("stock-count");
      const execution = await execute(
        options,
        context,
        request,
        "inventory.stock-count.create",
        "inventory.count",
        stockCountCodec,
        async (transaction) =>
          createInventory(transaction).createStockCount(
            publicId,
            context.employeeId,
            lines,
            readOptionalString(body.note, "note", 1000),
          ),
      );
      return reply
        .code(execution.replayed ? 200 : 201)
        .send(response(execution));
    }),
  );

  for (const transition of ["submit", "approve", "reject"] as const) {
    app.post<{ Params: { countId: string } }>(
      `/inventory/stock-counts/:countId/${transition}`,
      async (request, reply) =>
        handleRoute(reply, async () => {
          const context = await options.resolveContext(request);
          const countId = readUuid(request.params.countId, "countId");
          const permission =
            transition === "submit"
              ? "inventory.count"
              : "inventory.count.approve";
          const execution = await execute(
            options,
            context,
            request,
            `inventory.stock-count.${transition}`,
            permission,
            stockCountCodec,
            async (transaction) => {
              const repository = createInventory(transaction);
              if (transition === "approve")
                return repository.approveStockCount(
                  countId,
                  context.employeeId,
                );
              if (transition === "reject") {
                const body = readObject(request.body);
                return repository.rejectStockCount(
                  countId,
                  context.employeeId,
                  readString(body.reason, "reason", 1000),
                );
              }
              return repository.submitStockCount(countId, context.employeeId);
            },
          );
          return reply.send(response(execution));
        }),
    );
  }

  app.post<{ Params: { itemId: string } }>(
    "/inventory/items/:itemId/waste",
    async (request, reply) =>
      handleRoute(reply, async () => {
        const context = await options.resolveContext(request);
        const body = readObject(request.body);
        const itemId = readUuid(request.params.itemId, "itemId");
        const execution = await execute(
          options,
          context,
          request,
          "inventory.waste.record",
          "inventory.waste",
          codec<{ movementId: string; remainingQuantity: string }>(),
          async (transaction, permissions) =>
            createInventory(transaction).recordWaste(
              itemId,
              readDecimal(body.quantity, "quantity", false),
              context.employeeId,
              readString(body.reason, "reason", 500),
              permissions.includes("inventory.count.approve"),
            ),
        );
        return reply.send(response(execution));
      }),
  );

  app.post("/inventory/stored-bottles", async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveContext(request);
      const body = readObject(request.body);
      const tableSessionId = readUuid(body.tableSessionId, "tableSessionId");
      const publicId = createPublicId("stored-bottle");
      const execution = await executeBottleCommand(
        options,
        context,
        request,
        createInventory,
        "inventory.bottle.store",
        [tableSessionId],
        async (repository) =>
          repository.storeBottle({
            publicId,
            inventoryItemId: readUuid(body.inventoryItemId, "inventoryItemId"),
            tableSessionId,
            quantity: readDecimal(body.quantity, "quantity", false),
            employeeId: context.employeeId,
            customerId: readOptionalUuid(body.customerId, "customerId"),
            holderDisplayName: readOptionalString(
              body.holderDisplayName,
              "holderDisplayName",
              200,
            ),
            holderContactToken: readOptionalString(
              body.holderContactToken,
              "holderContactToken",
              256,
            ),
            sourceReceiptLineId: readOptionalUuid(
              body.sourceReceiptLineId,
              "sourceReceiptLineId",
            ),
            expiresAt: readOptionalTimestamp(body.expiresAt, "expiresAt"),
          }),
      );
      return reply
        .code(execution.replayed ? 200 : 201)
        .send(response(execution));
    }),
  );

  for (const action of ["use", "transfer", "void"] as const) {
    app.post<{ Params: { bottleId: string } }>(
      `/inventory/stored-bottles/:bottleId/${action}`,
      async (request, reply) =>
        handleRoute(reply, async () => {
          const context = await options.resolveContext(request);
          const body = readObject(request.body);
          const bottleId = readUuid(request.params.bottleId, "bottleId");
          const execution = await executeBottleMutation(
            options,
            context,
            request,
            createInventory,
            bottleId,
            action,
            body,
          );
          return reply.send(response(execution));
        }),
    );
  }
};

async function receiveAndPublishProduct(
  transaction: ScopedTransaction,
  inventory: InventoryRepository,
  receiptId: string,
  productId: string,
  employeeId: string,
): Promise<ReceiveAndPublishProductResult> {
  const receipt = await inventory.receivePurchaseReceipt(receiptId, employeeId);
  const appliedCost = await inventory.applyRecipeCost(
    productId, employeeId, "确认入库并发布：按本次收货后最新正式配方成本重新核算",
  );
  const productResult = await transaction.query<PublishProductRow>(`
    SELECT product.id,product.name,product.status,product.product_kind,
      COALESCE(NULLIF(product.product_snapshot->>'salesSpecificationType',''),'custom') AS sales_specification_type,
      product.inventory_control_mode,product.guest_visible,product.allowed_channels,
      product.cost_amount_minor::text,product.updated_at::text,
      EXISTS (
        SELECT 1 FROM mbox.product_prices price
        JOIN mbox.stores store
          ON store.tenant_id=product.tenant_id AND store.id=product.store_id
        WHERE price.tenant_id=product.tenant_id AND price.store_id=product.store_id
          AND price.product_id=product.id AND price.price_type='standard'
          AND price.currency=store.currency AND price.amount_minor>0
          AND price.valid_from<=clock_timestamp()
          AND (price.valid_until IS NULL OR price.valid_until>clock_timestamp())
      ) AS has_price
    FROM mbox.products product
    WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
      AND product.id=$3::uuid
    FOR UPDATE OF product
  `, [transaction.scope.tenantId, transaction.scope.storeId, productId]);
  const product = productResult.rows[0];
  if (product === undefined) throw new InventoryNotFoundError("product", productId);
  if (product.product_kind !== "single" || product.inventory_control_mode !== "tracked") {
    throw new InventoryConflictError("确认入库并发布上架只适用于跟踪库存的酒水单品");
  }
  if (!product.guest_visible || !product.allowed_channels.includes("guest_qr")
    || !product.allowed_channels.includes("staff_assisted")) {
    throw new InventoryConflictError("请先开放顾客扫码和员工协助点单渠道，并设为顾客菜单可见");
  }
  if (!product.has_price) throw new InventoryConflictError("请先设置当前有效且大于0的标准售价");
  if (product.cost_amount_minor === null || Number(product.cost_amount_minor)!==appliedCost.costAmountMinor) {
    throw new InventoryConflictError("本次收货成本未能成为当前商品成本");
  }

  const recipeResult = await transaction.query<PublishRecipeRow>(`
    SELECT recipe.id,recipe.yield_quantity,
      (SELECT count(*)::text FROM mbox.recipe_items component
       WHERE component.tenant_id=recipe.tenant_id AND component.store_id=recipe.store_id
         AND component.recipe_id=recipe.id) AS component_count
    FROM mbox.recipes recipe
    WHERE recipe.tenant_id=$1::uuid AND recipe.store_id=$2::uuid
      AND recipe.product_id=$3::uuid AND recipe.status='active'
      AND recipe.effective_at<=clock_timestamp()
    ORDER BY recipe.version DESC
    LIMIT 1
    FOR UPDATE OF recipe
  `, [transaction.scope.tenantId, transaction.scope.storeId, productId]);
  const recipe = recipeResult.rows[0];
  if (recipe === undefined || Number(recipe.component_count) < 1) {
    throw new InventoryConflictError("请先保存包含正数用量的库存扣减配方");
  }
  const componentResult = await transaction.query<{
    inventory_item_id: string;
    active: boolean;
    insufficient: boolean;
  }>(`
    SELECT component.inventory_item_id,item.status='active' AS active,
      balance.on_hand_quantity-balance.reserved_quantity
        < ((component.quantity+component.expected_waste_quantity)/$4::numeric) AS insufficient
    FROM mbox.recipe_items component
    JOIN mbox.inventory_items item
      ON item.tenant_id=component.tenant_id AND item.store_id=component.store_id
     AND item.id=component.inventory_item_id
    JOIN mbox.inventory_balances balance
      ON balance.tenant_id=component.tenant_id AND balance.store_id=component.store_id
     AND balance.inventory_item_id=component.inventory_item_id
    WHERE component.tenant_id=$1::uuid AND component.store_id=$2::uuid
      AND component.recipe_id=$3::uuid
      AND component.quantity>0 AND component.expected_waste_quantity>=0
    ORDER BY component.inventory_item_id
    FOR UPDATE OF component,item,balance
  `, [transaction.scope.tenantId, transaction.scope.storeId, recipe.id, recipe.yield_quantity]);
  if (componentResult.rows.length !== Number(recipe.component_count)
    || componentResult.rows.some((component) => !component.active)) {
    throw new InventoryConflictError("配方包含失效物料、缺失库存余额或非正数用量");
  }
  if (componentResult.rows.some((component) => component.insufficient)) {
    throw new InventoryConflictError("确认入库后仍不足以制作至少1份该商品");
  }
  const receiptMatchesRecipe = await transaction.query<{ matched: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM mbox.purchase_receipt_lines line
      JOIN mbox.recipe_items component
        ON component.tenant_id=line.tenant_id AND component.store_id=line.store_id
       AND component.inventory_item_id=line.inventory_item_id
      WHERE line.tenant_id=$1::uuid AND line.store_id=$2::uuid
        AND line.receipt_id=$3::uuid AND component.recipe_id=$4::uuid
    ) AS matched
  `, [transaction.scope.tenantId, transaction.scope.storeId, receiptId, recipe.id]);
  if (receiptMatchesRecipe.rows[0]?.matched !== true) {
    throw new InventoryConflictError("所选收货单不包含该酒水配方物料，不能关联发布");
  }
  const updated = await transaction.query<{ updated_at: string }>(`
    UPDATE mbox.products
    SET status='active',updated_at=CASE WHEN status='active' THEN updated_at ELSE clock_timestamp() END
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    RETURNING updated_at::text
  `, [transaction.scope.tenantId, transaction.scope.storeId, productId]);
  const priceResult=await transaction.query<{ amount_minor:string }>(`
    SELECT price.amount_minor::text
    FROM mbox.product_prices price JOIN mbox.stores store
      ON store.tenant_id=price.tenant_id AND store.id=price.store_id
    WHERE price.tenant_id=$1::uuid AND price.store_id=$2::uuid AND price.product_id=$3::uuid
      AND price.price_type='standard' AND price.currency=store.currency
      AND price.valid_from<=clock_timestamp() AND (price.valid_until IS NULL OR price.valid_until>clock_timestamp())
    ORDER BY price.valid_from DESC LIMIT 1
  `,[transaction.scope.tenantId,transaction.scope.storeId,productId]);
  const standardPriceMinor=Number(priceResult.rows[0]?.amount_minor);
  if (!Number.isSafeInteger(standardPriceMinor)||standardPriceMinor<=0) {
    throw new InventoryConflictError("当前标准售价无法核算毛利");
  }
  return {
    id: receipt.id,
    receiptPublicId: receipt.publicId,
    receiptStatus: "received",
    productId: product.id,
    productName: product.name,
    productStatus: "active",
    salesSpecificationType:product.sales_specification_type,
    publishedAt: updated.rows[0]?.updated_at ?? product.updated_at,
    recipeCostVersionId:appliedCost.id,
    costAmountMinor:appliedCost.costAmountMinor,
    standardPriceMinor,
    grossProfitMinor:standardPriceMinor-appliedCost.costAmountMinor,
  };
}

async function previewReceiveAndPublishProduct(
  transaction:ScopedTransaction,
  inventory:InventoryRepository,
  receiptId:string,
  productId:string,
):Promise<ReceiveAndPublishPreviewResult> {
  const cost=await inventory.previewRecipeCostForReceipt(productId,receiptId);
  if (cost.costAmountMinor===null) {
    throw new InventoryConflictError("本次收货或历史收货缺少配方物料单位成本");
  }
  const productResult=await transaction.query<{
    name:string;guest_visible:boolean;allowed_channels:string[];standard_price_minor:string;sales_specification_type:string
  }>(`
    SELECT product.name,product.guest_visible,product.allowed_channels,
      COALESCE(NULLIF(product.product_snapshot->>'salesSpecificationType',''),'custom') AS sales_specification_type,
      price.amount_minor::text AS standard_price_minor
    FROM mbox.products product JOIN mbox.stores store
      ON store.tenant_id=product.tenant_id AND store.id=product.store_id
    JOIN LATERAL (
      SELECT current_price.amount_minor FROM mbox.product_prices current_price
      WHERE current_price.tenant_id=product.tenant_id AND current_price.store_id=product.store_id
        AND current_price.product_id=product.id AND current_price.price_type='standard'
        AND current_price.currency=store.currency AND current_price.amount_minor>0
        AND current_price.valid_from<=clock_timestamp()
        AND (current_price.valid_until IS NULL OR current_price.valid_until>clock_timestamp())
      ORDER BY current_price.valid_from DESC LIMIT 1
    ) price ON true
    WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid AND product.id=$3::uuid
      AND product.product_kind='single' AND product.inventory_control_mode='tracked'
  `,[transaction.scope.tenantId,transaction.scope.storeId,productId]);
  const product=productResult.rows[0];
  if (!product) throw new InventoryConflictError("只能预览跟踪库存的酒水单品");
  const stock=await transaction.query<{
    inventory_item_id:string;item_name:string;base_unit:string;available_after:string;incoming_quantity:string
    per_serving_deduction:string;sellable_servings:string
  }>(`
    WITH selected_receipt AS (
      SELECT status FROM mbox.purchase_receipts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$4::uuid
    ) SELECT component.inventory_item_id,item.name AS item_name,item.base_unit,
      (balance.on_hand_quantity-balance.reserved_quantity+
        CASE WHEN receipt.status='draft' THEN COALESCE(incoming.quantity,0) ELSE 0 END)::text AS available_after,
      (CASE WHEN receipt.status='draft' THEN COALESCE(incoming.quantity,0) ELSE 0 END)::text AS incoming_quantity,
      ((component.quantity+component.expected_waste_quantity)/recipe.yield_quantity)::text AS per_serving_deduction,
      floor((balance.on_hand_quantity-balance.reserved_quantity+
        CASE WHEN receipt.status='draft' THEN COALESCE(incoming.quantity,0) ELSE 0 END)
        / NULLIF((component.quantity+component.expected_waste_quantity)/recipe.yield_quantity,0))::text AS sellable_servings
    FROM mbox.recipes recipe JOIN mbox.recipe_items component
      ON component.tenant_id=recipe.tenant_id AND component.store_id=recipe.store_id AND component.recipe_id=recipe.id
    JOIN mbox.inventory_items item ON item.tenant_id=component.tenant_id AND item.store_id=component.store_id
      AND item.id=component.inventory_item_id AND item.status='active'
    JOIN mbox.inventory_balances balance ON balance.tenant_id=component.tenant_id AND balance.store_id=component.store_id
      AND balance.inventory_item_id=component.inventory_item_id
    CROSS JOIN selected_receipt receipt
    LEFT JOIN LATERAL (
      SELECT sum(line.quantity) AS quantity FROM mbox.purchase_receipt_lines line
      WHERE line.tenant_id=component.tenant_id AND line.store_id=component.store_id
        AND line.receipt_id=$4::uuid AND line.inventory_item_id=component.inventory_item_id
    ) incoming ON true
    WHERE recipe.tenant_id=$1::uuid AND recipe.store_id=$2::uuid AND recipe.id=$3::uuid
    ORDER BY component.inventory_item_id
  `,[transaction.scope.tenantId,transaction.scope.storeId,cost.recipeId,receiptId]);
  if (stock.rows.length!==cost.components.length) {
    throw new InventoryConflictError("配方物料库存余额不完整，不能发布");
  }
  const standardPriceMinor=Number(product.standard_price_minor);
  if (!Number.isSafeInteger(standardPriceMinor)||standardPriceMinor<=0) {
    throw new InventoryConflictError("当前标准售价无法核算发布预览");
  }
  const grossProfitMinor=standardPriceMinor-cost.costAmountMinor;
  const sellableServings=Math.min(...stock.rows.map((row)=>Number(row.sellable_servings)));
  if (!Number.isSafeInteger(sellableServings)||sellableServings<0) {
    throw new InventoryConflictError("当前库存无法核算安全可售份数");
  }
  return {
    id:receiptId,receiptId,productId,productName:product.name,salesSpecificationType:product.sales_specification_type,
    recipeId:cost.recipeId,recipeVersion:cost.recipeVersion,
    yieldQuantity:cost.yieldQuantity,costAmountMinor:cost.costAmountMinor,standardPriceMinor,grossProfitMinor,
    marginBasisPoints:Math.floor(grossProfitMinor*10_000/standardPriceMinor),sellableServings,
    guestVisible:product.guest_visible,allowedChannels:product.allowed_channels,
    components:stock.rows.map((row)=>{
      const component=cost.components.find((entry)=>entry.inventoryItemId===row.inventory_item_id)!;
      return { inventoryItemId:row.inventory_item_id,itemName:row.item_name,baseUnit:row.base_unit,
        totalAvailableAfterReceipt:row.available_after,incomingQuantity:row.incoming_quantity,
        perServingDeduction:row.per_serving_deduction,sourceUnitCostMinor:component.sourceUnitCostMinor!,
        perServingCostMinor:component.componentCostMinor! };
    }),
  };
}

async function execute<Result>(
  options: InventoryApiOptions,
  context: NormalizedOperationsRequestContext,
  request: FastifyRequest,
  operationScope: string,
  permission: string,
  resultCodec: JsonCodec<Result>,
  handler: (
    transaction: ScopedTransaction,
    permissions: readonly string[],
  ) => Promise<Result>,
): Promise<CommandExecution<Result>> {
  const idempotencyKey = readIdempotencyKey(request);
  return options.commands.execute(
    {
      scope: context.scope,
      operationScope,
      idempotencyKey,
      requestFingerprint: fingerprint(request, context),
      resultCodec,
    },
    async (transaction) => {
      const access = await (
        options.createStaffAccessRepository?.(transaction) ??
        new StaffAccessRepository(transaction)
      ).assertPermission(context.employeeId, permission);
      const result = await handler(transaction, access.permissions);
      const json = resultCodec.encode(result);
      if (!isJsonObject(json))
        throw new TypeError("Inventory command result must be a JSON object");
      const objectId = readResultId(result);
      return {
        result,
        auditEvents: [
          {
            actor: { type: "employee", employeeId: context.employeeId },
            action: operationScope,
            objectType: inventoryObjectType(operationScope),
            objectId,
            businessDate: context.businessDate,
            afterData: json,
          },
        ],
        outboxMessages: [
          {
            businessEventKey: eventKey(operationScope, idempotencyKey),
            aggregateType: inventoryObjectType(operationScope),
            aggregateId: readUuid(objectId, "result.id"),
            aggregateVersion: 1,
            eventType: `${operationScope}.v1`,
            payload: json,
          },
        ],
      };
    },
  );
}

async function executeBottleCommand(
  options: InventoryApiOptions,
  context: NormalizedOperationsRequestContext,
  request: FastifyRequest,
  createInventory: (transaction: ScopedTransaction) => InventoryRepository,
  operation: string,
  tableSessionIds: readonly string[],
  handler: (repository: InventoryRepository) => Promise<StoredBottleRecord>,
): Promise<CommandExecution<StoredBottleRecord>> {
  return execute(
    options,
    context,
    request,
    operation,
    "bottle.manage",
    bottleCodec,
    async (transaction, permissions) => {
      const repository = createInventory(transaction);
      if (!permissions.includes("bottle.manage.all")) {
        for (const sessionId of tableSessionIds) {
          if (
            !(await repository.employeeHasTableResponsibility(
              context.employeeId,
              sessionId,
            ))
          ) {
            throw new StaffAccessDeniedError(
              "Employee is not assigned to this table session",
            );
          }
        }
      }
      return handler(repository);
    },
  );
}

async function executeBottleMutation(
  options: InventoryApiOptions,
  context: NormalizedOperationsRequestContext,
  request: FastifyRequest,
  createInventory: (transaction: ScopedTransaction) => InventoryRepository,
  bottleId: string,
  action: "use" | "transfer" | "void",
  body: JsonObject,
): Promise<CommandExecution<StoredBottleRecord>> {
  const destination =
    action === "transfer"
      ? readUuid(body.toTableSessionId, "toTableSessionId")
      : null;
  return execute(
    options,
    context,
    request,
    `inventory.bottle.${action}`,
    "bottle.manage",
    bottleCodec,
    async (transaction, permissions) => {
      const repository = createInventory(transaction);
      const bottle = await repository.findStoredBottle(bottleId);
      if (!bottle) throw new InventoryNotFoundError("stored bottle", bottleId);
      if (!permissions.includes("bottle.manage.all")) {
        const sessions = destination
          ? [bottle.tableSessionId, destination]
          : [bottle.tableSessionId];
        for (const sessionId of sessions) {
          if (
            !(await repository.employeeHasTableResponsibility(
              context.employeeId,
              sessionId,
            ))
          ) {
            throw new StaffAccessDeniedError(
              "Employee is not assigned to this table session",
            );
          }
        }
      }
      if (action === "use")
        return repository.useStoredBottle(
          bottleId,
          readDecimal(body.quantity, "quantity", false),
          context.employeeId,
        );
      const reason = readString(body.reason, "reason", 500);
      if (action === "transfer")
        return repository.transferStoredBottle(
          bottleId,
          destination!,
          context.employeeId,
          reason,
        );
      return repository.voidStoredBottle(bottleId, context.employeeId, reason);
    },
  );
}

function readInventoryItem(body: JsonObject): CreateInventoryItemInput {
  return {
    sku: readString(body.sku, "sku", 64),
    name: readString(body.name, "name", 200),
    itemType: readEnum(body.itemType, "itemType", [
      "ingredient",
      "bottle",
      "food",
      "packaging",
      "consumable",
      "other",
    ]),
    baseUnit: readEnum(body.baseUnit, "baseUnit", [
      "ml",
      "g",
      "piece",
      "bottle",
      "portion",
    ]),
    categoryCode: readCode(
      body.categoryCode ?? "uncategorized",
      "categoryCode",
    ),
    lowStockThreshold:
      body.lowStockThreshold === undefined
        ? null
        : readDecimal(body.lowStockThreshold, "lowStockThreshold", true),
    wholeUnitCount: readBoolean(body.wholeUnitCount ?? false, "wholeUnitCount"),
    reasonableWasteQuantity: readDecimal(
      body.reasonableWasteQuantity ?? "0",
      "reasonableWasteQuantity",
      true,
    ),
  };
}

function response<Result>(execution: CommandExecution<Result>) {
  return { data: execution.value, meta: { replayed: execution.replayed } };
}

const inventoryItemCodec = codec<InventoryItemRecord>();
const receiptCodec = codec<PurchaseReceiptRecord>();
const stockCountCodec = codec<StockCountRecord>();
const bottleCodec = codec<StoredBottleRecord>();

function codec<T>(): JsonCodec<T> {
  return {
    encode(value) {
      return value as unknown as JsonValue;
    },
    decode(value) {
      return value as T;
    },
  };
}

function fingerprint(
  request: FastifyRequest,
  context: NormalizedOperationsRequestContext,
): string {
  return JSON.stringify({
    method: request.method,
    url: request.url,
    body: request.body ?? null,
    employeeId: context.employeeId,
  });
}

function eventKey(operation: string, idempotencyKey: string): string {
  return `inventory:${createHash("sha256").update(`${operation}:${idempotencyKey}`).digest("hex")}`;
}

function inventoryObjectType(operation: string): string {
  if (operation.includes("stock-count")) return "inventory_stock_count";
  if (operation.includes("receipt")) return "purchase_receipt";
  if (operation.includes("bottle")) return "stored_bottle";
  if (operation.includes("recipe")) return "recipe";
  if (operation.includes("barcode")) return "inventory_barcode";
  if (operation.includes("waste")) return "inventory_movement";
  return "inventory_item";
}

function readResultId(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string"
  ) {
    if (
      typeof result === "object" &&
      result !== null &&
      "movementId" in result &&
      typeof result.movementId === "string"
    )
      return result.movementId;
    throw new TypeError("Inventory command result has no id");
  }
  return result.id;
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  const raw = Array.isArray(value) ? value[0] : value;
  if (
    typeof raw !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(raw)
  )
    throw new InventoryRequestError("需要有效的 Idempotency-Key");
  return raw;
}

function readObject(value: unknown): JsonObject {
  if (!isJsonObject(value))
    throw new InventoryRequestError("请求正文必须是对象");
  for (const forbidden of [
    "tenantId",
    "storeId",
    "employeeId",
    "actor",
    "permissions",
    "capabilities",
    "scope",
  ]) {
    if (Object.hasOwn(value, forbidden))
      throw new InventoryRequestError(`客户端不能指定${forbidden}`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(value: unknown, name: string): JsonObject {
  if (!isJsonObject(value))
    throw new InventoryRequestError(`${name}必须是对象`);
  return value;
}

function readArray(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max)
    throw new InventoryRequestError(`${name}数量必须为1至${max}`);
  return value;
}

function readString(value: unknown, name: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > max
  )
    throw new InventoryRequestError(`${name}无效`);
  return value.trim();
}

function readOptionalString(
  value: unknown,
  name: string,
  max: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return readString(value, name, max);
}

function readUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new InventoryRequestError(`${name}无效`);
  return value;
}

function readOptionalUuid(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return readUuid(value, name);
}

function readDecimal(value: unknown, name: string, allowZero: boolean): string {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !decimalPattern.test(raw))
    throw new InventoryRequestError(`${name}必须是最多6位小数的非负数`);
  if (!allowZero && /^0(?:\.0+)?$/.test(raw))
    throw new InventoryRequestError(`${name}必须大于0`);
  return raw;
}

function multiplyDecimal(left: string, right: string): string {
  const parse = (value: string) => {
    const [integer = "0", fraction = ""] = value.split(".");
    return BigInt(integer) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  };
  const scaled = (parse(left) * parse(right)) / 1_000_000n;
  return `${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, "0")}`;
}

function readIntegerString(value: unknown, name: string): string {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^\d+$/.test(raw))
    throw new InventoryRequestError(`${name}必须是非负整数最小货币单位`);
  return raw;
}

function readInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new InventoryRequestError(`${name}无效`);
  return value as number;
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new InventoryRequestError(`${name}必须是布尔值`);
  return value;
}

function readCode(value: unknown, name: string): string {
  const code = readString(value, name, 64);
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(code))
    throw new InventoryRequestError(`${name}格式无效`);
  return code;
}

function readCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value))
    throw new InventoryRequestError("currency无效");
  return value;
}

function readEnum<const T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new InventoryRequestError(`${name}无效`);
  return value as T;
}

function readOptionalDate(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  )
    throw new InventoryRequestError(`${name}无效`);
  return value;
}

function readOptionalTimestamp(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new InventoryRequestError(`${name}无效`);
  return value;
}

class InventoryRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryRequestError";
  }
}

async function handleRoute(
  reply: FastifyReply,
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const mapped = mapError(error);
    return reply
      .code(mapped.status)
      .send({ error: { code: mapped.code, message: mapped.message } });
  }
}

function mapError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof InventoryRequestError || error instanceof TypeError)
    return {
      status: 400,
      code: "INVENTORY_REQUEST_INVALID",
      message: error.message,
    };
  if (error instanceof NormalizedAuthenticationRequiredError)
    return {
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      message: "请先登录",
    };
  if (error instanceof StaffAccessDeniedError)
    return {
      status: 403,
      code: "INVENTORY_PERMISSION_DENIED",
      message: "当前岗位无权执行此操作或不负责该桌台",
    };
  if (error instanceof StaffNotFoundError)
    return {
      status: 403,
      code: "STAFF_NOT_ACTIVE",
      message: "当前员工账号不可用",
    };
  if (error instanceof InventoryNotFoundError)
    return {
      status: 404,
      code: "INVENTORY_NOT_FOUND",
      message: "未找到对应库存记录",
    };
  if (
    error instanceof InventoryConflictError ||
    error instanceof InsufficientInventoryError ||
    error instanceof IdempotencyConflictError ||
    error instanceof IdempotencyInProgressError
  )
    return { status: 409, code: "INVENTORY_CONFLICT", message: error.message };
  if (
    error instanceof IdempotencyRecordError ||
    error instanceof NormalizedStoreUnavailableError ||
    error instanceof TrustedStoreScopeError
  )
    return {
      status: 503,
      code: "INVENTORY_TEMPORARILY_UNAVAILABLE",
      message: "库存服务暂时不可用，请稍后重试",
    };
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "23505" ||
      error.code === "23514" ||
      error.code === "40001" ||
      error.code === "40P01")
  ) {
    return {
      status: 409,
      code: "INVENTORY_CONFLICT",
      message: "库存数据已变化或不符合盘点规则，请刷新后重试",
    };
  }
  return {
    status: 500,
    code: "INVENTORY_INTERNAL_ERROR",
    message: "库存操作未完成，请稍后重试",
  };
}

export type { InventoryDashboard };
