import { describe, expect, it } from "vitest";
import {
  assertInventoryDashboardAccess,
  assertInventoryPermission,
} from "./inventory-query-service.js";
import { StaffAccessDeniedError } from "./staff-access-repository.js";

describe("InventoryQueryService authorization boundary", () => {
  it("accepts only an explicitly resolved inventory permission", () => {
    expect(() =>
      assertInventoryPermission(["inventory.view"], "inventory.view"),
    ).not.toThrow();
    expect(() =>
      assertInventoryPermission(["inventory.cost.view"], "inventory.view"),
    ).toThrow(StaffAccessDeniedError);
  });

  it("lets an operational inventory grant read the item list required by its page", () => {
    expect(() => assertInventoryDashboardAccess(["inventory.receive"])).not.toThrow();
    expect(() => assertInventoryDashboardAccess(["inventory.barcode.bind"])).not.toThrow();
    expect(() => assertInventoryDashboardAccess(["dashboard.view"])).toThrow(
      StaffAccessDeniedError,
    );
  });
});
