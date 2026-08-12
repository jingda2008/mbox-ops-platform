import { describe, expect, it } from "vitest";
import type { ScopedTransaction } from "./index.js";
import {
  InsufficientInventoryError,
  InventoryBalanceMissingError,
  InventoryRecipeMissingError,
  InventoryRepository,
} from "./inventory-repository.js";
import type { OrderItem } from "./order-repository.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const storeId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const orderItemId = "44444444-4444-4444-8444-444444444444";
const productId = "55555555-5555-4555-8555-555555555555";
const inventoryItemId = "66666666-6666-4666-8666-666666666666";
const movementId = "77777777-7777-4777-8777-777777777777";

interface Call {
  sql: string;
  values: readonly unknown[];
}
type Response = { rows: Record<string, unknown>[]; rowCount?: number };

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId };
  readonly calls: Call[] = [];
  constructor(private readonly responses: Response[]) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) {
    this.calls.push({ sql: normalize(text), values: [...values] });
    const response = this.responses.shift();
    if (!response) throw new Error(`Unexpected query: ${normalize(text)}`);
    return {
      rows: response.rows as Row[],
      rowCount: response.rowCount ?? response.rows.length,
    };
  }
}

describe("InventoryRepository", () => {
  it("locks aggregate balances in deterministic item order before writing movement and balance", async () => {
    const tx = new ScriptedTransaction([
      { rows: [demandRow()] },
      { rows: [balanceRow(false)] },
      { rows: [{ id: movementId }] },
      { rows: [{ on_hand_quantity: "8.000000" }] },
    ]);
    const result = await new InventoryRepository(tx).consumeForOrderItems([
      orderItem(),
    ]);
    expect(result[0]).toMatchObject({
      movementId,
      quantity: "2.000000",
      remainingOnHandQuantity: "8.000000",
    });
    expect(tx.calls[1]?.sql).toContain(
      "ORDER BY balance.inventory_item_id FOR UPDATE OF balance",
    );
    expect(tx.calls[2]?.sql).toContain("INSERT INTO mbox.inventory_movements");
    expect(tx.calls[3]?.sql).toContain(
      "on_hand_quantity - reserved_quantity >= $4::numeric",
    );
  });

  it("fails before any inventory write when aggregate stock is insufficient", async () => {
    const tx = new ScriptedTransaction([
      { rows: [demandRow()] },
      { rows: [balanceRow(true)] },
    ]);
    await expect(
      new InventoryRepository(tx).consumeForOrderItems([orderItem()]),
    ).rejects.toBeInstanceOf(InsufficientInventoryError);
    expect(tx.calls).toHaveLength(2);
    expect(
      tx.calls.some((call) =>
        call.sql.includes("INSERT INTO mbox.inventory_movements"),
      ),
    ).toBe(false);
  });

  it("rejects a recipe ingredient without a balance row", async () => {
    const tx = new ScriptedTransaction([{ rows: [demandRow()] }, { rows: [] }]);
    await expect(
      new InventoryRepository(tx).consumeForOrderItems([orderItem()]),
    ).rejects.toBeInstanceOf(InventoryBalanceMissingError);
  });

  it("rejects bar or kitchen products without an active recipe", async () => {
    const tx = new ScriptedTransaction([{ rows: [] }]);
    await expect(
      new InventoryRepository(tx).consumeForOrderItems([orderItem()]),
    ).rejects.toBeInstanceOf(InventoryRecipeMissingError);
    expect(tx.calls).toHaveLength(1);
  });

  it("allows non-inventory service items without a recipe", async () => {
    const tx = new ScriptedTransaction([{ rows: [] }]);
    await expect(
      new InventoryRepository(tx).consumeForOrderItems([
        {
          ...orderItem(),
          fulfillmentStation: "none",
        },
      ]),
    ).resolves.toEqual([]);
  });
});

function demandRow(): Record<string, unknown> {
  return {
    order_item_id: orderItemId,
    inventory_item_id: inventoryItemId,
    sku: "GIN-ML",
    required_quantity: "2.000000",
  };
}

function balanceRow(insufficient: boolean): Record<string, unknown> {
  return {
    inventory_item_id: inventoryItemId,
    sku: "GIN-ML",
    on_hand_quantity: insufficient ? "1.000000" : "10.000000",
    reserved_quantity: "0.000000",
    required_quantity: "2.000000",
    insufficient,
  };
}

function orderItem(): OrderItem {
  return {
    id: orderItemId,
    orderId,
    productId,
    quantity: 2,
    unitPriceMinor: 8800,
    discountAmountMinor: 0,
    totalAmountMinor: 17600,
    currency: "CNY",
    fulfillmentStation: "bar",
    productSnapshot: {},
    costSnapshot: {},
    status: "submitted",
    note: null,
  };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
