import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { runNormalizedMigrations } from "../migrate-normalized.js";
import { NormalizedCommandExecutor } from "./command-executor.js";
import { ownerFinanceApiPlugin } from "./owner-finance-api.js";
import { commercialOpsApiPlugin } from "./commercial-ops-api.js";
import { ProfitQueryService } from "./profit-query-service.js";
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from "./transaction-runner.js";

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("owner finance normalized accounting workflow", () => {
  const tenantId = randomUUID(),
    storeId = randomUUID(),
    ownerId = randomUUID(),
    employeeId = randomUUID(),
    roleId = randomUUID();
  let pool: Pool, app: FastifyInstance;
  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    await pool.query(
      `INSERT INTO mbox.tenants(id,code,name)VALUES($1,$2,'Owner Finance Tenant')`,
      [tenantId, `owner-${tenantId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO mbox.stores(id,tenant_id,code,name)VALUES($1,$2,$3,'Owner Finance Store')`,
      [storeId, tenantId, `store-${storeId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)VALUES($1,$2,$3,'OWNER','老板'),($4,$2,$3,'STAFF','员工')`,
      [ownerId, tenantId, storeId, employeeId],
    );
    await pool.query(
      `INSERT INTO mbox.roles(id,tenant_id,store_id,code,name)VALUES($1,$2,$3,'OWNER','老板')`,
      [roleId, tenantId, storeId],
    );
    await pool.query(
      `INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id)VALUES($1,$2,$3,$4)`,
      [tenantId, storeId, ownerId, roleId],
    );
    await pool.query(
      `INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])`,
      [
        tenantId,
        storeId,
        roleId,
        [
          "commercial.cost.view",
          "commercial.cost.manage",
          "commercial.payroll.view",
          "commercial.payroll.manage",
          "commercial.payroll.post",
        ],
      ],
    );
    const transactions = new ScopedPostgresTransactionRunner(asPool(pool));
    app = Fastify();
    app.register(ownerFinanceApiPlugin, {
      prefix: "/api",
      transactions,
      commandExecutor: new NormalizedCommandExecutor(transactions),
      resolveContext: () => ({
        scope: { tenantId, storeId },
        employeeId: ownerId,
        businessDate: "2026-09-08",
        capabilities: [],
      }),
    });
    app.register(commercialOpsApiPlugin, {
      prefix: "/api", transactions,
      commandExecutor: new NormalizedCommandExecutor(transactions),
      queryService: new ProfitQueryService(transactions),
      resolveContext: () => ({ scope: { tenantId, storeId }, employeeId: ownerId, businessDate: "2026-09-08", capabilities: [] }),
    });
    await app.ready();
  });

  it("replays a cost after a lost response without generating another public ID or accounting entry", async () => {
    const payload = { name: "Retry expense", category: "rent", recognitionState: "actual", allocationPeriod: "month", serviceStartDate: "2026-12-01", serviceEndDate: "2026-12-31", netAmountMinor: 10000, taxAmountMinor: 0, currency: "CNY", sourceType: "lease" };
    const request = { method: "POST" as const, url: "/api/commercial-ops/costs", headers: { "idempotency-key": "audit-cost-lost-response-100" }, payload };
    const first = await app.inject(request);
    expect(first.statusCode, first.body).toBe(201);
    const second = await app.inject(request);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().data.id).toBe(first.json().data.id);
    expect(second.json().data.publicId).toBe(first.json().data.publicId);
    const rows = await pool.query("SELECT count(*)::int AS count, sum(gross_amount_minor)::int AS amount FROM mbox.operating_cost_entries WHERE tenant_id=$1 AND store_id=$2 AND id=$3", [tenantId, storeId, first.json().data.id]);
    expect(rows.rows[0]).toEqual({ count: 1, amount: 10000 });
    const changed = await app.inject({ ...request, payload: { ...payload, netAmountMinor: 11000 } });
    expect(changed.statusCode).toBe(409);
    const deliberate = await app.inject({ ...request, headers: { "idempotency-key": "audit-cost-deliberate-repeat-100" } });
    expect(deliberate.statusCode, deliberate.body).toBe(201);
    expect(deliberate.json().data.id).not.toBe(first.json().data.id);
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("seeds new-store classifications and materializes each recurring date once", async () => {
    const overview = await getOverview(app);
    expect(overview.businessDate).toBe("2026-09-08");
    expect(
      overview.categories.map((item: { code: string }) => item.code),
    ).toContain("rent");
    expect(
      overview.costCenters.map((item: { code: string }) => item.code),
    ).toContain("kitchen");
    const rent = overview.categories.find(
        (item: { code: string }) => item.code === "rent",
      ),
      venue = overview.costCenters.find(
        (item: { code: string }) => item.code === "venue",
      );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/commercial-ops/recurring-costs",
          headers: { "idempotency-key": "owner-recurring-test-0001" },
          payload: {
            name: "每日测试租金",
            categoryDefinitionId: rent.id,
            costCenterId: venue.id,
            recurrence: "day",
            allocationPeriod: "day",
            recognitionState: "accrual",
            startsOn: "2026-09-06",
            netAmountMinor: 100,
            taxAmountMinor: 0,
            sourceType: "lease",
          },
        })
      ).statusCode,
    ).toBe(201);
    const first = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/recurring-costs/materialize",
      headers: { "idempotency-key": "owner-materialize-test-0001" },
      payload: { throughDate: "2026-09-08" },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ data: { createdCount: 3 } });
    const second = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/recurring-costs/materialize",
      headers: { "idempotency-key": "owner-materialize-test-0002" },
      payload: { throughDate: "2026-09-08" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ data: { createdCount: 0 } });
    const ruleId = (await getOverview(app)).recurringRules[0].id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/commercial-ops/recurring-costs/${ruleId}/status`,
          headers: { "idempotency-key": "owner-recurring-pause-0001" },
          payload: { status: "paused", reason: "测试暂停规则" },
        })
      ).statusCode,
    ).toBe(201);
    const paused = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/recurring-costs/materialize",
      headers: { "idempotency-key": "owner-materialize-test-0003" },
      payload: { throughDate: "2026-09-09" },
    });
    expect(paused.json()).toMatchObject({ data: { createdCount: 0 } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/commercial-ops/recurring-costs/${ruleId}/status`,
          headers: { "idempotency-key": "owner-recurring-resume-0001" },
          payload: { status: "active", reason: "测试恢复规则" },
        })
      ).statusCode,
    ).toBe(201);
    const resumed = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/recurring-costs/materialize",
      headers: { "idempotency-key": "owner-materialize-test-0004" },
      payload: { throughDate: "2026-09-09" },
    });
    expect(resumed.json()).toMatchObject({ data: { createdCount: 1 } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/commercial-ops/recurring-costs/${ruleId}/status`,
          headers: { "idempotency-key": "owner-recurring-end-0001" },
          payload: { status: "ended", reason: "测试结束规则" },
        })
      ).statusCode,
    ).toBe(201);
    const reviveEnded = await app.inject({
      method: "POST",
      url: `/api/commercial-ops/recurring-costs/${ruleId}/status`,
      headers: { "idempotency-key": "owner-recurring-revive-0001" },
      payload: { status: "active", reason: "不允许恢复已结束规则" },
    });
    expect(reviveEnded.statusCode).toBe(400);
    expect(reviveEnded.json().error.message).toContain("不能恢复");
  });

  it("keeps payroll draft, approval, accounting post and money transfer separate", async () => {
    const overview = await getOverview(app),
      administration = overview.costCenters.find(
        (item: { code: string }) => item.code === "administration",
      );
    const comp = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/compensation-rules",
      headers: { "idempotency-key": "owner-compensation-test-0001" },
      payload: {
        employeeId,
        costCenterId: administration.id,
        payBasis: "monthly",
        baseRateMinor: 100000,
        effectiveFrom: "2026-09-01",
        reason: "测试薪资版本",
      },
    });
    expect(comp.statusCode).toBe(201);
    const compensationRuleId = comp.json().data.id;
    const nextComp = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/compensation-rules",
      headers: { "idempotency-key": "owner-compensation-test-0002" },
      payload: {
        employeeId,
        costCenterId: administration.id,
        payBasis: "monthly",
        baseRateMinor: 120000,
        effectiveFrom: "2026-10-01",
        reason: "十月起调整薪资",
      },
    });
    expect(nextComp.statusCode, nextComp.body).toBe(201);
    const nextCompensationRuleId = nextComp.json().data.id;
    const versionRows = await pool.query<{
      id: string;
      effective_until: string | null;
      status: string;
    }>(
      `SELECT id,effective_until::text,status FROM mbox.employee_compensation_rules WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 ORDER BY effective_from`,
      [tenantId, storeId, employeeId],
    );
    expect(versionRows.rows).toEqual([
      {
        id: compensationRuleId,
        effective_until: "2026-09-30",
        status: "superseded",
      },
      {
        id: nextCompensationRuleId,
        effective_until: null,
        status: "active",
      },
    ]);
    const backdated = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/compensation-rules",
      headers: { "idempotency-key": "owner-compensation-backdate-0001" },
      payload: {
        employeeId,
        costCenterId: administration.id,
        payBasis: "monthly",
        baseRateMinor: 110000,
        effectiveFrom: "2026-09-15",
        reason: "错误的倒签测试",
      },
    });
    expect(backdated.statusCode).toBe(400);
    expect(backdated.json().error.message).toContain("必须晚于当前标准");
    const tampered = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/payroll-runs",
      headers: { "idempotency-key": "owner-payroll-tamper-test-0001" },
      payload: {
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        lines: [
          { employeeId, compensationRuleId, units: 1, basePayMinor: 999999 },
        ],
      },
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error.message).toContain("服务端薪资规则");
    const crossesRuleBoundary = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/payroll-runs",
      headers: { "idempotency-key": "owner-payroll-rule-boundary-0001" },
      payload: {
        periodStart: "2026-09-01",
        periodEnd: "2026-10-31",
        lines: [
          {
            employeeId,
            compensationRuleId,
            units: 1,
            basePayMinor: 100000,
          },
        ],
      },
    });
    expect(crossesRuleBoundary.statusCode).toBe(400);
    expect(crossesRuleBoundary.json().error.message).toContain("工资周期不匹配");
    const draft = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/payroll-runs",
      headers: { "idempotency-key": "owner-payroll-draft-test-0001" },
      payload: {
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        lines: [
          {
            employeeId,
            compensationRuleId,
            units: 1,
            basePayMinor: 100000,
            bonusMinor: 20000,
            deductionMinor: 10000,
            employerContributionMinor: 5000,
          },
        ],
      },
    });
    expect(draft.statusCode).toBe(201);
    const runId = draft.json().data.id;
    const overlap = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/payroll-runs",
      headers: { "idempotency-key": "owner-payroll-overlap-test-0001" },
      payload: {
        periodStart: "2026-09-15",
        periodEnd: "2026-10-15",
        lines: [
          {
            employeeId,
            compensationRuleId,
            units: 1,
            basePayMinor: 100000,
          },
        ],
      },
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json().error.message).toContain("重叠");
    const approval = await app.inject({
      method: "POST",
      url: `/api/commercial-ops/payroll-runs/${runId}/approve`,
      headers: { "idempotency-key": "owner-payroll-approve-test-0001" },
      payload: { reason: "已核对工资明细" },
    });
    expect(approval.statusCode, approval.body).toBe(201);
    const postRequest = {
      method: "POST" as const,
      url: `/api/commercial-ops/payroll-runs/${runId}/post`,
      headers: { "idempotency-key": "owner-payroll-post-test-0001" },
      payload: { reason: "确认计入经营成本" },
    };
    expect((await app.inject(postRequest)).statusCode).toBe(201);
    expect((await app.inject(postRequest)).statusCode).toBe(200);
    const postedVoid = await app.inject({
      method: "POST",
      url: `/api/commercial-ops/payroll-runs/${runId}/void`,
      headers: { "idempotency-key": "owner-payroll-posted-void-0001" },
      payload: { reason: "已入账工资不能直接作废" },
    });
    expect(postedVoid.statusCode).toBe(400);

    const octoberDraft = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/payroll-runs",
      headers: { "idempotency-key": "owner-payroll-october-draft-0001" },
      payload: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        lines: [
          {
            employeeId,
            compensationRuleId: nextCompensationRuleId,
            units: 1,
            basePayMinor: 120000,
          },
        ],
      },
    });
    expect(octoberDraft.statusCode, octoberDraft.body).toBe(201);
    const octoberRunId = octoberDraft.json().data.id;
    const voided = await app.inject({
      method: "POST",
      url: `/api/commercial-ops/payroll-runs/${octoberRunId}/void`,
      headers: { "idempotency-key": "owner-payroll-october-void-0001" },
      payload: { reason: "测试保留痕迹后重开" },
    });
    expect(voided.statusCode, voided.body).toBe(201);
    expect(voided.json()).toMatchObject({
      data: { status: "voided", aggregateVersion: 2 },
    });
    const replacement = await app.inject({
      method: "POST",
      url: "/api/commercial-ops/payroll-runs",
      headers: { "idempotency-key": "owner-payroll-october-replace-0001" },
      payload: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        lines: [
          {
            employeeId,
            compensationRuleId: nextCompensationRuleId,
            units: 1,
            basePayMinor: 120000,
          },
        ],
      },
    });
    expect(replacement.statusCode, replacement.body).toBe(201);
    const facts = await pool.query<{
      run_status: string;
      line_count: string;
      gross: string;
      net: string;
      employer: string;
      cost_count: string;
      cost_amount: string;
      payment_count: string;
    }>(
      `SELECT (SELECT status FROM mbox.payroll_runs WHERE id=$1) AS run_status,(SELECT count(*)::text FROM mbox.payroll_lines WHERE payroll_run_id=$1) AS line_count,(SELECT gross_pay_minor::text FROM mbox.payroll_lines WHERE payroll_run_id=$1) AS gross,(SELECT net_pay_minor::text FROM mbox.payroll_lines WHERE payroll_run_id=$1) AS net,(SELECT employer_cost_minor::text FROM mbox.payroll_lines WHERE payroll_run_id=$1) AS employer,(SELECT count(*)::text FROM mbox.operating_cost_entries WHERE payroll_run_id=$1) AS cost_count,(SELECT sum(gross_amount_minor)::text FROM mbox.operating_cost_entries WHERE payroll_run_id=$1) AS cost_amount,(SELECT count(*)::text FROM mbox.payments WHERE tenant_id=$2 AND store_id=$3) AS payment_count`,
      [runId, tenantId, storeId],
    );
    expect(facts.rows[0]).toEqual({
      run_status: "posted",
      line_count: "1",
      gross: "120000",
      net: "110000",
      employer: "125000",
      cost_count: "1",
      cost_amount: "125000",
      payment_count: "0",
    });
  });

  it("adds three employees to one draft, edits and removes with version checks, and posts only once", async () => {
    const overview = await getOverview(app);
    const center = overview.costCenters[0].id;
    const employeeIds = [randomUUID(), randomUUID(), randomUUID()];
    const rules: string[] = [];
    for (const [index, id] of employeeIds.entries()) {
      await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$5)`, [id, tenantId, storeId, `MULTI-${index}`, `多人核算${index}`]);
      const response = await app.inject({ method: "POST", url: "/api/commercial-ops/compensation-rules", headers: { "idempotency-key": `multi-rule-${id}` }, payload: {
        employeeId: id, costCenterId: center, payBasis: "monthly", baseRateMinor: 100000, effectiveFrom: "2026-11-01", reason: "多人核算测试标准",
      } });
      expect(response.statusCode, response.body).toBe(201);
      rules.push(response.json().data.id);
    }
    const line = (index: number, bonusMinor = 0) => ({ employeeId: employeeIds[index], compensationRuleId: rules[index], units: 1, basePayMinor: 100000, bonusMinor });
    const period = { periodStart: "2026-11-01", periodEnd: "2026-11-30" };
    const create = await app.inject({ method: "POST", url: "/api/commercial-ops/payroll-runs", headers: { "idempotency-key": "multi-payroll-first" }, payload: { ...period, lines: [line(0)] } });
    expect(create.statusCode, create.body).toBe(201);
    const draftRunId = create.json().data.id;
    const second = { ...period, draftRunId, expectedVersion: 1, lines: [line(1)] };
    const append = await app.inject({ method: "POST", url: "/api/commercial-ops/payroll-runs", headers: { "idempotency-key": "multi-payroll-second" }, payload: second });
    expect(append.statusCode, append.body).toBe(201);
    const replay = await app.inject({ method: "POST", url: "/api/commercial-ops/payroll-runs", headers: { "idempotency-key": "multi-payroll-second" }, payload: second });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    const stale = await app.inject({ method: "POST", url: "/api/commercial-ops/payroll-runs", headers: { "idempotency-key": "multi-payroll-stale" }, payload: { ...second, lines: [line(2)] } });
    expect(stale.statusCode).toBe(400);
    const third = await app.inject({ method: "POST", url: "/api/commercial-ops/payroll-runs", headers: { "idempotency-key": "multi-payroll-third" }, payload: { ...second, expectedVersion: 2, lines: [line(2)] } });
    expect(third.statusCode, third.body).toBe(201);
    const duplicate = await app.inject({ method: "POST", url: "/api/commercial-ops/payroll-runs", headers: { "idempotency-key": "multi-payroll-duplicate" }, payload: { ...second, expectedVersion: 3 } });
    expect(duplicate.statusCode).toBe(400);
    const edit = await app.inject({ method: "POST", url: "/api/commercial-ops/payroll-runs", headers: { "idempotency-key": "multi-payroll-edit" }, payload: { ...second, expectedVersion: 3, replaceEmployeeLine: true, lines: [line(1, 5000)] } });
    expect(edit.statusCode, edit.body).toBe(201);
    let current = await getOverview(app);
    expect(current.payrollRuns.find((run: { id: string }) => run.id === draftRunId).lineCount).toBe(3);
    expect(current.payrollLines.filter((item: { payrollRunId: string }) => item.payrollRunId === draftRunId)).toHaveLength(3);
    const remove = await app.inject({ method: "POST", url: "/api/commercial-ops/payroll-runs", headers: { "idempotency-key": "multi-payroll-remove" }, payload: { ...period, draftRunId, expectedVersion: 4, removeEmployeeId: employeeIds[2], lines: [] } });
    expect(remove.statusCode, remove.body).toBe(201);
    for (const action of ["approve", "post"]) {
      const response = await app.inject({ method: "POST", url: `/api/commercial-ops/payroll-runs/${draftRunId}/${action}`, headers: { "idempotency-key": `multi-payroll-${action}` }, payload: { reason: "核对多人明细后操作" } });
      expect(response.statusCode, response.body).toBe(201);
    }
    current = await getOverview(app);
    expect(current.payrollRuns.find((run: { id: string }) => run.id === draftRunId)).toMatchObject({ status: "posted", lineCount: 2, employerCostMinor: 205000 });
    const facts = await pool.query(`SELECT count(*)::int AS count,sum(gross_amount_minor)::text AS total FROM mbox.operating_cost_entries WHERE payroll_run_id=$1`, [draftRunId]);
    expect(facts.rows[0]).toEqual({ count: 2, total: "205000" });
    const postedEdit = await app.inject({ method: "POST", url: "/api/commercial-ops/payroll-runs", headers: { "idempotency-key": "multi-payroll-posted-edit" }, payload: { ...second, expectedVersion: 7, replaceEmployeeLine: true } });
    expect(postedEdit.statusCode).toBe(400);
  });
});

async function getOverview(app: FastifyInstance) {
  const response = await app.inject({
    method: "GET",
    url: "/api/commercial-ops/owner-finance?startDate=2026-09-01&endDate=2026-09-30",
  });
  expect(response.statusCode).toBe(200);
  return response.json().data;
}
function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() };
}
