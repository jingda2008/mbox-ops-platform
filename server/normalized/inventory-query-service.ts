import type { JsonObject } from "./command-executor.js";
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
} from "./staff-access-repository.js";
import type { StoreScope } from "./transaction-runner.js";
import { ScopedPostgresTransactionRunner } from "./transaction-runner.js";
import { InventoryRepository, type RecipeCostPreview } from './inventory-repository.js';

export interface InventoryItemView {
  id: string;
  sku: string;
  name: string;
  itemType: string;
  baseUnit: string;
  categoryCode: string;
  onHandQuantity: string;
  reservedQuantity: string;
  availableQuantity: string;
  lowStockThreshold: string | null;
  lowStock: boolean;
  wholeUnitCount: boolean;
  reasonableWasteQuantity: string;
  latestUnitCostMinor?: string | null;
}

export interface PurchaseReceiptView {
  id: string;
  publicId: string;
  status: string;
  currency: string;
  invoiceTotalMinor?: string | null;
  supplierRef?: string | null;
  supplier?: JsonObject;
  lineCount: number;
  lines: Array<{
    inventoryItemId: string;
    itemName: string;
    batchCode: string;
    quantity: string;
    baseUnit: string;
  }>;
  createdAt: string;
  receivedAt: string | null;
}

export interface StoredBottleView {
  id: string;
  publicId: string;
  inventoryItemId: string;
  itemName: string;
  tableSessionId: string;
  tableCode: string;
  remainingQuantity: string;
  status: string;
  holderDisplayName: string | null;
  holderContactToken?: string | null;
  updatedAt: string;
}

export interface InventoryDashboard {
  items: InventoryItemView[];
  lowStockCount: number;
  receipts: PurchaseReceiptView[];
  storedBottles: StoredBottleView[];
  visibility: { costs: boolean; supplierDetails: boolean; allTables: boolean };
}

export interface ActiveRecipeView {
  id: string;
  productId: string;
  version: number;
  yieldQuantity: number;
  instructionsSnapshot: JsonObject;
  components: Array<{
    inventoryItemId: string;
    sku: string;
    name: string;
    baseUnit: string;
    quantity: string;
    expectedWasteQuantity: string;
  }>;
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  sku: string;
  name: string;
  item_type: string;
  base_unit: string;
  category_code: string;
  on_hand_quantity: string;
  reserved_quantity: string;
  available_quantity: string;
  low_stock_threshold: string | null;
  low_stock: boolean;
  whole_unit_count: boolean;
  reasonable_waste_quantity: string;
  latest_unit_cost_minor: string | null;
}

interface ReceiptRow extends Record<string, unknown> {
  id: string;
  public_id: string;
  status: string;
  currency: string;
  invoice_total_minor: string | null;
  supplier_ref: string | null;
  supplier_snapshot: JsonObject;
  line_count: string;
  lines: Array<{
    inventoryItemId: string;
    itemName: string;
    batchCode: string;
    quantity: string;
    baseUnit: string;
  }>;
  created_at: string;
  received_at: string | null;
}

interface BottleRow extends Record<string, unknown> {
  id: string;
  public_id: string;
  inventory_item_id: string;
  item_name: string;
  table_session_id: string;
  table_code: string;
  remaining_quantity: string;
  status: string;
  holder_display_name: string | null;
  holder_contact_token: string | null;
  updated_at: string;
}

export class InventoryQueryService {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  getDashboard(
    scope: Readonly<StoreScope>,
    employeeId: string,
  ): Promise<InventoryDashboard> {
    return this.transactions.run(
      scope,
      async (transaction) => {
        const access = await new StaffAccessRepository(
          transaction,
        ).assertPermission(employeeId, "inventory.view");
        const canViewCosts = access.permissions.includes("inventory.cost.view");
        const canViewBottles =
          access.permissions.includes("bottle.view") ||
          access.permissions.includes("bottle.manage") ||
          access.permissions.includes("bottle.manage.all");
        const canManageAllBottles =
          access.permissions.includes("bottle.manage.all");
        const canViewBottleContact =
          access.permissions.includes("bottle.manage") || canManageAllBottles;

        const items = await transaction.query<ItemRow>(
          `
        SELECT item.id, item.sku, item.name, item.item_type, item.base_unit,
          item.category_code, balance.on_hand_quantity::text, balance.reserved_quantity::text,
          (balance.on_hand_quantity - balance.reserved_quantity)::text AS available_quantity,
          item.low_stock_threshold::text,
          (item.low_stock_threshold IS NOT NULL
            AND balance.on_hand_quantity - balance.reserved_quantity <= item.low_stock_threshold) AS low_stock,
          item.whole_unit_count, item.reasonable_waste_quantity::text,
          CASE WHEN $3::boolean THEN (
            SELECT line.unit_cost_minor::text
            FROM mbox.purchase_receipt_lines AS line
            JOIN mbox.purchase_receipts AS receipt
              ON receipt.tenant_id = line.tenant_id AND receipt.store_id = line.store_id
             AND receipt.id = line.receipt_id AND receipt.status = 'received'
            WHERE line.tenant_id = item.tenant_id AND line.store_id = item.store_id
              AND line.inventory_item_id = item.id
            ORDER BY receipt.received_at DESC, line.id DESC LIMIT 1
          ) ELSE NULL END AS latest_unit_cost_minor
        FROM mbox.inventory_items AS item
        JOIN mbox.inventory_balances AS balance
          ON balance.tenant_id = item.tenant_id AND balance.store_id = item.store_id
         AND balance.inventory_item_id = item.id
        WHERE item.tenant_id = $1::uuid AND item.store_id = $2::uuid AND item.status = 'active'
        ORDER BY low_stock DESC, item.category_code, item.name, item.id
      `,
          [scope.tenantId, scope.storeId, canViewCosts],
        );

        const receipts = await transaction.query<ReceiptRow>(
          `
        SELECT receipt.id, receipt.public_id, receipt.status, receipt.currency,
          CASE WHEN $3::boolean THEN receipt.invoice_total_minor::text ELSE NULL END AS invoice_total_minor,
          CASE WHEN $3::boolean THEN receipt.supplier_ref ELSE NULL END AS supplier_ref,
          CASE WHEN $3::boolean THEN receipt.supplier_snapshot ELSE '{}'::jsonb END AS supplier_snapshot,
          count(line.id)::text AS line_count,
          COALESCE(jsonb_agg(jsonb_build_object(
            'inventoryItemId', item.id,
            'itemName', item.name,
            'batchCode', line.batch_code,
            'quantity', line.quantity::text,
            'baseUnit', item.base_unit
          ) ORDER BY line.id) FILTER (WHERE line.id IS NOT NULL), '[]'::jsonb) AS lines,
          receipt.created_at::text, receipt.received_at::text
        FROM mbox.purchase_receipts AS receipt
        LEFT JOIN mbox.purchase_receipt_lines AS line
          ON line.tenant_id = receipt.tenant_id AND line.store_id = receipt.store_id
         AND line.receipt_id = receipt.id
        LEFT JOIN mbox.inventory_items AS item
          ON item.tenant_id = line.tenant_id AND item.store_id = line.store_id
         AND item.id = line.inventory_item_id
        WHERE receipt.tenant_id = $1::uuid AND receipt.store_id = $2::uuid
        GROUP BY receipt.id
        ORDER BY CASE WHEN receipt.status = 'draft' THEN 0 ELSE 1 END,
          receipt.created_at DESC, receipt.id DESC LIMIT 100
      `,
          [scope.tenantId, scope.storeId, canViewCosts],
        );

        const bottles = canViewBottles
          ? await transaction.query<BottleRow>(
              `
        SELECT bottle.id, bottle.public_id, bottle.inventory_item_id, item.name AS item_name,
          session.id AS table_session_id, venue_table.code AS table_code,
          bottle.remaining_quantity::text, bottle.status, bottle.holder_display_name,
          CASE WHEN $4::boolean THEN bottle.holder_contact_token ELSE NULL END AS holder_contact_token,
          bottle.updated_at::text
        FROM mbox.stored_bottles AS bottle
        JOIN mbox.inventory_items AS item
          ON item.tenant_id = bottle.tenant_id AND item.store_id = bottle.store_id
         AND item.id = bottle.inventory_item_id
        JOIN mbox.table_sessions AS session
          ON session.tenant_id = bottle.tenant_id AND session.store_id = bottle.store_id
         AND session.id = bottle.current_table_session_id
        JOIN mbox.tables AS venue_table
          ON venue_table.tenant_id = session.tenant_id AND venue_table.store_id = session.store_id
         AND venue_table.id = session.table_id
        WHERE bottle.tenant_id = $1::uuid AND bottle.store_id = $2::uuid
          AND bottle.status IN ('stored', 'in_use')
          AND (
            $3::boolean OR EXISTS (
              SELECT 1 FROM mbox.table_assignments AS assignment
              WHERE assignment.tenant_id = session.tenant_id AND assignment.store_id = session.store_id
                AND assignment.table_id = session.table_id AND assignment.employee_id = $5::uuid
                AND assignment.starts_at <= clock_timestamp()
                AND (assignment.ends_at IS NULL OR assignment.ends_at > clock_timestamp())
            )
          )
        ORDER BY venue_table.code, bottle.updated_at DESC, bottle.id
      `,
              [
                scope.tenantId,
                scope.storeId,
                canManageAllBottles,
                canViewBottleContact,
                employeeId,
              ],
            )
          : { rows: [] };

        const itemViews = items.rows.map((row) => ({
          id: row.id,
          sku: row.sku,
          name: row.name,
          itemType: row.item_type,
          baseUnit: row.base_unit,
          categoryCode: row.category_code,
          onHandQuantity: row.on_hand_quantity,
          reservedQuantity: row.reserved_quantity,
          availableQuantity: row.available_quantity,
          lowStockThreshold: row.low_stock_threshold,
          lowStock: row.low_stock,
          wholeUnitCount: row.whole_unit_count,
          reasonableWasteQuantity: row.reasonable_waste_quantity,
          ...(canViewCosts
            ? { latestUnitCostMinor: row.latest_unit_cost_minor }
            : {}),
        }));
        return {
          items: itemViews,
          lowStockCount: itemViews.filter((item) => item.lowStock).length,
          receipts: receipts.rows.map((row) => ({
            id: row.id,
            publicId: row.public_id,
            status: row.status,
            currency: row.currency,
            lineCount: Number(row.line_count),
            createdAt: row.created_at,
            receivedAt: row.received_at,
            ...(canViewCosts
              ? {
                  invoiceTotalMinor: row.invoice_total_minor,
                  supplierRef: row.supplier_ref,
                  supplier: row.supplier_snapshot,
                }
              : {}),
            lines: row.lines,
          })),
          storedBottles: bottles.rows.map((row) => ({
            id: row.id,
            publicId: row.public_id,
            inventoryItemId: row.inventory_item_id,
            itemName: row.item_name,
            tableSessionId: row.table_session_id,
            tableCode: row.table_code,
            remainingQuantity: row.remaining_quantity,
            status: row.status,
            holderDisplayName: row.holder_display_name,
            updatedAt: row.updated_at,
            ...(canViewBottleContact
              ? { holderContactToken: row.holder_contact_token }
              : {}),
          })),
          visibility: {
            costs: canViewCosts,
            supplierDetails: canViewCosts,
            allTables: canManageAllBottles,
          },
        };
      },
      { readOnly: true },
    );
  }

  getActiveRecipe(
    scope: Readonly<StoreScope>,
    employeeId: string,
    productId: string,
  ): Promise<ActiveRecipeView | null> {
    return this.transactions.run(
      scope,
      async (transaction) => {
        await new StaffAccessRepository(transaction).assertPermission(
          employeeId,
          "inventory.manage",
        );
        const recipe = await transaction.query<{
          id: string;
          product_id: string;
          version: number;
          yield_quantity: number;
          instructions_snapshot: JsonObject;
        }>(
          `
          SELECT id, product_id, version, yield_quantity, instructions_snapshot
          FROM mbox.recipes
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND product_id = $3::uuid AND status = 'active'
          ORDER BY version DESC
          LIMIT 1
        `,
          [scope.tenantId, scope.storeId, productId],
        );
        const current = recipe.rows[0];
        if (!current) return null;
        const components = await transaction.query<{
          inventory_item_id: string;
          sku: string;
          name: string;
          base_unit: string;
          quantity: string;
          expected_waste_quantity: string;
        }>(
          `
          SELECT item.id AS inventory_item_id, item.sku, item.name, item.base_unit,
            component.quantity::text, component.expected_waste_quantity::text
          FROM mbox.recipe_items AS component
          JOIN mbox.inventory_items AS item
            ON item.tenant_id = component.tenant_id
           AND item.store_id = component.store_id
           AND item.id = component.inventory_item_id
          WHERE component.tenant_id = $1::uuid AND component.store_id = $2::uuid
            AND component.recipe_id = $3::uuid
          ORDER BY item.category_code, item.name, item.id
        `,
          [scope.tenantId, scope.storeId, current.id],
        );
        return {
          id: current.id,
          productId: current.product_id,
          version: current.version,
          yieldQuantity: current.yield_quantity,
          instructionsSnapshot: current.instructions_snapshot,
          components: components.rows.map((component) => ({
            inventoryItemId: component.inventory_item_id,
            sku: component.sku,
            name: component.name,
            baseUnit: component.base_unit,
            quantity: component.quantity,
            expectedWasteQuantity: component.expected_waste_quantity,
          })),
        };
      },
      { readOnly: true },
    );
  }

  getRecipeCostPreview(
    scope: Readonly<StoreScope>,
    employeeId: string,
    productId: string,
  ): Promise<RecipeCostPreview> {
    return this.transactions.run(scope, async (transaction) => {
      await new StaffAccessRepository(transaction).assertPermission(employeeId, 'inventory.cost.view');
      return new InventoryRepository(transaction).previewRecipeCost(productId);
    }, { readOnly: true });
  }
}

export function assertInventoryPermission(
  permissions: readonly string[],
  permission: string,
): void {
  if (!permissions.includes(permission))
    throw new StaffAccessDeniedError(
      `Employee does not have permission ${permission}`,
    );
}
