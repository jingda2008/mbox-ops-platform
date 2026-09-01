import type { JsonObject } from "./command-executor.js";
import type { OrderItem } from "./order-repository.js";
import type { ScopedTransaction } from "./transaction-runner.js";
import {
  isLiquidInventoryCategory,
  requiresMillilitreInventoryMigration,
} from '../../src/shared/inventory-unit-policy.js';

export interface InventoryConsumption {
  movementId: string;
  orderItemId: string;
  inventoryItemId: string;
  sku: string;
  quantity: string;
  remainingOnHandQuantity: string;
}

export interface InventoryOrderReservation {
  id: string;
  orderId: string;
  orderItemId: string;
  inventoryItemId: string;
  sku: string;
  quantity: string;
  status: "reserved" | "consumed" | "released";
  expiresAt: string | null;
}

export interface InventoryRemakeReservation {
  id: string;
  remakeTaskId: string;
  originalTaskId: string;
  orderItemId: string;
  inventoryItemId: string;
  sku: string;
  quantity: string;
  status: "reserved" | "consumed" | "released";
}

export interface ConsumeInventoryOptions {
  createdByEmployeeId?: string | null;
  reason?: string | null;
  metadata?: JsonObject;
  allowMissingRecipes?: boolean;
}

export interface InventoryItemRecord {
  id: string;
  sku: string;
  name: string;
  itemType: string;
  baseUnit: string;
  categoryCode: string;
  lowStockThreshold: string | null;
  wholeUnitCount: boolean;
  reasonableWasteQuantity: string;
  packageVolumeMl: string | null;
  status: string;
}

export interface PurchaseReceiptRecord {
  id: string;
  publicId: string;
  status: "draft" | "received" | "cancelled";
  currency: string;
  lineCount: number;
  receivedAt: string | null;
}

export interface StockCountRecord {
  id: string;
  publicId: string;
  status: "draft" | "submitted" | "approved" | "rejected";
}

export interface StoredBottleRecord {
  id: string;
  publicId: string;
  inventoryItemId: string;
  tableSessionId: string;
  originalQuantity: string;
  remainingQuantity: string;
  status: "stored" | "in_use" | "consumed" | "voided";
}

export interface CreateInventoryItemInput {
  sku: string;
  name: string;
  itemType:
    "ingredient" | "bottle" | "food" | "packaging" | "consumable" | "other";
  baseUnit: "ml" | "g" | "piece" | "bottle" | "portion";
  categoryCode: string;
  lowStockThreshold?: string | null;
  wholeUnitCount?: boolean;
  reasonableWasteQuantity?: string;
  packageVolumeMl?: string | null;
}

export interface UpdateInventoryItemInput {
  name: string;
  categoryCode: string;
  lowStockThreshold: string | null;
  packageVolumeMl: string | null;
}

export interface BindBarcodeInput {
  inventoryItemId: string;
  code: string;
  codeType?: "barcode" | "qr" | "internal";
  packageQuantity?: string;
  employeeId: string;
}

export interface RecipeComponentInput {
  inventoryItemId: string;
  quantity: string;
  expectedWasteQuantity?: string;
}

export interface ReplaceRecipeInput {
  productId: string;
  yieldQuantity: number;
  instructionsSnapshot?: JsonObject;
  components: readonly RecipeComponentInput[];
}

export interface RecipeCostComponent {
  recipeItemId: string;
  inventoryItemId: string;
  itemName: string;
  baseUnit: string;
  componentQuantity: string;
  expectedWasteQuantity: string;
  sourceReceiptLineId: string | null;
  costBasis: "receipt_line" | "moving_weighted_average" | "manual_correction";
  sourceUnitCostMinor: string | null;
  componentCostMinor: string | null;
}

export interface RecipeCostPreview {
  productId: string;
  recipeId: string;
  recipeVersion: number;
  yieldQuantity: number;
  currency: string;
  costAmountMinor: number | null;
  components: readonly RecipeCostComponent[];
}

export interface AppliedRecipeCost extends RecipeCostPreview {
  id: string;
  appliedAt: string;
}

export interface PurchaseReceiptLineInput {
  inventoryItemId: string;
  batchCode: string;
  quantity: string;
  totalCostMinor: string;
  expiresOn?: string | null;
  metadata?: JsonObject;
}

export interface CreatePurchaseReceiptInput {
  publicId: string;
  supplierRef?: string | null;
  supplierSnapshot?: JsonObject;
  currency?: string;
  invoiceTotalMinor?: string | null;
  note?: string | null;
  employeeId: string;
  lines: readonly PurchaseReceiptLineInput[];
}

export interface StockCountLineInput {
  inventoryItemId: string;
  countedQuantity: string;
  reason?: string | null;
}

interface DemandRow extends Record<string, unknown> {
  order_item_id: string;
  inventory_item_id: string;
  sku: string;
  required_quantity: string;
}

interface LockedBalanceRow extends Record<string, unknown> {
  inventory_item_id: string;
  sku: string;
  on_hand_quantity: string;
  reserved_quantity: string;
  required_quantity: string;
  insufficient: boolean;
}

interface InventoryOrderReservationRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  order_item_id: string;
  inventory_item_id: string;
  sku: string;
  quantity: string;
  status: "reserved" | "consumed" | "released";
  expires_at: string | null;
  movement_id: string | null;
}

interface InventoryRemakeReservationRow extends Record<string, unknown> {
  id: string;
  remake_task_id: string;
  original_task_id: string;
  order_item_id: string;
  inventory_item_id: string;
  sku: string;
  quantity: string;
  status: "reserved" | "consumed" | "released";
  movement_id: string | null;
}

interface InventoryItemRow extends Record<string, unknown> {
  id: string;
  sku: string;
  name: string;
  item_type: string;
  base_unit: string;
  category_code: string;
  low_stock_threshold: string | null;
  whole_unit_count: boolean;
  reasonable_waste_quantity: string;
  package_volume_ml: string | null;
  status: string;
}

interface RecipeCostRow extends Record<string, unknown> {
  recipe_id: string;
  recipe_version: number;
  yield_quantity: number;
  recipe_item_id: string;
  inventory_item_id: string;
  item_name: string;
  base_unit: string;
  component_quantity: string;
  expected_waste_quantity: string;
  source_receipt_line_id: string | null;
  cost_basis: "receipt_line" | "moving_weighted_average" | "manual_correction";
  source_unit_cost_minor: string | null;
  component_cost_minor: string | null;
}

interface ReceiptRow extends Record<string, unknown> {
  id: string;
  public_id: string;
  status: "draft" | "received" | "cancelled";
  currency: string;
  line_count: string;
  received_at: string | null;
  created_by_employee_id: string;
}

interface ReceiptLineRow extends Record<string, unknown> {
  id: string;
  inventory_item_id: string;
  quantity: string;
  unit_cost_minor: string;
}

type InventoryCostStatus = "complete" | "pending" | "needs_review";
type InventoryCostBasis = "moving_weighted_average" | "manual_correction" | "none";

interface BalanceStateRow extends Record<string, unknown> {
  on_hand_quantity: string;
  weighted_unit_cost_minor: string | null;
  latest_purchase_unit_cost_minor: string | null;
  cost_status: InventoryCostStatus;
}

interface LockedBalanceState {
  onHandQuantity: string;
  weightedUnitCostMinor: string | null;
  latestPurchaseUnitCostMinor: string | null;
  costStatus: InventoryCostStatus;
}

interface StockCountRow extends Record<string, unknown> {
  id: string;
  public_id: string;
  status: "draft" | "submitted" | "approved" | "rejected";
  created_by_employee_id: string;
}

interface StockCountLineRow extends Record<string, unknown> {
  inventory_item_id: string;
  counted_quantity: string;
  system_quantity_snapshot: string;
  variance_quantity: string;
}

interface StoredBottleRow extends Record<string, unknown> {
  id: string;
  public_id: string;
  inventory_item_id: string;
  current_table_session_id: string;
  original_quantity: string;
  remaining_quantity: string;
  status: StoredBottleRecord["status"];
}

export class InventoryBalanceMissingError extends Error {
  constructor(inventoryItemId: string) {
    super(`Inventory balance is missing: ${inventoryItemId}`);
    this.name = "InventoryBalanceMissingError";
  }
}

export class InventoryRecipeMissingError extends Error {
  constructor(orderItemId: string) {
    super(`Active inventory recipe is missing for order item: ${orderItemId}`);
    this.name = "InventoryRecipeMissingError";
  }
}

export class InsufficientInventoryError extends Error {
  constructor(
    readonly sku: string,
    readonly availableQuantity: string,
    readonly requiredQuantity: string,
  ) {
    super(
      `Insufficient inventory for ${sku}: available ${availableQuantity}, required ${requiredQuantity}`,
    );
    this.name = "InsufficientInventoryError";
  }
}

export class InventoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryConflictError";
  }
}

export class InventoryNotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} was not found: ${id}`);
    this.name = "InventoryNotFoundError";
  }
}

export class InventoryRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async createItem(
    input: Readonly<CreateInventoryItemInput>,
  ): Promise<InventoryItemRecord> {
    assertInventoryItemUnitPolicy({
      baseUnit: input.baseUnit,
      categoryCode: input.categoryCode,
      packageVolumeMl: input.packageVolumeMl ?? null,
      changingExistingItem: false,
    });
    const row = requireOne(
      await this.transaction.query<InventoryItemRow>(
        `
      INSERT INTO mbox.inventory_items (
        tenant_id, store_id, sku, name, item_type, base_unit, category_code,
        low_stock_threshold, whole_unit_count, reasonable_waste_quantity, package_volume_ml
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::numeric, $9, $10::numeric, $11::numeric)
      RETURNING id, sku, name, item_type, base_unit, category_code,
        low_stock_threshold::text, whole_unit_count, reasonable_waste_quantity::text,
        package_volume_ml::text, status
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          input.sku,
          input.name,
          input.itemType,
          input.baseUnit,
          input.categoryCode,
          input.lowStockThreshold ?? null,
          input.wholeUnitCount ?? false,
          input.reasonableWasteQuantity ?? "0",
          input.packageVolumeMl ?? null,
        ],
      ),
      "inventory item insert",
    );
    await this.transaction.query(
      `
      INSERT INTO mbox.inventory_balances (tenant_id, store_id, inventory_item_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid)
    `,
      [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.id],
    );
    return mapItem(row);
  }

  async updateItem(
    itemId: string,
    input: Readonly<UpdateInventoryItemInput>,
  ): Promise<InventoryItemRecord> {
    const current = requireOne(await this.transaction.query<{
      base_unit: string;
      category_code: string;
    }>(`
      SELECT base_unit,category_code
      FROM mbox.inventory_items
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      itemId,
    ]), 'inventory item update target');
    if (requiresMillilitreInventoryMigration(current.category_code, current.base_unit)) {
      if (!isLiquidInventoryCategory(input.categoryCode)) {
        throw new InventoryConflictError('历史瓶数酒水不能通过修改品类规避单位换算；请保持酒水品类并核对单瓶净含量');
      }
      if (input.packageVolumeMl === null) {
        throw new InventoryConflictError('历史瓶数酒水必须保留单瓶净含量，员工端才能按毫升安全录入');
      }
    } else {
      assertInventoryItemUnitPolicy({
        baseUnit: current.base_unit,
        categoryCode: input.categoryCode,
        packageVolumeMl: input.packageVolumeMl,
        changingExistingItem: true,
      });
    }
    const row = requireOne(
      await this.transaction.query<InventoryItemRow>(`
        UPDATE mbox.inventory_items
        SET name=$4::text,
            category_code=$5::text,
            low_stock_threshold=$6::numeric,
            package_volume_ml=$7::numeric,
            updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        RETURNING id, sku, name, item_type, base_unit, category_code,
          low_stock_threshold::text, whole_unit_count, reasonable_waste_quantity::text,
          package_volume_ml::text, status
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        itemId,
        input.name,
        input.categoryCode,
        input.lowStockThreshold,
        input.packageVolumeMl,
      ]),
      "inventory item update",
    );
    return mapItem(row);
  }

  async bindBarcode(
    input: Readonly<BindBarcodeInput>,
  ): Promise<{ id: string; replayed: boolean }> {
    const item = requireOne(
      await this.transaction.query<{
        base_unit: string;
        package_volume_ml: string | null;
      }>(`
        SELECT base_unit,package_volume_ml::text
        FROM mbox.inventory_items
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        FOR SHARE
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        input.inventoryItemId,
      ]),
      'inventory item for barcode binding',
    );
    const packageQuantity = normalizeDecimal(input.packageQuantity ?? '1');
    if (item.base_unit === 'ml') {
      if (item.package_volume_ml === null) {
        throw new InventoryConflictError('按毫升管理的酒水必须先填写单瓶净含量，才能绑定收货条码');
      }
      if (packageQuantity !== normalizeDecimal(item.package_volume_ml)) {
        throw new InventoryConflictError('毫升库存的条码包装量必须等于单瓶净含量，避免把整瓶成本或扣减误记为1毫升');
      }
    }
    const inserted = await this.transaction.query<{ id: string }>(
      `
      INSERT INTO mbox.inventory_barcodes (
        tenant_id, store_id, inventory_item_id, code, code_type,
        package_quantity, created_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::uuid)
      ON CONFLICT (tenant_id, store_id, code) DO NOTHING
      RETURNING id
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        input.inventoryItemId,
        input.code,
        input.codeType ?? "barcode",
        packageQuantity,
        input.employeeId,
      ],
    );
    if (inserted.rowCount === 1 && inserted.rows[0])
      return { id: inserted.rows[0].id, replayed: false };
    const existing = requireOne(
      await this.transaction.query<{
        id: string;
        inventory_item_id: string;
        code_type: string;
        package_quantity: string;
      }>(
        `
      SELECT id, inventory_item_id, code_type, package_quantity::text
      FROM mbox.inventory_barcodes
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND code = $3
      FOR UPDATE
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          input.code,
        ],
      ),
      "barcode lookup",
    );
    if (
      existing.inventory_item_id !== input.inventoryItemId ||
      existing.code_type !== (input.codeType ?? "barcode") ||
      existing.package_quantity !==
        packageQuantity
    ) {
      throw new InventoryConflictError(
        "Barcode is already bound to a different inventory package",
      );
    }
    return { id: existing.id, replayed: true };
  }

  async resolveBarcode(
    code: string,
  ): Promise<{ inventoryItemId: string; packageQuantity: string }> {
    const result = await this.transaction.query<{
      inventory_item_id: string;
      package_quantity: string;
    }>(
      `
      SELECT inventory_item_id, package_quantity::text
      FROM mbox.inventory_barcodes
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND code = $3 AND status = 'active'
    `,
      [this.transaction.scope.tenantId, this.transaction.scope.storeId, code],
    );
    if (!result.rows[0])
      throw new InventoryNotFoundError("active inventory barcode", code);
    return {
      inventoryItemId: result.rows[0].inventory_item_id,
      packageQuantity: result.rows[0].package_quantity,
    };
  }

  async resolveReceiptPackageQuantity(
    inventoryItemId: string,
  ): Promise<{ inventoryItemId: string; packageQuantity: string }> {
    const item = requireOne(
      await this.transaction.query<{
        id: string;
        base_unit: string;
        package_volume_ml: string | null;
      }>(`
        SELECT id,base_unit,package_volume_ml::text
        FROM mbox.inventory_items
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='active'
        FOR SHARE
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        inventoryItemId,
      ]),
      'active inventory item for receipt package',
    );
    if (item.base_unit === 'ml') {
      if (item.package_volume_ml === null) {
        throw new InventoryConflictError(
          '按毫升管理的酒水必须先填写单瓶净含量，才能按包装数量入库',
        );
      }
      return { inventoryItemId: item.id, packageQuantity: item.package_volume_ml };
    }
    return { inventoryItemId: item.id, packageQuantity: '1' };
  }

  async replaceActiveRecipe(
    input: Readonly<ReplaceRecipeInput>,
  ): Promise<{ id: string; version: number }> {
    if (input.components.length === 0)
      throw new TypeError("Recipe must contain at least one component");
    await this.transaction.query(
      `
      SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
    `,
      [
        `inventory-recipe:${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${input.productId}`,
      ],
    );
    const versions = await this.transaction.query<{ version: number }>(
      `
      SELECT version
      FROM mbox.recipes
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND product_id = $3::uuid
      ORDER BY version DESC
      FOR UPDATE
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        input.productId,
      ],
    );
    const nextVersion = (versions.rows[0]?.version ?? 0) + 1;
    await this.transaction.query(
      `
      UPDATE mbox.recipes SET status = 'retired', updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND product_id = $3::uuid AND status = 'active'
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        input.productId,
      ],
    );
    const recipe = requireOne(
      await this.transaction.query<{ id: string }>(
        `
      INSERT INTO mbox.recipes (
        tenant_id, store_id, product_id, version, yield_quantity,
        instructions_snapshot, status, effective_at
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, 'active', clock_timestamp())
      RETURNING id
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          input.productId,
          nextVersion,
          input.yieldQuantity,
          JSON.stringify(input.instructionsSnapshot ?? {}),
        ],
      ),
      "recipe insert",
    );
    for (const component of [...input.components].sort((a, b) =>
      a.inventoryItemId.localeCompare(b.inventoryItemId),
    )) {
      await this.transaction.query(
        `
        INSERT INTO mbox.recipe_items (
          tenant_id, store_id, recipe_id, inventory_item_id, quantity, expected_waste_quantity
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::numeric)
      `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          recipe.id,
          component.inventoryItemId,
          component.quantity,
          component.expectedWasteQuantity ?? "0",
        ],
      );
    }
    return { id: recipe.id, version: nextVersion };
  }

  async previewRecipeCost(productId: string): Promise<RecipeCostPreview> {
    return this.recipeCostSnapshot(productId, false);
  }

  async previewRecipeCostForReceipt(productId: string, receiptId: string): Promise<RecipeCostPreview> {
    return this.recipeCostSnapshot(productId, false, receiptId);
  }

  async applyRecipeCost(
    productId: string,
    employeeId: string,
    reason: string,
  ): Promise<AppliedRecipeCost> {
    if (reason.trim().length < 2 || reason.trim().length > 500)
      throw new TypeError('Recipe cost calculation reason must be 2 to 500 characters');
    const applied = await this.synchronizeTrackedProductRecipeCost(productId, employeeId, reason.trim());
    if (applied === null)
      throw new InventoryConflictError('所有配方物料都必须有已收货的单位成本，才能计算并应用商品成本');
    return applied;
  }

  async synchronizeTrackedProductRecipeCost(
    productId: string,
    employeeId: string,
    reason: string,
  ): Promise<AppliedRecipeCost | null> {
    const preview = await this.recipeCostSnapshot(productId, true);
    if (preview.costAmountMinor === null) {
      const product = await this.transaction.query<{ id: string }>(`
        UPDATE mbox.products
        SET cost_amount_minor=NULL,cost_source='incomplete',recipe_cost_version_id=NULL,
          updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND inventory_control_mode='tracked'
        RETURNING id
      `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,productId]);
      if (product.rowCount !== 1) throw new InventoryNotFoundError('tracked product', productId);
      return null;
    }
    return this.persistRecipeCost(preview, employeeId, reason);
  }

  async synchronizeTrackedRecipeCostsForInventoryItems(
    inventoryItemIds: readonly string[],
    employeeId: string,
    reason: string,
  ): Promise<AppliedRecipeCost[]> {
    const uniqueIds = [...new Set(inventoryItemIds)].toSorted();
    if (uniqueIds.length === 0) return [];
    const products = await this.transaction.query<{ product_id: string }>(`
      SELECT DISTINCT recipe.product_id
      FROM mbox.recipes AS recipe
      JOIN mbox.recipe_items AS component
        ON component.tenant_id=recipe.tenant_id AND component.store_id=recipe.store_id
       AND component.recipe_id=recipe.id
      JOIN mbox.products AS product
        ON product.tenant_id=recipe.tenant_id AND product.store_id=recipe.store_id
       AND product.id=recipe.product_id
      WHERE recipe.tenant_id=$1::uuid AND recipe.store_id=$2::uuid
        AND recipe.status='active' AND product.inventory_control_mode='tracked'
        AND component.inventory_item_id=ANY($3::uuid[])
      ORDER BY recipe.product_id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,uniqueIds]);
    const applied: AppliedRecipeCost[] = [];
    for (const product of products.rows) {
      const result = await this.synchronizeTrackedProductRecipeCost(
        product.product_id,
        employeeId,
        reason,
      );
      if (result !== null) applied.push(result);
    }
    // A package's cost is the sum of its component products.  Recalculate it
    // in the same transaction as the receipt/recipe update so the next order
    // snapshots the same cost basis rather than a stale manual field.
    await this.synchronizeBundleCostsForComponentProducts(
      products.rows.map((product) => product.product_id),
    );
    return applied;
  }

  async synchronizeBundleCostsForComponentProducts(
    componentProductIds: readonly string[],
  ): Promise<string[]> {
    const productIds = [...new Set(componentProductIds)].toSorted();
    if (productIds.length === 0) return [];
    const result = await this.transaction.query<{ id: string }>(`
      WITH affected_bundle AS (
        SELECT DISTINCT component.bundle_product_id
        FROM mbox.product_bundle_components AS component
        WHERE component.tenant_id=$1::uuid AND component.store_id=$2::uuid
          AND component.component_product_id=ANY($3::uuid[])
      ), calculated AS (
        SELECT component.bundle_product_id,
          CASE
            WHEN bool_and(component_product.cost_amount_minor IS NOT NULL)
              AND sum(component_product.cost_amount_minor::numeric * component.quantity::numeric) <= 9007199254740991
            THEN sum(component_product.cost_amount_minor::numeric * component.quantity::numeric)::bigint
            ELSE NULL
          END AS cost_amount_minor
        FROM mbox.product_bundle_components AS component
        JOIN affected_bundle AS affected
          ON affected.bundle_product_id=component.bundle_product_id
        JOIN mbox.products AS component_product
          ON component_product.tenant_id=component.tenant_id
         AND component_product.store_id=component.store_id
         AND component_product.id=component.component_product_id
        WHERE component.tenant_id=$1::uuid AND component.store_id=$2::uuid
        GROUP BY component.bundle_product_id
      )
      UPDATE mbox.products AS bundle
      SET cost_amount_minor=calculated.cost_amount_minor,
          cost_source=CASE
            WHEN calculated.cost_amount_minor IS NULL THEN 'incomplete'
            ELSE 'bundle'
          END,
          recipe_cost_version_id=NULL,
          updated_at=clock_timestamp()
      FROM calculated
      WHERE bundle.tenant_id=$1::uuid AND bundle.store_id=$2::uuid
        AND bundle.id=calculated.bundle_product_id
        AND bundle.product_kind='bundle'
      RETURNING bundle.id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      productIds,
    ]);
    return result.rows.map((row) => row.id);
  }

  async correctInventoryCost(
    inventoryItemId: string,
    weightedUnitCostMinor: string,
    employeeId: string,
    reason: string,
  ): Promise<{
    id: string;
    inventoryItemId: string;
    previousWeightedUnitCostMinor: string | null;
    weightedUnitCostMinor: string;
    differenceWeightedUnitCostMinor: string | null;
  }> {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(weightedUnitCostMinor))
      throw new TypeError('Corrected inventory unit cost must be a non-negative decimal');
    if (reason.trim().length < 2 || reason.trim().length > 500)
      throw new TypeError('Inventory cost correction reason must be 2 to 500 characters');
    const balance = await this.lockOrCreateBalance(inventoryItemId);
    const correction = requireOne(await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.inventory_cost_corrections(
        tenant_id,store_id,inventory_item_id,previous_weighted_unit_cost_minor,
        resulting_weighted_unit_cost_minor,reason,created_by_employee_id
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::numeric,$5::numeric,$6,$7::uuid)
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      inventoryItemId,
      balance.weightedUnitCostMinor,
      weightedUnitCostMinor,
      reason.trim(),
      employeeId,
    ]), 'inventory cost correction insert');
    await this.updateBalanceCostState(inventoryItemId, weightedUnitCostMinor, 'complete', 'manual_correction');
    await this.synchronizeTrackedRecipeCostsForInventoryItems(
      [inventoryItemId],
      employeeId,
      `库存成本更正后自动重算：${reason.trim()}`,
    );
    return {
      id: correction.id,
      inventoryItemId,
      previousWeightedUnitCostMinor: balance.weightedUnitCostMinor,
      weightedUnitCostMinor: normalizeDecimal(weightedUnitCostMinor),
      differenceWeightedUnitCostMinor: balance.weightedUnitCostMinor === null
        ? null
        : subtractDecimal(weightedUnitCostMinor, balance.weightedUnitCostMinor),
    };
  }

  private async persistRecipeCost(
    preview: RecipeCostPreview,
    employeeId: string,
    reason: string,
  ): Promise<AppliedRecipeCost> {
    const inserted = requireOne(await this.transaction.query<{ id: string; calculated_at: string }>(`
      INSERT INTO mbox.recipe_cost_versions(
        tenant_id,store_id,product_id,recipe_id,recipe_version,cost_amount_minor,currency,
        calculated_by_employee_id,calculation_reason
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::bigint,$7,$8::uuid,$9)
      RETURNING id,calculated_at::text
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,preview.productId,preview.recipeId,
      preview.recipeVersion,preview.costAmountMinor,preview.currency,employeeId,reason.trim(),
    ]), 'recipe cost version insert');
    for (const component of preview.components) {
      if (component.sourceUnitCostMinor === null || component.componentCostMinor === null)
        throw new InventoryConflictError('配方成本来源不完整，不能应用');
      await this.transaction.query(`
        INSERT INTO mbox.recipe_cost_components(
          tenant_id,store_id,recipe_cost_version_id,recipe_item_id,inventory_item_id,source_receipt_line_id,
          cost_basis,component_quantity,expected_waste_quantity,yield_quantity,source_unit_cost_minor,component_cost_minor
        ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::numeric,$9::numeric,$10,$11::numeric,$12::numeric)
      `, [
        this.transaction.scope.tenantId,this.transaction.scope.storeId,inserted.id,component.recipeItemId,
        component.inventoryItemId,component.sourceReceiptLineId,component.costBasis,component.componentQuantity,
        component.expectedWasteQuantity,preview.yieldQuantity,component.sourceUnitCostMinor,component.componentCostMinor,
      ]);
    }
    const product = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.products
      SET cost_amount_minor=$4::bigint,cost_source='recipe',recipe_cost_version_id=$5::uuid,
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      RETURNING id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,preview.productId,preview.costAmountMinor,inserted.id]);
    if (product.rows[0] === undefined) throw new InventoryNotFoundError('product', preview.productId);
    return { ...preview, id: inserted.id, appliedAt: inserted.calculated_at };
  }

  private async recipeCostSnapshot(productId: string, lock: boolean, preferredReceiptId?: string): Promise<RecipeCostPreview> {
    const result = await this.transaction.query<RecipeCostRow>(`
      SELECT recipe.id AS recipe_id,recipe.version AS recipe_version,recipe.yield_quantity,
        component.id AS recipe_item_id,item.id AS inventory_item_id,item.name AS item_name,item.base_unit,
        component.quantity::text AS component_quantity,
        component.expected_waste_quantity::text AS expected_waste_quantity,
        NULL::uuid AS source_receipt_line_id,
        CASE
          WHEN incoming.id IS NOT NULL AND incoming.receipt_status='draft' THEN 'moving_weighted_average'
          WHEN balance.cost_basis='manual_correction' THEN 'manual_correction'
          ELSE 'moving_weighted_average'
        END::text AS cost_basis,
        CASE
          WHEN incoming.id IS NOT NULL AND incoming.receipt_status='draft' THEN
            CASE
              WHEN balance.on_hand_quantity=0 THEN incoming.unit_cost_minor
              WHEN balance.cost_status='complete' AND balance.weighted_unit_cost_minor IS NOT NULL THEN
                ROUND(((balance.on_hand_quantity*balance.weighted_unit_cost_minor)
                  +(incoming.quantity*incoming.unit_cost_minor))
                  /(balance.on_hand_quantity+incoming.quantity),6)
              ELSE NULL
            END
          WHEN balance.cost_status='complete' THEN balance.weighted_unit_cost_minor
          ELSE NULL
        END::numeric(18,6)::text AS source_unit_cost_minor,
        CASE WHEN (
          CASE
            WHEN incoming.id IS NOT NULL AND incoming.receipt_status='draft' THEN
              CASE
                WHEN balance.on_hand_quantity=0 THEN incoming.unit_cost_minor
                WHEN balance.cost_status='complete' AND balance.weighted_unit_cost_minor IS NOT NULL THEN
                  ROUND(((balance.on_hand_quantity*balance.weighted_unit_cost_minor)
                    +(incoming.quantity*incoming.unit_cost_minor))
                    /(balance.on_hand_quantity+incoming.quantity),6)
                ELSE NULL
              END
            WHEN balance.cost_status='complete' THEN balance.weighted_unit_cost_minor
            ELSE NULL
          END
        ) IS NULL THEN NULL ELSE (
          (component.quantity+component.expected_waste_quantity)*(
            CASE
              WHEN incoming.id IS NOT NULL AND incoming.receipt_status='draft' THEN
                CASE
                  WHEN balance.on_hand_quantity=0 THEN incoming.unit_cost_minor
                  WHEN balance.cost_status='complete' AND balance.weighted_unit_cost_minor IS NOT NULL THEN
                    ROUND(((balance.on_hand_quantity*balance.weighted_unit_cost_minor)
                      +(incoming.quantity*incoming.unit_cost_minor))
                      /(balance.on_hand_quantity+incoming.quantity),6)
                  ELSE NULL
                END
              WHEN balance.cost_status='complete' THEN balance.weighted_unit_cost_minor
              ELSE NULL
            END
          )/recipe.yield_quantity
        )::numeric(18,6)::text END AS component_cost_minor
      FROM mbox.recipes AS recipe
      JOIN mbox.recipe_items AS component
        ON component.tenant_id=recipe.tenant_id AND component.store_id=recipe.store_id
       AND component.recipe_id=recipe.id
      JOIN mbox.inventory_items AS item
        ON item.tenant_id=component.tenant_id AND item.store_id=component.store_id
       AND item.id=component.inventory_item_id
      JOIN mbox.inventory_balances AS balance
        ON balance.tenant_id=component.tenant_id AND balance.store_id=component.store_id
       AND balance.inventory_item_id=component.inventory_item_id
      LEFT JOIN LATERAL (
        SELECT line.id,line.quantity,line.unit_cost_minor,receipt.status AS receipt_status
        FROM mbox.purchase_receipt_lines AS line
        JOIN mbox.purchase_receipts AS receipt
          ON receipt.tenant_id=line.tenant_id AND receipt.store_id=line.store_id
         AND receipt.id=line.receipt_id
        WHERE line.tenant_id=component.tenant_id AND line.store_id=component.store_id
          AND line.inventory_item_id=component.inventory_item_id
          AND receipt.id=$4::uuid
        ORDER BY line.id DESC LIMIT 1
      ) AS incoming ON true
      WHERE recipe.tenant_id=$1::uuid AND recipe.store_id=$2::uuid
        AND recipe.product_id=$3::uuid AND recipe.status='active'
      ORDER BY component.id
      ${lock ? 'FOR UPDATE OF recipe,component,balance' : ''}
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,productId,preferredReceiptId ?? null]);
    if (result.rows.length === 0) throw new InventoryNotFoundError('active inventory recipe', productId);
    const first = result.rows[0]!;
    const components = result.rows.map((row): RecipeCostComponent => ({
      recipeItemId: row.recipe_item_id,inventoryItemId: row.inventory_item_id,itemName: row.item_name,
      baseUnit: row.base_unit,componentQuantity: row.component_quantity,
      expectedWasteQuantity: row.expected_waste_quantity,sourceReceiptLineId: row.source_receipt_line_id,
      costBasis: row.cost_basis,sourceUnitCostMinor: row.source_unit_cost_minor,componentCostMinor: row.component_cost_minor,
    }));
    const total = components.every((component) => component.componentCostMinor !== null)
      ? roundMinorDecimalTotal(components.map((component) => component.componentCostMinor!))
      : null;
    if (total !== null && (!Number.isSafeInteger(total) || total < 0)) throw new InventoryConflictError('配方成本超出允许范围');
    return { productId,recipeId: first.recipe_id,recipeVersion: first.recipe_version,yieldQuantity: first.yield_quantity,
      currency: 'CNY',costAmountMinor: total,components };
  }

  async createPurchaseReceipt(
    input: Readonly<CreatePurchaseReceiptInput>,
  ): Promise<PurchaseReceiptRecord> {
    if (input.lines.length === 0 || input.lines.length > 200)
      throw new TypeError("Receipt must contain 1 to 200 lines");
    const lineTotalMinor = input.lines.reduce(
      (total, line) => total + requireMinorAmount(line.totalCostMinor, 'receipt line total'),
      0n,
    );
    if (input.invoiceTotalMinor !== undefined && input.invoiceTotalMinor !== null
      && requireMinorAmount(input.invoiceTotalMinor, 'receipt total') !== lineTotalMinor) {
      throw new InventoryConflictError('收货单总额必须等于各物料本批实际总额之和');
    }
    const receipt = requireOne(
      await this.transaction.query<{ id: string }>(
        `
      INSERT INTO mbox.purchase_receipts (
        tenant_id, store_id, public_id, supplier_ref, supplier_snapshot, currency,
        invoice_total_minor, note, created_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::bigint, $8, $9::uuid)
      RETURNING id
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          input.publicId,
          input.supplierRef ?? null,
          JSON.stringify(input.supplierSnapshot ?? {}),
          input.currency ?? "CNY",
          input.invoiceTotalMinor ?? null,
          input.note ?? null,
          input.employeeId,
        ],
      ),
      "purchase receipt insert",
    );
    for (const line of input.lines) {
      await this.transaction.query(
        `
        INSERT INTO mbox.purchase_receipt_lines (
          tenant_id, store_id, receipt_id, inventory_item_id, batch_code,
          quantity, unit_cost_minor, total_cost_minor, expires_on, metadata
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
          $6::numeric,
          $7::numeric / NULLIF($6::numeric, 0),
          $7::bigint, $8::date, $9::jsonb)
      `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          receipt.id,
          line.inventoryItemId,
          line.batchCode,
          line.quantity,
          line.totalCostMinor,
          line.expiresOn ?? null,
          JSON.stringify(line.metadata ?? {}),
        ],
      );
    }
    return {
      id: receipt.id,
      publicId: input.publicId,
      status: "draft",
      currency: input.currency ?? "CNY",
      lineCount: input.lines.length,
      receivedAt: null,
    };
  }

  async receivePurchaseReceipt(
    receiptId: string,
    employeeId: string,
  ): Promise<PurchaseReceiptRecord> {
    const receipt = requireOne(
      await this.transaction.query<ReceiptRow>(
        `
      SELECT id, public_id, status, currency, received_at::text,
        created_by_employee_id,
        (SELECT count(*)::text FROM mbox.purchase_receipt_lines AS line
          WHERE line.tenant_id = receipt.tenant_id AND line.store_id = receipt.store_id
            AND line.receipt_id = receipt.id) AS line_count
      FROM mbox.purchase_receipts AS receipt
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          receiptId,
        ],
      ),
      "purchase receipt",
    );
    if (receipt.status === "received") return mapReceipt(receipt);
    if (receipt.status !== "draft")
      throw new InventoryConflictError(
        `Receipt cannot be received from ${receipt.status}`,
      );
    const lines = await this.transaction.query<ReceiptLineRow>(
      `
      SELECT id, inventory_item_id, quantity::text, unit_cost_minor::text
      FROM mbox.purchase_receipt_lines
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND receipt_id = $3::uuid
      ORDER BY inventory_item_id, id
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        receiptId,
      ],
    );
    if (lines.rowCount === 0)
      throw new InventoryConflictError("Receipt has no lines");
    for (const line of lines.rows) {
      await this.lockOrCreateBalance(line.inventory_item_id);
      const movement = await this.insertMovement({
        inventoryItemId: line.inventory_item_id,
        movementType: "purchase",
        quantityDelta: line.quantity,
        unitCostMinor: line.unit_cost_minor,
        referenceType: "purchase_receipt_line",
        referenceId: line.id,
        reason: "purchase receipt received",
        employeeId,
      });
      await this.receivePurchasedBalance(
        line.inventory_item_id,
        line.quantity,
        line.unit_cost_minor,
        movement,
      );
    }
    const updated = requireOne(
      await this.transaction.query<ReceiptRow>(
        `
      UPDATE mbox.purchase_receipts
      SET status = 'received', received_by_employee_id = $4::uuid,
          received_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'draft'
      RETURNING id, public_id, status, currency, received_at::text,
        created_by_employee_id, $5::text AS line_count
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          receiptId,
          employeeId,
          lines.rows.length,
        ],
      ),
      "purchase receipt receive",
    );
    await this.synchronizeTrackedRecipeCostsForInventoryItems(
      lines.rows.map((line) => line.inventory_item_id),
      employeeId,
      "采购收货确认后按移动加权库存成本自动重算",
    );
    return mapReceipt(updated);
  }

  async createStockCount(
    publicId: string,
    employeeId: string,
    lines: readonly StockCountLineInput[],
    note?: string | null,
  ): Promise<StockCountRecord> {
    if (lines.length === 0 || lines.length > 500)
      throw new TypeError("Stock count must contain 1 to 500 lines");
    const count = requireOne(
      await this.transaction.query<{ id: string }>(
        `
      INSERT INTO mbox.inventory_stock_counts (
        tenant_id, store_id, public_id, note, created_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)
      RETURNING id
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          publicId,
          note ?? null,
          employeeId,
        ],
      ),
      "stock count insert",
    );
    for (const line of [...lines].sort((a, b) =>
      a.inventoryItemId.localeCompare(b.inventoryItemId),
    )) {
      const balance = await this.lockOrCreateBalance(line.inventoryItemId);
      await this.transaction.query(
        `
        INSERT INTO mbox.inventory_stock_count_lines (
          tenant_id, store_id, stock_count_id, inventory_item_id,
          counted_quantity, system_quantity_snapshot, reason
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::numeric, $7)
      `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          count.id,
          line.inventoryItemId,
          line.countedQuantity,
          balance.onHandQuantity,
          line.reason ?? null,
        ],
      );
    }
    return { id: count.id, publicId, status: "draft" };
  }

  async submitStockCount(
    countId: string,
    employeeId: string,
  ): Promise<StockCountRecord> {
    return this.transitionStockCount(countId, "draft", "submitted", employeeId);
  }

  async approveStockCount(
    countId: string,
    employeeId: string,
  ): Promise<StockCountRecord> {
    const count = await this.lockStockCount(countId);
    if (count.status === "approved") return mapCount(count);
    if (count.status !== "submitted")
      throw new InventoryConflictError(
        `Stock count cannot be approved from ${count.status}`,
      );
    if (count.created_by_employee_id === employeeId)
      throw new InventoryConflictError(
        "Stock count requires independent approval",
      );
    const lines = await this.transaction.query<StockCountLineRow>(
      `
      SELECT inventory_item_id, counted_quantity::text, system_quantity_snapshot::text,
        variance_quantity::text
      FROM mbox.inventory_stock_count_lines
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND stock_count_id = $3::uuid
      ORDER BY inventory_item_id
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        countId,
      ],
    );
    for (const line of lines.rows) {
      const current = await this.lockOrCreateBalance(line.inventory_item_id);
      const delta = subtractDecimal(line.counted_quantity, current.onHandQuantity);
      if (isZeroDecimal(delta)) continue;
      const movement = await this.insertMovement({
        inventoryItemId: line.inventory_item_id,
        movementType: "count_adjustment",
        quantityDelta: delta,
        referenceType: "inventory_stock_count",
        referenceId: countId,
        reason: "approved stock count",
        employeeId,
        metadata: { capturedSystemQuantity: line.system_quantity_snapshot },
      });
      await this.updateBalance(
        line.inventory_item_id,
        line.counted_quantity,
        movement,
      );
      if (compareDecimal(delta, "0") > 0) {
        await this.updateBalanceCostState(line.inventory_item_id, null, "needs_review", "none");
      } else if (isZeroDecimal(line.counted_quantity)) {
        await this.updateBalanceCostState(line.inventory_item_id, null, "pending", "none");
      }
    }
    const updated = requireOne(
      await this.transaction.query<StockCountRow>(
        `
      UPDATE mbox.inventory_stock_counts
      SET status = 'approved', decided_by_employee_id = $4::uuid,
          decided_at = clock_timestamp(), decision_reason = '盘点差异已复核',
          updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'submitted'
      RETURNING id, public_id, status, created_by_employee_id
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          countId,
          employeeId,
        ],
      ),
      "stock count approval",
    );
    return mapCount(updated);
  }

  async rejectStockCount(
    countId: string,
    employeeId: string,
    reason: string,
  ): Promise<StockCountRecord> {
    const count = await this.lockStockCount(countId);
    if (count.status === "rejected") return mapCount(count);
    if (count.status !== "submitted")
      throw new InventoryConflictError(
        `Stock count cannot be rejected from ${count.status}`,
      );
    if (count.created_by_employee_id === employeeId)
      throw new InventoryConflictError(
        "Stock count requires independent approval",
      );
    const updated = requireOne(
      await this.transaction.query<StockCountRow>(
        `
      UPDATE mbox.inventory_stock_counts
      SET status = 'rejected', decided_by_employee_id = $4::uuid,
          decided_at = clock_timestamp(), decision_reason = $5,
          updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'submitted'
      RETURNING id, public_id, status, created_by_employee_id
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          countId,
          employeeId,
          reason,
        ],
      ),
      "stock count rejection",
    );
    return mapCount(updated);
  }

  async recordWaste(
    inventoryItemId: string,
    quantity: string,
    employeeId: string,
    reason: string,
    approvedOverride = false,
    wasteType = "other",
  ): Promise<{
    movementId: string;
    remainingQuantity: string;
    baseUnit: string;
    wasteType: string;
    unitCostMinor: string | null;
    wasteCostMinor: string | null;
  }> {
    const item = requireOne(
      await this.transaction.query<{
        sku: string;
        base_unit: string;
        reasonable_waste_quantity: string;
      }>(
        `
      SELECT sku, base_unit, reasonable_waste_quantity::text
      FROM mbox.inventory_items
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'active'
      FOR SHARE
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          inventoryItemId,
        ],
      ),
      "inventory item",
    );
    if (
      !approvedOverride &&
      compareDecimal(quantity, item.reasonable_waste_quantity) > 0
    ) {
      throw new InventoryConflictError(
        "Waste exceeds the configured reasonable allowance",
      );
    }
    const balance = await this.lockOrCreateBalance(inventoryItemId);
    if (compareDecimal(balance.onHandQuantity, quantity) < 0)
      throw new InsufficientInventoryError(item.sku, balance.onHandQuantity, quantity);
    const movement = await this.insertMovement({
      inventoryItemId,
      movementType: "waste",
      quantityDelta: `-${normalizeDecimal(quantity)}`,
      unitCostMinor: balance.weightedUnitCostMinor,
      referenceType: "manual_waste",
      reason,
      employeeId,
      metadata: { approvedOverride, wasteType },
    });
    const remaining = subtractDecimal(balance.onHandQuantity, quantity);
    await this.updateBalance(inventoryItemId, remaining, movement);
    if (isZeroDecimal(remaining)) {
      await this.updateBalanceCostState(inventoryItemId, null, "pending", "none");
    }
    return {
      movementId: movement,
      remainingQuantity: remaining,
      baseUnit: item.base_unit,
      wasteType,
      unitCostMinor: balance.weightedUnitCostMinor,
      wasteCostMinor: balance.weightedUnitCostMinor === null
        ? null
        : roundDecimalProductToMinor(quantity, balance.weightedUnitCostMinor),
    };
  }

  async storeBottle(input: {
    publicId: string;
    inventoryItemId: string;
    tableSessionId: string;
    quantity: string;
    employeeId: string;
    customerId?: string | null;
    holderDisplayName?: string | null;
    holderContactToken?: string | null;
    sourceReceiptLineId?: string | null;
    expiresAt?: string | null;
  }): Promise<StoredBottleRecord> {
    await this.assertOpenTableSession(input.tableSessionId);
    const bottleItem = await this.transaction.query(
      `
      SELECT id FROM mbox.inventory_items
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND item_type = 'bottle' AND status = 'active'
      FOR SHARE
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        input.inventoryItemId,
      ],
    );
    if (bottleItem.rowCount !== 1)
      throw new InventoryConflictError(
        "Stored bottle must reference an active bottle inventory item",
      );
    const row = requireOne(
      await this.transaction.query<StoredBottleRow>(
        `
      INSERT INTO mbox.stored_bottles (
        tenant_id, store_id, public_id, inventory_item_id, source_receipt_line_id, customer_id,
        holder_display_name, holder_contact_token, current_table_session_id,
        original_quantity, remaining_quantity, stored_by_employee_id, expires_at
      ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::uuid,
        $10::numeric, $10::numeric, $11::uuid, $12::timestamptz)
      RETURNING id, public_id, inventory_item_id, current_table_session_id,
        original_quantity::text, remaining_quantity::text, status
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          input.publicId,
          input.inventoryItemId,
          input.sourceReceiptLineId ?? null,
          input.customerId ?? null,
          input.holderDisplayName ?? null,
          input.holderContactToken ?? null,
          input.tableSessionId,
          input.quantity,
          input.employeeId,
          input.expiresAt ?? null,
        ],
      ),
      "stored bottle insert",
    );
    await this.insertBottleEvent(
      row.id,
      "stored",
      "0",
      input.employeeId,
      null,
      input.tableSessionId,
      "bottle stored",
    );
    return mapBottle(row);
  }

  async findStoredBottle(bottleId: string): Promise<StoredBottleRecord | null> {
    const result = await this.transaction.query<StoredBottleRow>(
      `
      SELECT id, public_id, inventory_item_id, current_table_session_id,
        original_quantity::text, remaining_quantity::text, status
      FROM mbox.stored_bottles
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        bottleId,
      ],
    );
    return result.rows[0] ? mapBottle(result.rows[0]) : null;
  }

  async useStoredBottle(
    bottleId: string,
    quantity: string,
    employeeId: string,
  ): Promise<StoredBottleRecord> {
    const bottle = await this.lockBottle(bottleId);
    if (!["stored", "in_use"].includes(bottle.status))
      throw new InventoryConflictError(
        `Bottle cannot be used from ${bottle.status}`,
      );
    if (compareDecimal(bottle.remaining_quantity, quantity) < 0) {
      throw new InsufficientInventoryError(
        bottle.public_id,
        bottle.remaining_quantity,
        quantity,
      );
    }
    const remaining = subtractDecimal(bottle.remaining_quantity, quantity);
    const row = requireOne(
      await this.transaction.query<StoredBottleRow>(
        `
      UPDATE mbox.stored_bottles
      SET remaining_quantity = $4::numeric,
          status = CASE WHEN $4::numeric = 0 THEN 'consumed' ELSE 'in_use' END,
          updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      RETURNING id, public_id, inventory_item_id, current_table_session_id,
        original_quantity::text, remaining_quantity::text, status
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          bottleId,
          remaining,
        ],
      ),
      "stored bottle use",
    );
    await this.insertBottleEvent(
      bottleId,
      "used",
      `-${normalizeDecimal(quantity)}`,
      employeeId,
      bottle.current_table_session_id,
      bottle.current_table_session_id,
      "bottle used",
    );
    return mapBottle(row);
  }

  async transferStoredBottle(
    bottleId: string,
    toTableSessionId: string,
    employeeId: string,
    reason: string,
  ): Promise<StoredBottleRecord> {
    await this.assertOpenTableSession(toTableSessionId);
    const bottle = await this.lockBottle(bottleId);
    if (!["stored", "in_use"].includes(bottle.status))
      throw new InventoryConflictError(
        `Bottle cannot be transferred from ${bottle.status}`,
      );
    const row = requireOne(
      await this.transaction.query<StoredBottleRow>(
        `
      UPDATE mbox.stored_bottles
      SET current_table_session_id = $4::uuid, updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      RETURNING id, public_id, inventory_item_id, current_table_session_id,
        original_quantity::text, remaining_quantity::text, status
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          bottleId,
          toTableSessionId,
        ],
      ),
      "stored bottle transfer",
    );
    await this.insertBottleEvent(
      bottleId,
      "transferred",
      "0",
      employeeId,
      bottle.current_table_session_id,
      toTableSessionId,
      reason,
    );
    return mapBottle(row);
  }

  async voidStoredBottle(
    bottleId: string,
    employeeId: string,
    reason: string,
  ): Promise<StoredBottleRecord> {
    const bottle = await this.lockBottle(bottleId);
    if (bottle.status === "voided") return mapBottle(bottle);
    if (bottle.status === "consumed")
      throw new InventoryConflictError("Consumed bottle cannot be voided");
    const row = requireOne(
      await this.transaction.query<StoredBottleRow>(
        `
      UPDATE mbox.stored_bottles SET status = 'voided', updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      RETURNING id, public_id, inventory_item_id, current_table_session_id,
        original_quantity::text, remaining_quantity::text, status
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          bottleId,
        ],
      ),
      "stored bottle void",
    );
    await this.insertBottleEvent(
      bottleId,
      "voided",
      "0",
      employeeId,
      bottle.current_table_session_id,
      null,
      reason,
    );
    return mapBottle(row);
  }

  async employeeHasTableResponsibility(
    employeeId: string,
    tableSessionId: string,
  ): Promise<boolean> {
    const result = await this.transaction.query<{ allowed: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM mbox.table_sessions AS session
        JOIN mbox.table_assignments AS assignment
          ON assignment.tenant_id = session.tenant_id AND assignment.store_id = session.store_id
         AND assignment.table_id = session.table_id
        WHERE session.tenant_id = $1::uuid AND session.store_id = $2::uuid
          AND session.id = $3::uuid AND session.status IN ('open', 'closing')
          AND assignment.employee_id = $4::uuid
          AND assignment.starts_at <= clock_timestamp()
          AND (assignment.ends_at IS NULL OR assignment.ends_at > clock_timestamp())
      ) AS allowed
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        tableSessionId,
        employeeId,
      ],
    );
    return result.rows[0]?.allowed === true;
  }

  async consumeForOrderItems(
    orderItems: readonly OrderItem[],
    options: Readonly<ConsumeInventoryOptions> = {},
  ): Promise<InventoryConsumption[]> {
    if (orderItems.length === 0) return [];
    if (orderItems.length > 100)
      throw new TypeError("At most 100 order items can be consumed at once");
    if (options.createdByEmployeeId)
      requireUuid("createdByEmployeeId", options.createdByEmployeeId);
    const trackedOrderItems = await this.loadTrackedInventoryOrderItemIds(orderItems);
    if (trackedOrderItems.size === 0) return [];
    const demand = await this.loadRecipeDemand(orderItems);
    const demandOrderItems = new Set(demand.map((row) => row.order_item_id));
    const missingRecipe = orderItems.find(
      (item) =>
        trackedOrderItems.has(item.id) &&
        !demandOrderItems.has(item.id),
    );
    if (missingRecipe && options.allowMissingRecipes !== true)
      throw new InventoryRecipeMissingError(missingRecipe.id);
    if (demand.length === 0) return [];
    const locked = await this.lockRequiredBalances(demand);
    this.assertBalancesSufficient(demand, locked);
    const results: InventoryConsumption[] = [];
    for (const row of demand) {
      const movement = await this.insertMovement({
        inventoryItemId: row.inventory_item_id,
        movementType: "sale",
        quantityDelta: `-${normalizeDecimal(row.required_quantity)}`,
        referenceType: "order_item",
        referenceId: row.order_item_id,
        orderItemId: row.order_item_id,
        reason: options.reason ?? "order submitted",
        employeeId: options.createdByEmployeeId ?? null,
        metadata: options.metadata,
      });
      const balance = requireOne(
        await this.transaction.query<{ on_hand_quantity: string }>(
          `
        UPDATE mbox.inventory_balances
        SET on_hand_quantity = on_hand_quantity - $4::numeric,
            last_movement_id = $5::uuid, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND inventory_item_id = $3::uuid
          AND on_hand_quantity - reserved_quantity >= $4::numeric
        RETURNING on_hand_quantity::text
      `,
          [
            this.transaction.scope.tenantId,
            this.transaction.scope.storeId,
            row.inventory_item_id,
            row.required_quantity,
            movement,
          ],
        ),
        "inventory balance update",
      );
      results.push({
        movementId: movement,
        orderItemId: row.order_item_id,
        inventoryItemId: row.inventory_item_id,
        sku: row.sku,
        quantity: row.required_quantity,
        remainingOnHandQuantity: balance.on_hand_quantity,
      });
    }
    return results;
  }

  async reserveForImmediatePaymentOrder(
    orderId: string,
    orderItems: readonly OrderItem[],
    options: Readonly<{ allowMissingRecipes?: boolean }> = {},
  ): Promise<InventoryOrderReservation[]> {
    requireUuid("orderId", orderId);
    if (orderItems.length === 0) return [];
    if (orderItems.length > 100)
      throw new TypeError("At most 100 order items can be reserved at once");
    const order = requireOne(
      await this.transaction.query<{ fulfillment_expires_at: string | null; fulfillment_state: string }>(`
        SELECT fulfillment_expires_at::text, fulfillment_state
        FROM mbox.orders
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        FOR UPDATE
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId]),
      "immediate-payment order lookup",
    );
    if (order.fulfillment_state !== "awaiting_payment" || order.fulfillment_expires_at === null) {
      throw new InventoryConflictError("Order is not awaiting payment inventory reservation");
    }

    const trackedOrderItems = await this.loadTrackedInventoryOrderItemIds(orderItems);
    if (trackedOrderItems.size === 0) return [];
    const demand = await this.loadRecipeDemand(orderItems);
    const demandOrderItems = new Set(demand.map((row) => row.order_item_id));
    const missingRecipe = orderItems.find(
      (item) =>
        trackedOrderItems.has(item.id) &&
        !demandOrderItems.has(item.id),
    );
    if (missingRecipe && options.allowMissingRecipes !== true)
      throw new InventoryRecipeMissingError(missingRecipe.id);
    if (demand.length === 0) return [];

    const existing = await this.readOrderReservations(orderId, true);
    const demandKeys = new Map(demand.map((row) => [
      `${row.order_item_id}:${row.inventory_item_id}`,
      normalizeDecimal(row.required_quantity),
    ]));
    if (existing.length > 0) {
      const sameShape = existing.length === demand.length && existing.every((row) => (
        demandKeys.get(`${row.order_item_id}:${row.inventory_item_id}`) === normalizeDecimal(row.quantity)
      ));
      if (!sameShape || existing.some((row) => row.status === "consumed")) {
        throw new InventoryConflictError("Stored order reservation does not match current recipe demand");
      }
      if (existing.every((row) => row.status === "reserved")) return existing.map(mapOrderReservation);
      if (!existing.every((row) => row.status === "released")) {
        throw new InventoryConflictError("Order inventory reservations are in mixed states");
      }
    }

    const locked = await this.lockRequiredBalances(demand);
    this.assertBalancesSufficient(demand, locked);
    for (const row of demand) {
      const balance = await this.transaction.query(`
        UPDATE mbox.inventory_balances
        SET reserved_quantity = reserved_quantity + $4::numeric,
            updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND inventory_item_id = $3::uuid
          AND on_hand_quantity - reserved_quantity >= $4::numeric
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        row.inventory_item_id,
        row.required_quantity,
      ]);
      if (balance.rowCount !== 1) {
        throw new InsufficientInventoryError(row.sku, "0", row.required_quantity);
      }
      if (existing.length === 0) {
        await this.transaction.query(`
          INSERT INTO mbox.inventory_order_reservations (
            tenant_id, store_id, order_id, order_item_id, inventory_item_id,
            quantity, status, expires_at
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, 'reserved', $7::timestamptz)
        `, [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          orderId,
          row.order_item_id,
          row.inventory_item_id,
          row.required_quantity,
          order.fulfillment_expires_at,
        ]);
      } else {
        const restored = await this.transaction.query(`
          UPDATE mbox.inventory_order_reservations
          SET status = 'reserved', expires_at = $6::timestamptz,
              release_reason = NULL, released_at = NULL,
              reserved_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND order_item_id = $3::uuid AND inventory_item_id = $4::uuid
            AND order_id = $5::uuid AND status = 'released'
        `, [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          row.order_item_id,
          row.inventory_item_id,
          orderId,
          order.fulfillment_expires_at,
        ]);
        if (restored.rowCount !== 1) throw new InventoryConflictError("Released reservation could not be restored");
      }
    }
    return (await this.readOrderReservations(orderId, false)).map(mapOrderReservation);
  }

  async consumeImmediatePaymentReservations(
    orderId: string,
    options: Readonly<ConsumeInventoryOptions> = {},
  ): Promise<InventoryConsumption[]> {
    requireUuid("orderId", orderId);
    const reservations = await this.readOrderReservations(orderId, true);
    return this.consumeLockedReservations(reservations, options);
  }

  async consumeOrderItemReservations(
    orderItemId: string,
    options: Readonly<ConsumeInventoryOptions> = {},
  ): Promise<InventoryConsumption[]> {
    requireUuid("orderItemId", orderItemId);
    const reservations = await this.readOrderItemReservations(orderItemId, true);
    return this.consumeLockedReservations(reservations, {
      ...options,
      reason: options.reason ?? "production started",
    });
  }

  /**
   * A remake only reserves its second batch when the original task has already
   * consumed the order reservation.  Physical stock is consumed later, at the
   * replacement task's production start.  If the original reservation remains
   * reserved, the replacement task will use that original reservation once.
   */
  async reserveRemakeMaterials(input: Readonly<{
    orderItemId: string;
    remakeTaskId: string;
    originalTaskId: string;
  }>): Promise<InventoryRemakeReservation[]> {
    requireUuid("orderItemId", input.orderItemId);
    requireUuid("remakeTaskId", input.remakeTaskId);
    requireUuid("originalTaskId", input.originalTaskId);
    const reservations = await this.readOrderItemReservations(input.orderItemId, true);
    if (reservations.length === 0 || reservations.every((row) => row.status === "reserved")) return [];
    if (!reservations.every((row) => row.status === "consumed")) {
      throw new InventoryConflictError("Order item inventory reservations are in mixed states during remake");
    }

    await this.lockReservationBalances(reservations);
    const results: InventoryRemakeReservation[] = [];
    for (const reservation of reservations) {
      const quantity = normalizeDecimal(reservation.quantity);
      const balance = await this.transaction.query(`
        UPDATE mbox.inventory_balances
        SET reserved_quantity=reserved_quantity+$4::numeric,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
          AND on_hand_quantity-reserved_quantity>=$4::numeric
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        reservation.inventory_item_id,
        quantity,
      ]);
      if (balance.rowCount !== 1) {
        throw new InsufficientInventoryError(reservation.sku, "0", quantity);
      }
      const created = requireOne(
        await this.transaction.query<InventoryRemakeReservationRow>(`
          INSERT INTO mbox.kds_remake_inventory_reservations(
            tenant_id,store_id,remake_task_id,original_task_id,order_item_id,inventory_item_id,quantity,status
          ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::numeric,'reserved')
          RETURNING id,remake_task_id,original_task_id,order_item_id,inventory_item_id,
            (SELECT sku FROM mbox.inventory_items item
             WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.id=$6::uuid) AS sku,
            quantity::text,status,movement_id
        `, [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          input.remakeTaskId,
          input.originalTaskId,
          input.orderItemId,
          reservation.inventory_item_id,
          quantity,
        ]),
        "remake inventory reservation",
      );
      results.push(mapRemakeReservation(created));
    }
    return results;
  }

  /**
   * Consumes the additional remake batch when this replacement task actually
   * starts production.  The movement is recorded as waste because it is an
   * extra physical batch for an already-paid order item.
   */
  async consumeRemakeMaterials(
    remakeTaskId: string,
    options: Readonly<ConsumeInventoryOptions & { originalTaskId?: string | null }> = {},
  ): Promise<InventoryConsumption[]> {
    requireUuid("remakeTaskId", remakeTaskId);
    const reservations = await this.readRemakeReservations(remakeTaskId, true);
    const reserved = reservations.filter((row) => row.status === "reserved");
    if (reserved.length === 0) return [];
    await this.lockRemakeReservationBalances(reserved);
    const results: InventoryConsumption[] = [];
    for (const reservation of reserved) {
      const movement = await this.insertMovement({
        inventoryItemId: reservation.inventory_item_id,
        movementType: "waste",
        quantityDelta: `-${normalizeDecimal(reservation.quantity)}`,
        referenceType: "kds_remake",
        referenceId: remakeTaskId,
        orderItemId: reservation.order_item_id,
        reason: options.reason ?? "制作失败后重新制作的追加物料消耗",
        employeeId: options.createdByEmployeeId ?? null,
        metadata: {
          originalKdsTaskId: options.originalTaskId ?? reservation.original_task_id,
          remakeKdsTaskId: remakeTaskId,
          orderItemId: reservation.order_item_id,
          ...(options.metadata ?? {}),
        },
      });
      const balance = requireOne(
        await this.transaction.query<{ on_hand_quantity: string }>(`
          UPDATE mbox.inventory_balances
          SET on_hand_quantity=on_hand_quantity-$4::numeric,reserved_quantity=reserved_quantity-$4::numeric,
              last_movement_id=$5::uuid,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
            AND on_hand_quantity>=$4::numeric AND reserved_quantity>=$4::numeric
          RETURNING on_hand_quantity::text
        `, [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          reservation.inventory_item_id,
          reservation.quantity,
          movement,
        ]),
        "remake inventory consumption",
      );
      const consumed = await this.transaction.query(`
        UPDATE mbox.kds_remake_inventory_reservations
        SET status='consumed',movement_id=$4::uuid,consumed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='reserved'
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, reservation.id, movement]);
      if (consumed.rowCount !== 1) throw new InventoryConflictError("Remake inventory reservation lost its consume transition");
      results.push({
        movementId: movement,
        orderItemId: reservation.order_item_id,
        inventoryItemId: reservation.inventory_item_id,
        sku: reservation.sku,
        quantity: reservation.quantity,
        remainingOnHandQuantity: balance.on_hand_quantity,
      });
    }
    return results;
  }

  async releaseRemakeMaterials(remakeTaskId: string, reason: string): Promise<number> {
    requireUuid("remakeTaskId", remakeTaskId);
    if (reason.trim().length < 3 || reason.length > 300) throw new TypeError("release reason is invalid");
    const reservations = await this.readRemakeReservations(remakeTaskId, true);
    const reserved = reservations.filter((row) => row.status === "reserved");
    if (reserved.length === 0) return 0;
    await this.lockRemakeReservationBalances(reserved);
    for (const reservation of reserved) {
      const balance = await this.transaction.query(`
        UPDATE mbox.inventory_balances
        SET reserved_quantity=reserved_quantity-$4::numeric,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
          AND reserved_quantity>=$4::numeric
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        reservation.inventory_item_id,
        reservation.quantity,
      ]);
      if (balance.rowCount !== 1) throw new InventoryConflictError("Remake reserved inventory balance is inconsistent");
      const released = await this.transaction.query(`
        UPDATE mbox.kds_remake_inventory_reservations
        SET status='released',release_reason=$4,released_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='reserved'
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, reservation.id, reason.trim()]);
      if (released.rowCount !== 1) throw new InventoryConflictError("Remake inventory reservation lost its release transition");
    }
    return reserved.length;
  }

  private async consumeLockedReservations(
    reservations: readonly InventoryOrderReservationRow[],
    options: Readonly<ConsumeInventoryOptions>,
  ): Promise<InventoryConsumption[]> {
    if (reservations.length === 0) return [];
    if (reservations.every((row) => row.status === "consumed")) return [];
    if (!reservations.every((row) => row.status === "reserved")) {
      throw new InventoryConflictError("Only reserved inventory can be consumed after payment");
    }
    await this.lockReservationBalances(reservations);
    const results: InventoryConsumption[] = [];
    for (const reservation of reservations) {
      const movement = await this.insertMovement({
        inventoryItemId: reservation.inventory_item_id,
        movementType: "sale",
        quantityDelta: `-${normalizeDecimal(reservation.quantity)}`,
        referenceType: "order_item",
        referenceId: reservation.order_item_id,
        orderItemId: reservation.order_item_id,
        reason: options.reason ?? "payment succeeded",
        employeeId: options.createdByEmployeeId ?? null,
        metadata: options.metadata,
      });
      const balance = requireOne(
        await this.transaction.query<{ on_hand_quantity: string }>(`
          UPDATE mbox.inventory_balances
          SET on_hand_quantity = on_hand_quantity - $4::numeric,
              reserved_quantity = reserved_quantity - $4::numeric,
              last_movement_id = $5::uuid, updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND inventory_item_id = $3::uuid
            AND on_hand_quantity >= $4::numeric AND reserved_quantity >= $4::numeric
          RETURNING on_hand_quantity::text
        `, [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          reservation.inventory_item_id,
          reservation.quantity,
          movement,
        ]),
        "reserved inventory consumption",
      );
      const consumed = await this.transaction.query(`
        UPDATE mbox.inventory_order_reservations
        SET status = 'consumed', expires_at = NULL, movement_id = $4::uuid,
            consumed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND id = $3::uuid AND status = 'reserved'
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, reservation.id, movement]);
      if (consumed.rowCount !== 1) throw new InventoryConflictError("Inventory reservation lost its consume transition");
      results.push({
        movementId: movement,
        orderItemId: reservation.order_item_id,
        inventoryItemId: reservation.inventory_item_id,
        sku: reservation.sku,
        quantity: reservation.quantity,
        remainingOnHandQuantity: balance.on_hand_quantity,
      });
    }
    return results;
  }

  async releaseImmediatePaymentReservations(orderId: string, reason: string): Promise<number> {
    requireUuid("orderId", orderId);
    if (reason.trim().length < 3 || reason.length > 300) throw new TypeError("release reason is invalid");
    const reservations = await this.readOrderReservations(orderId, true);
    const reserved = reservations.filter((row) => row.status === "reserved");
    if (reserved.length === 0) return 0;
    await this.lockReservationBalances(reserved);
    for (const reservation of reserved) {
      const balance = await this.transaction.query(`
        UPDATE mbox.inventory_balances
        SET reserved_quantity = reserved_quantity - $4::numeric,
            updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND inventory_item_id = $3::uuid AND reserved_quantity >= $4::numeric
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        reservation.inventory_item_id,
        reservation.quantity,
      ]);
      if (balance.rowCount !== 1) throw new InventoryConflictError("Reserved inventory balance is inconsistent");
      const released = await this.transaction.query(`
        UPDATE mbox.inventory_order_reservations
        SET status = 'released', expires_at = NULL, release_reason = $4,
            released_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND id = $3::uuid AND status = 'reserved'
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, reservation.id, reason.trim()]);
      if (released.rowCount !== 1) throw new InventoryConflictError("Inventory reservation lost its release transition");
    }
    return reserved.length;
  }

  private async readOrderReservations(
    orderId: string,
    lock: boolean,
  ): Promise<InventoryOrderReservationRow[]> {
    const result = await this.transaction.query<InventoryOrderReservationRow>(`
      SELECT reservation.id, reservation.order_id, reservation.order_item_id,
        reservation.inventory_item_id, item.sku, reservation.quantity::text,
        reservation.status, reservation.expires_at::text, reservation.movement_id
      FROM mbox.inventory_order_reservations AS reservation
      JOIN mbox.inventory_items AS item
        ON item.tenant_id = reservation.tenant_id AND item.store_id = reservation.store_id
       AND item.id = reservation.inventory_item_id
      WHERE reservation.tenant_id = $1::uuid AND reservation.store_id = $2::uuid
        AND reservation.order_id = $3::uuid
      ORDER BY reservation.inventory_item_id, reservation.order_item_id
      ${lock ? "FOR UPDATE OF reservation" : ""}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId]);
    return result.rows;
  }

  private async readOrderItemReservations(
    orderItemId: string,
    lock: boolean,
  ): Promise<InventoryOrderReservationRow[]> {
    const result = await this.transaction.query<InventoryOrderReservationRow>(`
      SELECT reservation.id,reservation.order_id,reservation.order_item_id,
        reservation.inventory_item_id,item.sku,reservation.quantity::text,
        reservation.status,reservation.expires_at::text,reservation.movement_id
      FROM mbox.inventory_order_reservations reservation
      JOIN mbox.inventory_items item
        ON item.tenant_id=reservation.tenant_id AND item.store_id=reservation.store_id
       AND item.id=reservation.inventory_item_id
      WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
        AND reservation.order_item_id=$3::uuid
      ORDER BY reservation.inventory_item_id
      ${lock ? "FOR UPDATE OF reservation" : ""}
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,orderItemId]);
    return result.rows;
  }

  private async readRemakeReservations(
    remakeTaskId: string,
    lock: boolean,
  ): Promise<InventoryRemakeReservationRow[]> {
    const result = await this.transaction.query<InventoryRemakeReservationRow>(`
      SELECT reservation.id,reservation.remake_task_id,reservation.original_task_id,reservation.order_item_id,
        reservation.inventory_item_id,item.sku,reservation.quantity::text,reservation.status,reservation.movement_id
      FROM mbox.kds_remake_inventory_reservations AS reservation
      JOIN mbox.inventory_items AS item
        ON item.tenant_id=reservation.tenant_id AND item.store_id=reservation.store_id
       AND item.id=reservation.inventory_item_id
      WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
        AND reservation.remake_task_id=$3::uuid
      ORDER BY reservation.inventory_item_id
      ${lock ? "FOR UPDATE OF reservation" : ""}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, remakeTaskId]);
    return result.rows;
  }

  private async lockReservationBalances(
    reservations: readonly InventoryOrderReservationRow[],
  ): Promise<void> {
    const inventoryItemIds = [...new Set(reservations.map((row) => row.inventory_item_id))].sort();
    const locked = await this.transaction.query(`
      SELECT inventory_item_id
      FROM mbox.inventory_balances
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND inventory_item_id = ANY($3::uuid[])
      ORDER BY inventory_item_id
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, inventoryItemIds]);
    if (locked.rowCount !== inventoryItemIds.length) {
      throw new InventoryBalanceMissingError(inventoryItemIds[0] ?? "unknown");
    }
  }

  private async lockRemakeReservationBalances(
    reservations: readonly InventoryRemakeReservationRow[],
  ): Promise<void> {
    const inventoryItemIds = [...new Set(reservations.map((row) => row.inventory_item_id))].sort();
    const locked = await this.transaction.query(`
      SELECT inventory_item_id
      FROM mbox.inventory_balances
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=ANY($3::uuid[])
      ORDER BY inventory_item_id
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, inventoryItemIds]);
    if (locked.rowCount !== inventoryItemIds.length) {
      throw new InventoryBalanceMissingError(inventoryItemIds[0] ?? "unknown");
    }
  }

  private async transitionStockCount(
    countId: string,
    from: string,
    to: StockCountRecord["status"],
    employeeId: string,
  ): Promise<StockCountRecord> {
    const result = await this.transaction.query<StockCountRow>(
      `
      UPDATE mbox.inventory_stock_counts
      SET status = $4, submitted_by_employee_id = CASE WHEN $4 = 'submitted' THEN $5::uuid ELSE submitted_by_employee_id END,
          submitted_at = CASE WHEN $4 = 'submitted' THEN clock_timestamp() ELSE submitted_at END,
          updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = $6
      RETURNING id, public_id, status, created_by_employee_id
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        countId,
        to,
        employeeId,
        from,
      ],
    );
    if (result.rowCount !== 1 || !result.rows[0])
      throw new InventoryConflictError(
        `Stock count cannot transition from ${from} to ${to}`,
      );
    return mapCount(result.rows[0]);
  }

  private async lockStockCount(countId: string): Promise<StockCountRow> {
    const result = await this.transaction.query<StockCountRow>(
      `
      SELECT id, public_id, status, created_by_employee_id
      FROM mbox.inventory_stock_counts
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        countId,
      ],
    );
    if (!result.rows[0])
      throw new InventoryNotFoundError("stock count", countId);
    return result.rows[0];
  }

  private async lockBottle(bottleId: string): Promise<StoredBottleRow> {
    const result = await this.transaction.query<StoredBottleRow>(
      `
      SELECT id, public_id, inventory_item_id, current_table_session_id,
        original_quantity::text, remaining_quantity::text, status
      FROM mbox.stored_bottles
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        bottleId,
      ],
    );
    if (!result.rows[0])
      throw new InventoryNotFoundError("stored bottle", bottleId);
    return result.rows[0];
  }

  private async insertBottleEvent(
    bottleId: string,
    type: string,
    delta: string,
    employeeId: string,
    fromSession: string | null,
    toSession: string | null,
    reason: string,
  ): Promise<void> {
    await this.transaction.query(
      `
      INSERT INTO mbox.stored_bottle_events (
        tenant_id, store_id, stored_bottle_id, event_type, quantity_delta,
        from_table_session_id, to_table_session_id, reason, created_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric,
        $6::uuid, $7::uuid, $8, $9::uuid)
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        bottleId,
        type,
        delta,
        fromSession,
        toSession,
        reason,
        employeeId,
      ],
    );
  }

  private async assertOpenTableSession(tableSessionId: string): Promise<void> {
    const result = await this.transaction.query(
      `
      SELECT id FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status IN ('open', 'closing')
      FOR SHARE
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        tableSessionId,
      ],
    );
    if (result.rowCount !== 1)
      throw new InventoryNotFoundError("open table session", tableSessionId);
  }

  private async lockOrCreateBalance(inventoryItemId: string): Promise<LockedBalanceState> {
    await this.transaction.query(
      `
      INSERT INTO mbox.inventory_balances (tenant_id, store_id, inventory_item_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid)
      ON CONFLICT (tenant_id, store_id, inventory_item_id) DO NOTHING
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        inventoryItemId,
      ],
    );
    const result = await this.transaction.query<BalanceStateRow>(
      `
      SELECT on_hand_quantity::text,weighted_unit_cost_minor::text,
        latest_purchase_unit_cost_minor::text,cost_status,cost_basis
      FROM mbox.inventory_balances
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND inventory_item_id = $3::uuid
      FOR UPDATE
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        inventoryItemId,
      ],
    );
    if (!result.rows[0])
      throw new InventoryBalanceMissingError(inventoryItemId);
    const row = result.rows[0];
    return {
      onHandQuantity: row.on_hand_quantity,
      weightedUnitCostMinor: row.weighted_unit_cost_minor,
      latestPurchaseUnitCostMinor: row.latest_purchase_unit_cost_minor,
      costStatus: row.cost_status,
    };
  }

  private async updateBalance(
    inventoryItemId: string,
    quantity: string,
    movementId: string,
  ): Promise<void> {
    const result = await this.transaction.query(
      `
      UPDATE mbox.inventory_balances
      SET on_hand_quantity = $4::numeric, last_movement_id = $5::uuid, updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND inventory_item_id = $3::uuid
        AND $4::numeric >= reserved_quantity
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        inventoryItemId,
        quantity,
        movementId,
      ],
    );
    if (result.rowCount !== 1)
      throw new InventoryConflictError(
        "Inventory balance update would violate reserved stock",
      );
  }

  private async receivePurchasedBalance(
    inventoryItemId: string,
    quantity: string,
    unitCostMinor: string,
    movementId: string,
  ): Promise<void> {
    const result = await this.transaction.query(
      `
      UPDATE mbox.inventory_balances
      SET on_hand_quantity=on_hand_quantity+$4::numeric,
          weighted_unit_cost_minor=CASE
            WHEN on_hand_quantity=0 THEN $5::numeric
            WHEN cost_status='complete' AND weighted_unit_cost_minor IS NOT NULL
              THEN ROUND(((on_hand_quantity*weighted_unit_cost_minor)+($4::numeric*$5::numeric))
                /(on_hand_quantity+$4::numeric),6)
            ELSE NULL
          END,
          latest_purchase_unit_cost_minor=$5::numeric,
          cost_status=CASE
            WHEN on_hand_quantity=0 THEN 'complete'
            WHEN cost_status='complete' AND weighted_unit_cost_minor IS NOT NULL THEN 'complete'
            ELSE 'needs_review'
          END,
          cost_basis=CASE
            WHEN on_hand_quantity=0 THEN 'moving_weighted_average'
            WHEN cost_status='complete' AND weighted_unit_cost_minor IS NOT NULL THEN 'moving_weighted_average'
            ELSE 'none'
          END,
          last_movement_id=$6::uuid,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
      `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        inventoryItemId,
        quantity,
        unitCostMinor,
        movementId,
      ],
    );
    if (result.rowCount !== 1)
      throw new InventoryBalanceMissingError(inventoryItemId);
  }

  private async updateBalanceCostState(
    inventoryItemId: string,
    weightedUnitCostMinor: string | null,
    costStatus: InventoryCostStatus,
    costBasis: InventoryCostBasis,
  ): Promise<void> {
    const result = await this.transaction.query(
      `
      UPDATE mbox.inventory_balances
      SET weighted_unit_cost_minor=$4::numeric,cost_status=$5,cost_basis=$6,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
      `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        inventoryItemId,
        weightedUnitCostMinor,
        costStatus,
        costBasis,
      ],
    );
    if (result.rowCount !== 1)
      throw new InventoryBalanceMissingError(inventoryItemId);
  }

  private async insertMovement(input: {
    inventoryItemId: string;
    movementType: string;
    quantityDelta: string;
    unitCostMinor?: string | null;
    referenceType: string;
    referenceId?: string | null;
    orderItemId?: string | null;
    reason?: string | null;
    metadata?: JsonObject;
    employeeId?: string | null;
  }): Promise<string> {
    const row = requireOne(
      await this.transaction.query<{ id: string }>(
        `
      INSERT INTO mbox.inventory_movements (
        tenant_id, store_id, inventory_item_id, movement_type, quantity_delta,
        unit_cost_minor, currency, reference_type, reference_id, order_item_id,
        reason, metadata, created_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric,
        $6::numeric, 'CNY', $7, $8::uuid, $9::uuid, $10, $11::jsonb, $12::uuid)
      RETURNING id
    `,
        [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          input.inventoryItemId,
          input.movementType,
          input.quantityDelta,
          input.unitCostMinor ?? null,
          input.referenceType,
          input.referenceId ?? null,
          input.orderItemId ?? null,
          input.reason ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.employeeId ?? null,
        ],
      ),
      "inventory movement insert",
    );
    return row.id;
  }

  private async loadRecipeDemand(
    orderItems: readonly OrderItem[],
  ): Promise<DemandRow[]> {
    const result = await this.transaction.query<DemandRow>(
      `
      WITH ordered AS (
        SELECT order_item_id, product_id, ordered_quantity
        FROM jsonb_to_recordset($3::jsonb)
          AS line(order_item_id uuid, product_id uuid, ordered_quantity integer)
      )
      SELECT ordered.order_item_id, recipe_item.inventory_item_id, inventory_item.sku,
        (((recipe_item.quantity + recipe_item.expected_waste_quantity)
          * ordered.ordered_quantity::numeric) / recipe.yield_quantity::numeric)::numeric(18,6)::text AS required_quantity
      FROM ordered
      JOIN mbox.products AS product ON product.tenant_id = $1::uuid AND product.store_id = $2::uuid
        AND product.id = ordered.product_id AND product.inventory_control_mode = 'tracked'
      JOIN mbox.recipes AS recipe ON recipe.tenant_id = $1::uuid AND recipe.store_id = $2::uuid
        AND recipe.product_id = ordered.product_id AND recipe.status = 'active'
        AND recipe.effective_at <= clock_timestamp()
      JOIN mbox.recipe_items AS recipe_item ON recipe_item.tenant_id = recipe.tenant_id
        AND recipe_item.store_id = recipe.store_id AND recipe_item.recipe_id = recipe.id
      JOIN mbox.inventory_items AS inventory_item ON inventory_item.tenant_id = recipe_item.tenant_id
        AND inventory_item.store_id = recipe_item.store_id AND inventory_item.id = recipe_item.inventory_item_id
        AND inventory_item.status = 'active'
      ORDER BY recipe_item.inventory_item_id, ordered.order_item_id
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        JSON.stringify(
          orderItems.map((item) => ({
            order_item_id: item.id,
            product_id: item.productId,
            ordered_quantity: item.quantity,
          })),
        ),
      ],
    );
    return result.rows;
  }

  private async loadTrackedInventoryOrderItemIds(
    orderItems: readonly OrderItem[],
  ): Promise<Set<string>> {
    const result = await this.transaction.query<{ order_item_id: string }>(
      `
      WITH ordered AS (
        SELECT order_item_id, product_id
        FROM jsonb_to_recordset($3::jsonb)
          AS line(order_item_id uuid, product_id uuid)
      )
      SELECT ordered.order_item_id
      FROM ordered
      JOIN mbox.products AS product
        ON product.tenant_id = $1::uuid AND product.store_id = $2::uuid
       AND product.id = ordered.product_id
      WHERE product.inventory_control_mode = 'tracked'
        AND product.fulfillment_station IN ('bar', 'kitchen')
      `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        JSON.stringify(orderItems.map((item) => ({ order_item_id: item.id, product_id: item.productId }))),
      ],
    );
    return new Set(result.rows.map((row) => row.order_item_id));
  }

  private async lockRequiredBalances(
    demand: readonly DemandRow[],
  ): Promise<LockedBalanceRow[]> {
    const result = await this.transaction.query<LockedBalanceRow>(
      `
      WITH demand AS (
        SELECT inventory_item_id, sku, required_quantity
        FROM jsonb_to_recordset($3::jsonb)
          AS item(inventory_item_id uuid, sku text, required_quantity numeric)
      ), required AS (
        SELECT inventory_item_id, min(sku) AS sku, sum(required_quantity)::numeric(18,6) AS required_quantity
        FROM demand GROUP BY inventory_item_id
      )
      SELECT balance.inventory_item_id, required.sku, balance.on_hand_quantity::text,
        balance.reserved_quantity::text, required.required_quantity::text,
        (balance.on_hand_quantity - balance.reserved_quantity < required.required_quantity) AS insufficient
      FROM required
      JOIN mbox.inventory_balances AS balance ON balance.tenant_id = $1::uuid AND balance.store_id = $2::uuid
        AND balance.inventory_item_id = required.inventory_item_id
      ORDER BY balance.inventory_item_id FOR UPDATE OF balance
    `,
      [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        JSON.stringify(
          demand.map((row) => ({
            inventory_item_id: row.inventory_item_id,
            sku: row.sku,
            required_quantity: row.required_quantity,
          })),
        ),
      ],
    );
    return result.rows;
  }

  private assertBalancesSufficient(
    demand: readonly DemandRow[],
    locked: readonly LockedBalanceRow[],
  ): void {
    const requiredIds = new Set(demand.map((row) => row.inventory_item_id));
    const lockedById = new Map(
      locked.map((row) => [row.inventory_item_id, row]),
    );
    for (const inventoryItemId of [...requiredIds].toSorted()) {
      const balance = lockedById.get(inventoryItemId);
      if (!balance) throw new InventoryBalanceMissingError(inventoryItemId);
      if (balance.insufficient)
        throw new InsufficientInventoryError(
          balance.sku,
          subtractDecimal(balance.on_hand_quantity, balance.reserved_quantity),
          balance.required_quantity,
        );
    }
  }
}

function assertInventoryItemUnitPolicy(input: {
  baseUnit: string;
  categoryCode: string;
  packageVolumeMl: string | null;
  changingExistingItem: boolean;
}): void {
  if (!isLiquidInventoryCategory(input.categoryCode)) return;
  if (input.baseUnit !== 'ml') {
    throw new InventoryConflictError(input.changingExistingItem
      ? '历史瓶装或件装物料不能直接改成酒水品类；请新建按毫升管理的替代物料，再按盘点/迁移流程衔接库存'
      : '酒水、葡萄酒、啤酒、糖浆和果汁必须按毫升（ml）建库存');
  }
  if (input.packageVolumeMl === null) {
    throw new InventoryConflictError('按毫升管理的酒水必须填写单瓶净含量（ml/瓶），否则无法安全换算入库量和单位成本');
  }
}

function mapItem(row: InventoryItemRow): InventoryItemRecord {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    itemType: row.item_type,
    baseUnit: row.base_unit,
    categoryCode: row.category_code,
    lowStockThreshold: row.low_stock_threshold,
    wholeUnitCount: row.whole_unit_count,
    reasonableWasteQuantity: row.reasonable_waste_quantity,
    packageVolumeMl: row.package_volume_ml,
    status: row.status,
  };
}

function mapOrderReservation(row: InventoryOrderReservationRow): InventoryOrderReservation {
  return {
    id: row.id,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    inventoryItemId: row.inventory_item_id,
    sku: row.sku,
    quantity: row.quantity,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

function mapRemakeReservation(row: InventoryRemakeReservationRow): InventoryRemakeReservation {
  return {
    id: row.id,
    remakeTaskId: row.remake_task_id,
    originalTaskId: row.original_task_id,
    orderItemId: row.order_item_id,
    inventoryItemId: row.inventory_item_id,
    sku: row.sku,
    quantity: row.quantity,
    status: row.status,
  };
}

function mapReceipt(row: ReceiptRow): PurchaseReceiptRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    status: row.status,
    currency: row.currency,
    lineCount: Number(row.line_count),
    receivedAt: row.received_at,
  };
}

function mapCount(row: StockCountRow): StockCountRecord {
  return { id: row.id, publicId: row.public_id, status: row.status };
}

function mapBottle(row: StoredBottleRow): StoredBottleRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    inventoryItemId: row.inventory_item_id,
    tableSessionId: row.current_table_session_id,
    originalQuantity: row.original_quantity,
    remainingQuantity: row.remaining_quantity,
    status: row.status,
  };
}

function normalizeDecimal(value: string): string {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value))
    throw new TypeError(`Invalid decimal quantity: ${value}`);
  const [integer, fraction = ""] = value.split(".");
  return `${integer}.${fraction.padEnd(6, "0")}`;
}

function requireMinorAmount(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) throw new TypeError(`${label} must be a non-negative integer minor amount`);
  return BigInt(value);
}

function decimalToBigInt(value: string): bigint {
  const normalized = normalizeDecimal(value);
  const negative = normalized.startsWith("-");
  const [integer = "0", fraction = ""] = normalized.replace("-", "").split(".");
  const result = BigInt(integer) * 1_000_000n + BigInt(fraction);
  return negative ? -result : result;
}

function bigIntToDecimal(value: bigint): string {
  const sign = value < 0 ? "-" : "";
  const absolute = value < 0 ? -value : value;
  return `${sign}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}

function subtractDecimal(left: string, right: string): string {
  return bigIntToDecimal(decimalToBigInt(left) - decimalToBigInt(right));
}

function compareDecimal(left: string, right: string): number {
  const delta = decimalToBigInt(left) - decimalToBigInt(right);
  return delta < 0 ? -1 : delta > 0 ? 1 : 0;
}

function isZeroDecimal(value: string): boolean {
  return decimalToBigInt(value) === 0n;
}

function roundMinorDecimalTotal(values: readonly string[]): number {
  const micros = values.reduce((total, value) => total + decimalToBigInt(value), 0n);
  if (micros < 0n) throw new InventoryConflictError('配方成本不能为负数');
  // Recipe components remain precise to six decimal places. Round only once,
  // after their exact sum, to the integer minor currency unit stored on a sale.
  const rounded = (micros + 500_000n) / 1_000_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER))
    throw new InventoryConflictError('配方成本超出允许范围');
  return Number(rounded);
}

function roundDecimalProductToMinor(left: string, right: string): string {
  const product = decimalToBigInt(left) * decimalToBigInt(right);
  if (product < 0n) throw new InventoryConflictError('成本不能为负数');
  // Both operands retain six decimal places.  Round the final total once to
  // the currency minor unit, matching recipe and order-cost rounding.
  return ((product + 500_000_000_000n) / 1_000_000_000_000n).toString();
}

function requireUuid(name: string, value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new TypeError(`${name} must be a UUID`);
}

function requireOne<Row extends Record<string, unknown>>(
  result: { rows: Row[]; rowCount: number | null },
  operation: string,
): Row {
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined)
    throw new Error(`${operation} did not affect exactly one row`);
  return row;
}
