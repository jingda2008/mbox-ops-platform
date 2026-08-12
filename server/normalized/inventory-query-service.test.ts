import { describe, expect, it } from "vitest";
import { assertInventoryPermission } from "./inventory-query-service.js";
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
});
