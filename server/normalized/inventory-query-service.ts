import type {WasteRequest} from '../../src/shared/inventory-waste.js';
import type { JsonObject } from "./command-executor.js";
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
} from "./staff-access-repository.js";
import type { StoreScope } from "./transaction-runner.js";
import { ScopedPostgresTransactionRunner } from "./transaction-runner.js";
import { InventoryRepository, type RecipeCostPreview } from './inventory-repository.js';
import type { StockCountReview, StockCountReviewPage } from '../../src/shared/inventory-stock-count.js';

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
  packageVolumeMl: string | null;
  costStatus: "complete" | "pending" | "needs_review";
  costBasis?: "moving_weighted_average" | "manual_correction" | "none";
  weightedUnitCostMinor?: string | null;
  latestPurchaseUnitCostMinor?: string | null;
  latestReceivedAt: string | null;
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
    packageCount?: string;
    packageVolumeMl?: string | null;
    unitCostMinor?: string;
    perPackageCostMinor?: string;
    totalCostMinor?: string;
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
  package_volume_ml: string | null;
  cost_status: "complete" | "pending" | "needs_review";
  cost_basis: "moving_weighted_average" | "manual_correction" | "none";
  weighted_unit_cost_minor: string | null;
  latest_purchase_unit_cost_minor: string | null;
  latest_received_at: string | null;
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
    packageCount?: string;
    packageVolumeMl?: string | null;
    unitCostMinor?: string;
    perPackageCostMinor?: string;
    totalCostMinor?: string;
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

  getWasteRequests(scope:Readonly<StoreScope>,employeeId:string,page:number){
    return this.transactions.run(scope,async transaction=>{
      const access=await new StaffAccessRepository(transaction).resolve(employeeId);
      const reviewer=access.permissions.includes('inventory.count.approve');
      if(!reviewer)assertInventoryPermission(access.permissions,'inventory.waste');
      const result=await transaction.query<{record:WasteRequest}>(`SELECT jsonb_build_object(
        'id',r.id,'itemName',i.name,'quantity',r.quantity::text,'baseUnit',i.base_unit,'wasteType',r.waste_type,'reason',r.reason,
        'requestedByEmployeeId',r.requested_by_employee_id,'requestedByName',creator.display_name,'createdAt',r.created_at::text,
        'status',r.status,'decidedByName',decider.display_name,'decisionReason',r.decision_reason,
        'canReview',$3::boolean AND r.status='pending' AND r.requested_by_employee_id<>$4::uuid) AS record
        FROM mbox.inventory_waste_requests r
        JOIN mbox.inventory_items i ON (i.tenant_id,i.store_id,i.id)=(r.tenant_id,r.store_id,r.inventory_item_id)
        JOIN mbox.employees creator ON (creator.tenant_id,creator.store_id,creator.id)=(r.tenant_id,r.store_id,r.requested_by_employee_id)
        LEFT JOIN mbox.employees decider ON (decider.tenant_id,decider.store_id,decider.id)=(r.tenant_id,r.store_id,r.decided_by_employee_id)
        WHERE r.tenant_id=$1::uuid AND r.store_id=$2::uuid AND ($3::boolean OR r.requested_by_employee_id=$4::uuid)
        ORDER BY (r.status='pending') DESC,r.created_at DESC,r.id DESC LIMIT 31 OFFSET $5`,
        [scope.tenantId,scope.storeId,reviewer,employeeId,(page-1)*30]);
      return {items:result.rows.slice(0,30).map(row=>row.record),hasMore:result.rows.length>30};
    },{readOnly:true});
  }

  getStockCounts(scope: Readonly<StoreScope>, employeeId: string,
    input: { status: 'submitted' | 'processed'; page: number; pageSize: number }): Promise<StockCountReviewPage> {
    return this.transactions.run(scope, async transaction => {
      const access = await new StaffAccessRepository(transaction).resolve(employeeId);
      const canApprove = access.permissions.includes('inventory.count.approve');
      if (!canApprove) assertInventoryPermission(access.permissions, 'inventory.count');
      const result = await transaction.query<{ record: StockCountReview }>(`
        SELECT jsonb_build_object(
          'id', counts.id, 'publicId', counts.public_id, 'status', counts.status,
          'createdByEmployeeId', counts.created_by_employee_id, 'createdByName', creator.display_name,
          'submittedAt', counts.submitted_at::text, 'decidedAt', counts.decided_at::text,
          'decidedByName', decider.display_name, 'decisionReason', counts.decision_reason, 'note', counts.note,
          'canReview', $3::boolean AND counts.created_by_employee_id <> $4::uuid AND counts.status='submitted',
          'lines', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'inventoryItemId', item.id, 'itemName', item.name, 'baseUnit', item.base_unit,
              'categoryCode', item.category_code, 'packageVolumeMl', item.package_volume_ml::text,
              'systemQuantity', line.system_quantity_snapshot::text,
              'countedQuantity', line.counted_quantity::text, 'varianceQuantity', line.variance_quantity::text,
              'currentQuantity', COALESCE(balance.on_hand_quantity,0)::text, 'reason', line.reason,
              'stale', counts.status='submitted' AND (
                line.system_quantity_snapshot <> COALESCE(balance.on_hand_quantity,0) OR EXISTS (
                  SELECT 1 FROM mbox.inventory_movements movement
                  WHERE movement.tenant_id=line.tenant_id AND movement.store_id=line.store_id
                    AND movement.inventory_item_id=line.inventory_item_id AND movement.occurred_at>=line.created_at
                ))
            ) ORDER BY item.name, item.id)
            FROM mbox.inventory_stock_count_lines line
            JOIN mbox.inventory_items item ON item.tenant_id=line.tenant_id AND item.store_id=line.store_id
              AND item.id=line.inventory_item_id
            LEFT JOIN mbox.inventory_balances balance ON balance.tenant_id=line.tenant_id AND balance.store_id=line.store_id
              AND balance.inventory_item_id=line.inventory_item_id
            WHERE line.tenant_id=counts.tenant_id AND line.store_id=counts.store_id AND line.stock_count_id=counts.id
          ), '[]'::jsonb)
        ) AS record
        FROM mbox.inventory_stock_counts counts
        JOIN mbox.employees creator ON creator.tenant_id=counts.tenant_id AND creator.store_id=counts.store_id
          AND creator.id=counts.created_by_employee_id
        LEFT JOIN mbox.employees decider ON decider.tenant_id=counts.tenant_id AND decider.store_id=counts.store_id
          AND decider.id=counts.decided_by_employee_id
        WHERE counts.tenant_id=$1::uuid AND counts.store_id=$2::uuid
          AND ($3::boolean OR counts.created_by_employee_id=$4::uuid)
          AND (($5='submitted' AND counts.status='submitted') OR ($5='processed' AND counts.status IN ('approved','rejected')))
        ORDER BY counts.submitted_at DESC, counts.id DESC LIMIT $6 OFFSET $7
      `, [scope.tenantId, scope.storeId, canApprove, employeeId, input.status, input.pageSize+1, input.page*input.pageSize]);
      return { counts: result.rows.slice(0,input.pageSize).map(row=>row.record), canApprove,
        page: input.page, hasMore: result.rows.length>input.pageSize };
    }, { readOnly: true });
  }

  getDashboard(
    scope: Readonly<StoreScope>,
    employeeId: string,
  ): Promise<InventoryDashboard> {
    return this.transactions.run(
      scope,
      async (transaction) => {
        const access = await new StaffAccessRepository(transaction).resolve(employeeId);
        assertInventoryDashboardAccess(access.permissions);
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
          item.package_volume_ml::text, balance.cost_status, balance.cost_basis,
          CASE WHEN $3::boolean THEN balance.weighted_unit_cost_minor::text ELSE NULL END
            AS weighted_unit_cost_minor,
          CASE WHEN $3::boolean THEN balance.latest_purchase_unit_cost_minor::text ELSE NULL END
            AS latest_purchase_unit_cost_minor,
          latest_receipt.received_at::text AS latest_received_at
        FROM mbox.inventory_items AS item
        JOIN mbox.inventory_balances AS balance
          ON balance.tenant_id = item.tenant_id AND balance.store_id = item.store_id
         AND balance.inventory_item_id = item.id
        LEFT JOIN LATERAL (
          SELECT receipt.received_at
          FROM mbox.purchase_receipt_lines AS line
          JOIN mbox.purchase_receipts AS receipt
            ON receipt.tenant_id=line.tenant_id AND receipt.store_id=line.store_id
           AND receipt.id=line.receipt_id
          WHERE line.tenant_id=item.tenant_id AND line.store_id=item.store_id
            AND line.inventory_item_id=item.id AND receipt.status='received'
          ORDER BY receipt.received_at DESC NULLS LAST,receipt.id DESC
          LIMIT 1
        ) AS latest_receipt ON true
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
          COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'inventoryItemId', item.id,
            'itemName', item.name,
            'batchCode', line.batch_code,
            'quantity', line.quantity::text,
            'baseUnit', item.base_unit,
            'packageCount', NULLIF(line.metadata->>'packageCount',''),
            'packageVolumeMl', item.package_volume_ml::text,
            'unitCostMinor', CASE WHEN $3::boolean THEN line.unit_cost_minor::text ELSE NULL END,
            'perPackageCostMinor', CASE
              WHEN $3::boolean
                AND (line.metadata->>'packageCount') ~ '^(0|[1-9][0-9]*)([.][0-9]{1,6})?$'
                AND (line.metadata->>'packageCount')::numeric > 0
              THEN (line.total_cost_minor::numeric / (line.metadata->>'packageCount')::numeric)::numeric(18,6)::text
              ELSE NULL
            END,
            'totalCostMinor', CASE WHEN $3::boolean THEN line.total_cost_minor::text ELSE NULL END
          )) ORDER BY line.id) FILTER (WHERE line.id IS NOT NULL), '[]'::jsonb) AS lines,
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
          packageVolumeMl: row.package_volume_ml,
          costStatus: row.cost_status,
          latestReceivedAt: row.latest_received_at,
          ...(canViewCosts
            ? {
                weightedUnitCostMinor: row.weighted_unit_cost_minor,
                latestPurchaseUnitCostMinor: row.latest_purchase_unit_cost_minor,
                costBasis: row.cost_basis,
              }
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

export function assertInventoryDashboardAccess(permissions: readonly string[]): void {
  const dashboardPermissions = [
    'inventory.view', 'inventory.manage', 'inventory.cost.view', 'inventory.receive',
    'inventory.count', 'inventory.count.approve', 'inventory.waste', 'inventory.barcode.bind', 'inventory.cost.correct',
  ]
  if (!dashboardPermissions.some((permission) => permissions.includes(permission))) {
    throw new StaffAccessDeniedError('Employee does not have inventory dashboard access')
  }
}
