import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runNormalizedMigrations } from "../migrate-normalized.js";
import { NormalizedCommandExecutor } from "./command-executor.js";
import { StaffAccessManagementService } from "./staff-access-management-service.js";
import { ScryptCredentialHasher } from "./staff-auth-command-service.js";
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from "./transaction-runner.js";

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("staff employee lifecycle", () => {
  const tenantId = randomUUID();
  const storeId = randomUUID();
  const adminId = randomUUID();
  const adminRoleId = randomUUID();
  const staffRoleId = randomUUID();
  let pool: Pool;
  let service: StaffAccessManagementService;

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    await pool.query(
      `INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Employee Lifecycle Tenant')`,
      [tenantId, `employee-${tenantId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Employee Lifecycle Store')`,
      [storeId, tenantId, `store-${storeId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'ADMIN','管理员')`,
      [adminId, tenantId, storeId],
    );
    await pool.query(
      `INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'OWNER','老板'),($4,$2,$3,'SERVICE','服务员')`,
      [adminRoleId, tenantId, storeId, staffRoleId],
    );
    await pool.query(
      `INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)`,
      [tenantId, storeId, adminId, adminRoleId],
    );
    await pool.query(
      `INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,status) VALUES($1,$2,'staff.access.configure','配置员工权限','staff','active') ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET status='active'`,
      [tenantId, storeId],
    );
    await pool.query(
      `INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='staff.access.configure'`,
      [tenantId, storeId, adminRoleId],
    );
    const transactions = new ScopedPostgresTransactionRunner(asPool(pool));
    service = new StaffAccessManagementService(
      transactions,
      new NormalizedCommandExecutor(transactions),
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates, verifies, idempotently replays, suspends and restores an employee account", async () => {
    const common = {
      scope: { tenantId, storeId },
      actorEmployeeId: adminId,
      businessDate: "2026-09-08",
      idempotencyKey: "employee-lifecycle-create-0001",
      requestFingerprint: JSON.stringify({
        employeeCode: "LIYAN",
        displayName: "李艳",
        roleId: staffRoleId,
        pinConfigured: true,
      }),
      employeeCode: "LIYAN",
      displayName: "李艳",
      pin: "4826",
      roleId: staffRoleId,
      reason: "员工入职",
    };
    const created = await service.createEmployee(common);
    expect(created).toMatchObject({ status: "active", replayed: false });
    expect((await service.createEmployee(common)).replayed).toBe(true);

    const persisted = await pool.query<{
      pin_hash: string;
      role_code: string;
      status: string;
    }>(
      `
      SELECT employee.pin_hash,role.code AS role_code,employee.status
      FROM mbox.employees employee
      JOIN mbox.employee_roles assignment ON assignment.tenant_id=employee.tenant_id AND assignment.store_id=employee.store_id AND assignment.employee_id=employee.id AND assignment.ends_at IS NULL
      JOIN mbox.roles role ON role.tenant_id=assignment.tenant_id AND role.store_id=assignment.store_id AND role.id=assignment.role_id
      WHERE employee.id=$1
    `,
      [created.employeeId],
    );
    expect(persisted.rows[0]).toMatchObject({
      role_code: "SERVICE",
      status: "active",
    });
    expect(
      await new ScryptCredentialHasher().verify(
        "4826",
        persisted.rows[0]!.pin_hash,
      ),
    ).toBe(true);
    expect(persisted.rows[0]!.pin_hash).not.toContain("4826");

    const suspended = await service.setEmployeeStatus({
      scope: { tenantId, storeId },
      actorEmployeeId: adminId,
      employeeId: created.employeeId,
      businessDate: "2026-09-08",
      idempotencyKey: "employee-lifecycle-suspend-0001",
      requestFingerprint: JSON.stringify({
        employeeId: created.employeeId,
        status: "suspended",
      }),
      status: "suspended",
      reason: "暂时停用",
    });
    expect(suspended.status).toBe("suspended");
    const restored = await service.setEmployeeStatus({
      scope: { tenantId, storeId },
      actorEmployeeId: adminId,
      employeeId: created.employeeId,
      businessDate: "2026-09-08",
      idempotencyKey: "employee-lifecycle-restore-0001",
      requestFingerprint: JSON.stringify({
        employeeId: created.employeeId,
        status: "active",
      }),
      status: "active",
      reason: "恢复上岗",
    });
    expect(restored.status).toBe("active");
    await expect(
      service.setEmployeeStatus({
        scope: { tenantId, storeId },
        actorEmployeeId: adminId,
        employeeId: adminId,
        businessDate: "2026-09-08",
        idempotencyKey: "employee-lifecycle-self-0001",
        requestFingerprint: "{}",
        status: "suspended",
        reason: "不允许",
      }),
    ).rejects.toThrow("不能停用当前登录账号");
  });
});

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() };
}
