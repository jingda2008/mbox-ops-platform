import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  type JsonCodec,
  type JsonObject,
  type JsonValue,
  type NormalizedCommandExecutor,
} from "./command-executor.js";
import {
  CommercialOpsRepository,
  type CostAllocationPeriod,
  type CostCategory,
  type CostRecognitionState,
  type CostSourceType,
} from "./commercial-ops-repository.js";
import type { NormalizedOperationsRequestContext } from "./normalized-operations-api.js";
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
  StaffNotFoundError,
} from "./staff-access-repository.js";
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
} from "./transaction-runner.js";

type TransactionRunnerPort = Pick<ScopedPostgresTransactionRunner, "run">;
type CommandExecutorPort = Pick<NormalizedCommandExecutor, "execute">;

export interface OwnerFinanceApiOptions {
  transactions: TransactionRunnerPort;
  commandExecutor: CommandExecutorPort;
  resolveContext(
    request: FastifyRequest,
  ):
    | Promise<NormalizedOperationsRequestContext>
    | NormalizedOperationsRequestContext;
  createStaffAccessRepository?(
    transaction: ScopedTransaction,
  ): StaffAccessRepository;
}

interface FinanceResult extends JsonObject {
  id: string;
  publicId: string;
  status: string;
  aggregateVersion: number;
}

export const ownerFinanceApiPlugin: FastifyPluginAsync<
  OwnerFinanceApiOptions
> = async (app, options) => {
  const access = (transaction: ScopedTransaction) =>
    options.createStaffAccessRepository?.(transaction) ??
    new StaffAccessRepository(transaction);

  app.get("/commercial-ops/owner-finance", async (request, reply) =>
    handle(reply, async () => {
      const context = await options.resolveContext(request);
      const query = object(request.query ?? {});
      const startDate = date(
        query.startDate ?? monthStart(context.businessDate),
        "startDate",
      );
      const endDate = date(
        query.endDate ?? monthEnd(context.businessDate),
        "endDate",
      );
      if (endDate < startDate)
        throw new OwnerFinanceRequestError("日期范围不正确");
      const data = await options.transactions.run(
        context.scope,
        async (transaction) => {
          const effective = await access(transaction).resolve(context.employeeId);
          if (!effective.permissions.some((permission) => ["commercial.cost.view", "commercial.cost.manage", "commercial.payroll.view", "commercial.payroll.manage", "commercial.payroll.post"].includes(permission)))
            throw new StaffAccessDeniedError("没有费用或工资访问权限");
          const canViewCost = effective.permissions.includes("commercial.cost.view");
          const canViewPayroll = effective.permissions.includes(
            "commercial.payroll.view",
          );
          // A scoped transaction owns one PostgreSQL client. Keep reads sequential;
          // concurrent client.query calls are deprecated and can misroute results.
          const categories = await transaction.query(
            `SELECT id,code,name,system_category AS "systemCategory",is_system AS "isSystem",status,sort_order AS "sortOrder" FROM mbox.operating_cost_category_definitions WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active' ORDER BY sort_order,name,id`,
            ids(context),
          );
          const centers = await transaction.query(
            `SELECT id,code,name,is_system AS "isSystem",status,sort_order AS "sortOrder" FROM mbox.cost_centers WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active' ORDER BY sort_order,name,id`,
            ids(context),
          );
          const recurring = await transaction.query(
            `SELECT rule.id,rule.public_id AS "publicId",rule.name,definition.name AS "categoryName",definition.system_category AS "systemCategory",rule.category_definition_id AS "categoryDefinitionId",rule.cost_center_id AS "costCenterId",center.name AS "costCenterName",rule.recurrence,rule.starts_on::text AS "startsOn",rule.ends_on::text AS "endsOn",rule.allocation_period AS "allocationPeriod",rule.recognition_state AS "recognitionState",rule.net_amount_minor::text AS "netAmountMinor",rule.tax_amount_minor::text AS "taxAmountMinor",rule.gross_amount_minor::text AS "grossAmountMinor",rule.currency,rule.source_type AS "sourceType",rule.counterparty,rule.note,rule.status FROM mbox.recurring_operating_cost_rules rule JOIN mbox.operating_cost_category_definitions definition ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id AND definition.id=rule.category_definition_id JOIN mbox.cost_centers center ON center.tenant_id=rule.tenant_id AND center.store_id=rule.store_id AND center.id=rule.cost_center_id WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid ORDER BY rule.status,rule.starts_on DESC,rule.id`,
            ids(context),
          );
          const costs = await transaction.query(
            `SELECT cost.id,cost.public_id AS "publicId",COALESCE(cost.display_name,definition.name,cost.category) AS name,cost.category,cost.recognition_state AS "recognitionState",cost.allocation_period AS "allocationPeriod",cost.service_start_date::text AS "serviceStartDate",cost.service_end_date::text AS "serviceEndDate",cost.cash_paid_on::text AS "cashPaidOn",cost.net_amount_minor::text AS "netAmountMinor",cost.tax_amount_minor::text AS "taxAmountMinor",cost.gross_amount_minor::text AS "grossAmountMinor",cost.currency,cost.source_type AS "sourceType",cost.category_definition_id AS "categoryDefinitionId",cost.cost_center_id AS "costCenterId",center.name AS "costCenterName",cost.counterparty,cost.note,cost.corrects_cost_entry_id AS "correctsCostEntryId",cost.recurring_rule_id AS "recurringRuleId",cost.payroll_run_id AS "payrollRunId",EXISTS(SELECT 1 FROM mbox.operating_cost_entries correction WHERE correction.tenant_id=cost.tenant_id AND correction.store_id=cost.store_id AND correction.corrects_cost_entry_id=cost.id) AS corrected FROM mbox.operating_cost_entries cost LEFT JOIN mbox.operating_cost_category_definitions definition ON definition.tenant_id=cost.tenant_id AND definition.store_id=cost.store_id AND definition.id=cost.category_definition_id LEFT JOIN mbox.cost_centers center ON center.tenant_id=cost.tenant_id AND center.store_id=cost.store_id AND center.id=cost.cost_center_id WHERE cost.tenant_id=$1::uuid AND cost.store_id=$2::uuid AND cost.service_start_date<=$4::date AND cost.service_end_date>=$3::date ORDER BY cost.service_start_date DESC,cost.recorded_at DESC,cost.id`,
            [...ids(context), startDate, endDate],
          );
          const employees = canViewPayroll
            ? await transaction.query(
                `SELECT employee.id,employee.employee_code AS "employeeCode",employee.display_name AS "displayName",employee.status,COALESCE(array_agg(DISTINCT role.name) FILTER (WHERE role.id IS NOT NULL AND assignment.ends_at IS NULL),ARRAY[]::text[]) AS roles FROM mbox.employees employee LEFT JOIN mbox.employee_roles assignment ON assignment.tenant_id=employee.tenant_id AND assignment.store_id=employee.store_id AND assignment.employee_id=employee.id AND assignment.starts_at<=clock_timestamp() AND (assignment.ends_at IS NULL OR assignment.ends_at>clock_timestamp()) LEFT JOIN mbox.roles role ON role.tenant_id=assignment.tenant_id AND role.store_id=assignment.store_id AND role.id=assignment.role_id WHERE employee.tenant_id=$1::uuid AND employee.store_id=$2::uuid GROUP BY employee.id ORDER BY employee.status,employee.display_name,employee.id`,
                ids(context),
              )
            : emptyResult();
          const compensation = canViewPayroll
            ? await transaction.query(
                `SELECT rule.id,rule.public_id AS "publicId",rule.employee_id AS "employeeId",employee.display_name AS "employeeName",rule.cost_center_id AS "costCenterId",center.name AS "costCenterName",rule.pay_basis AS "payBasis",rule.base_rate_minor::text AS "baseRateMinor",rule.currency,rule.effective_from::text AS "effectiveFrom",rule.effective_until::text AS "effectiveUntil",rule.status,rule.reason FROM mbox.employee_compensation_rules rule JOIN mbox.employees employee ON employee.tenant_id=rule.tenant_id AND employee.store_id=rule.store_id AND employee.id=rule.employee_id JOIN mbox.cost_centers center ON center.tenant_id=rule.tenant_id AND center.store_id=rule.store_id AND center.id=rule.cost_center_id WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid ORDER BY rule.effective_from DESC,employee.display_name,rule.id`,
                ids(context),
              )
            : emptyResult();
          const payroll = canViewPayroll
            ? await transaction.query(
                `SELECT run.id,run.public_id AS "publicId",run.period_start::text AS "periodStart",run.period_end::text AS "periodEnd",run.status,run.currency,run.note,COUNT(line.id)::text AS "lineCount",COALESCE(SUM(line.gross_pay_minor),0)::text AS "grossPayMinor",COALESCE(SUM(line.net_pay_minor),0)::text AS "netPayMinor",COALESCE(SUM(line.employer_cost_minor),0)::text AS "employerCostMinor",run.approved_at::text AS "approvedAt",run.posted_at::text AS "postedAt",run.voided_at::text AS "voidedAt",run.void_reason AS "voidReason",run.version FROM mbox.payroll_runs run LEFT JOIN mbox.payroll_lines line ON line.tenant_id=run.tenant_id AND line.store_id=run.store_id AND line.payroll_run_id=run.id WHERE run.tenant_id=$1::uuid AND run.store_id=$2::uuid GROUP BY run.id ORDER BY run.period_end DESC,run.created_at DESC,run.id`,
                ids(context),
              )
            : emptyResult();
          const payrollLines = canViewPayroll ? await transaction.query(
            `SELECT line.id,line.payroll_run_id AS "payrollRunId",line.employee_id AS "employeeId",employee.display_name AS "employeeName",line.compensation_rule_id AS "compensationRuleId",line.units::text, line.base_pay_minor::text AS "basePayMinor",line.overtime_minor::text AS "overtimeMinor",line.bonus_minor::text AS "bonusMinor",line.commission_minor::text AS "commissionMinor",line.allowance_minor::text AS "allowanceMinor",line.deduction_minor::text AS "deductionMinor",line.employer_contribution_minor::text AS "employerContributionMinor",line.note FROM mbox.payroll_lines line JOIN mbox.employees employee ON employee.tenant_id=line.tenant_id AND employee.store_id=line.store_id AND employee.id=line.employee_id WHERE line.tenant_id=$1::uuid AND line.store_id=$2::uuid ORDER BY line.payroll_run_id,employee.display_name,line.id`, ids(context),
          ) : emptyResult();
          return {
            businessDate: context.businessDate,
            categories: categories.rows,
            costCenters: centers.rows,
            recurringRules: canViewCost ? numericRows(recurring.rows) : [],
            costs: canViewCost ? numericRows(costs.rows) : [],
            employees: employees.rows,
            compensationRules: numericRows(compensation.rows),
            payrollRuns: numericRows(payroll.rows),
            payrollLines: numericRows(payrollLines.rows),
            canViewPayroll,
            canViewCost,
          };
        },
        { readOnly: true, isolation: "repeatable-read" },
      );
      return reply.send({ data });
    }),
  );

  app.post("/commercial-ops/cost-categories", async (request, reply) =>
    handle(reply, async () => {
      const context = await options.resolveContext(request);
      const body = object(request.body);
      const input = {
        code: code(body.code),
        name: text(body.name, "名称", 64),
        systemCategory: enumValue(
          body.systemCategory,
          COST_CATEGORIES,
          "会计分类",
        ),
      };
      return commandReply(
        reply,
        options,
        context,
        request,
        "commercial.cost-category.create",
        input,
        async (transaction) => {
          await access(transaction).assertPermission(
            context.employeeId,
            "commercial.cost.manage",
          );
          const row = one(
            await transaction.query<{ id: string }>(
              `INSERT INTO mbox.operating_cost_category_definitions(tenant_id,store_id,code,name,system_category,created_by_employee_id) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid) RETURNING id`,
              [
                ...ids(context),
                input.code,
                input.name,
                input.systemCategory,
                context.employeeId,
              ],
            ),
          );
          return result(row.id, `cost-category-${row.id}`, "active");
        },
        "commercial.cost_category.created",
        "operating_cost_category",
      );
    }),
  );

  app.post("/commercial-ops/cost-centers", async (request, reply) =>
    handle(reply, async () => {
      const context = await options.resolveContext(request);
      const body = object(request.body);
      const input = {
        code: code(body.code),
        name: text(body.name, "名称", 64),
      };
      return commandReply(
        reply,
        options,
        context,
        request,
        "commercial.cost-center.create",
        input,
        async (transaction) => {
          await access(transaction).assertPermission(
            context.employeeId,
            "commercial.cost.manage",
          );
          const row = one(
            await transaction.query<{ id: string }>(
              `INSERT INTO mbox.cost_centers(tenant_id,store_id,code,name,created_by_employee_id) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid) RETURNING id`,
              [...ids(context), input.code, input.name, context.employeeId],
            ),
          );
          return result(row.id, `cost-center-${row.id}`, "active");
        },
        "commercial.cost_center.created",
        "cost_center",
      );
    }),
  );

  app.post("/commercial-ops/recurring-costs", async (request, reply) =>
    handle(reply, async () => {
      const context = await options.resolveContext(request);
      const body = object(request.body);
      const input = {
        name: text(body.name, "名称", 128),
        categoryDefinitionId: uuid(body.categoryDefinitionId, "费用分类"),
        costCenterId: uuid(body.costCenterId, "成本中心"),
        recurrence: enumValue(body.recurrence, PERIODS, "发生周期"),
        startsOn: date(body.startsOn, "开始日期"),
        endsOn: optionalDate(body.endsOn, "结束日期"),
        allocationPeriod: enumValue(
          body.allocationPeriod ?? body.recurrence,
          PERIODS,
          "分摊周期",
        ),
        recognitionState: enumValue(
          body.recognitionState,
          RECOGNITION,
          "确认状态",
        ),
        netAmountMinor: minor(body.netAmountMinor, "未税金额"),
        taxAmountMinor: minor(body.taxAmountMinor ?? 0, "税额"),
        sourceType: enumValue(body.sourceType, SOURCES, "来源"),
        counterparty: optionalText(body.counterparty, "收款方", 128),
        note: optionalText(body.note, "备注", 1000),
      };
      if (input.endsOn && input.endsOn < input.startsOn)
        throw new OwnerFinanceRequestError("结束日期不能早于开始日期");
      return commandReply(
        reply,
        options,
        context,
        request,
        "commercial.recurring-cost.create",
        input,
        async (transaction) => {
          await access(transaction).assertPermission(
            context.employeeId,
            "commercial.cost.manage",
          );
          const category = one(
            await transaction.query<{ system_category: CostCategory }>(
              `SELECT system_category FROM mbox.operating_cost_category_definitions WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'`,
              [...ids(context), input.categoryDefinitionId],
            ),
            "费用分类不存在或已停用",
          );
          if (category.system_category === "beverage_purchase")
            throw new OwnerFinanceRequestError(
              "酒水采购必须通过收货入库记录，不能建立自动周期费用",
            );
          if (category.system_category === "personnel")
            throw new OwnerFinanceRequestError(
              "员工工资必须通过工资核算记录，不能建立自动周期费用",
            );
          if (input.sourceType !== recurringSource(category.system_category))
            throw new OwnerFinanceRequestError("费用来源与费用分类不一致");
          const publicId = `recurring-cost-${randomUUID()}`;
          const row = one(
            await transaction.query<{ id: string }>(
              `INSERT INTO mbox.recurring_operating_cost_rules(tenant_id,store_id,public_id,name,category_definition_id,cost_center_id,recurrence,starts_on,ends_on,allocation_period,recognition_state,net_amount_minor,tax_amount_minor,currency,source_type,counterparty,note,created_by_employee_id) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7,$8::date,$9::date,$10,$11,$12::bigint,$13::bigint,'CNY',$14,$15,$16,$17::uuid) RETURNING id`,
              [
                ...ids(context),
                publicId,
                input.name,
                input.categoryDefinitionId,
                input.costCenterId,
                input.recurrence,
                input.startsOn,
                input.endsOn,
                input.allocationPeriod,
                input.recognitionState,
                input.netAmountMinor,
                input.taxAmountMinor,
                input.sourceType,
                input.counterparty,
                input.note,
                context.employeeId,
              ],
            ),
          );
          return result(row.id, publicId, "active");
        },
        "commercial.recurring_cost.created",
        "recurring_operating_cost",
      );
    }),
  );

  app.post(
    "/commercial-ops/recurring-costs/materialize",
    async (request, reply) =>
      handle(reply, async () => {
        const context = await options.resolveContext(request);
        const body = object(request.body);
        const throughDate = date(
          body.throughDate ?? context.businessDate,
          "生成截止日期",
        );
        return commandReply(
          reply,
          options,
          context,
          request,
          "commercial.recurring-cost.materialize",
          { throughDate },
          async (transaction) => {
            await access(transaction).assertPermission(
              context.employeeId,
              "commercial.cost.manage",
            );
            const rules = await transaction.query<RecurringDbRow>(
              `SELECT rule.id,rule.public_id,rule.name,rule.category_definition_id,rule.cost_center_id,rule.recurrence,rule.starts_on::text AS starts_on,rule.ends_on::text AS ends_on,rule.allocation_period,rule.recognition_state,rule.net_amount_minor::text AS net_amount_minor,rule.tax_amount_minor::text AS tax_amount_minor,rule.currency,rule.source_type,rule.counterparty,rule.note,definition.system_category FROM mbox.recurring_operating_cost_rules rule JOIN mbox.operating_cost_category_definitions definition ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id AND definition.id=rule.category_definition_id WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid AND rule.status='active' AND rule.starts_on<=$3::date AND (rule.ends_on IS NULL OR rule.ends_on>=rule.starts_on) ORDER BY rule.id`,
              [...ids(context), throughDate],
            );
            let created = 0;
            const repository = new CommercialOpsRepository(transaction);
            for (const rule of rules.rows) {
              for (const occurrence of occurrences(
                rule.starts_on,
                rule.ends_on,
                throughDate,
                rule.recurrence,
              )) {
                const exists = await transaction.query(
                  `SELECT 1 FROM mbox.operating_cost_entries WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND recurring_rule_id=$3::uuid AND recurring_occurrence_on=$4::date AND corrects_cost_entry_id IS NULL`,
                  [...ids(context), rule.id, occurrence],
                );
                if (exists.rowCount) continue;
                const window = serviceWindow(
                  occurrence,
                  rule.allocation_period,
                );
                await repository.createCost({
                  publicId: `cost-${randomUUID()}`,
                  category: rule.system_category,
                  recognitionState: rule.recognition_state,
                  allocationPeriod: rule.allocation_period,
                  serviceStartDate: window.startDate,
                  serviceEndDate: window.endDate,
                  cashPaidOn:
                    rule.recognition_state === "actual" ? occurrence : null,
                  netAmountMinor: numberMinor(rule.net_amount_minor),
                  taxAmountMinor: numberMinor(rule.tax_amount_minor),
                  currency: rule.currency,
                  sourceType: rule.source_type,
                  displayName: rule.name,
                  categoryDefinitionId: rule.category_definition_id,
                  costCenterId: rule.cost_center_id,
                  recurringRuleId: rule.id,
                  recurringOccurrenceOn: occurrence,
                  counterparty: rule.counterparty,
                  note: rule.note,
                  recordedBusinessDate: context.businessDate,
                  recordedByEmployeeId: context.employeeId,
                });
                created++;
              }
            }
      return {
        id: randomUUID(),
        publicId: `materialize-${throughDate}`,
        status: "completed",
        aggregateVersion: 1,
        createdCount: created,
      } satisfies FinanceResult;
          },
          "commercial.recurring_cost.materialized",
          "recurring_operating_cost",
        );
      }),
  );

  app.post<{ Params: { ruleId: string } }>(
    "/commercial-ops/recurring-costs/:ruleId/status",
    async (request, reply) =>
      handle(reply, async () => {
        const context = await options.resolveContext(request);
        const ruleId = uuid(request.params.ruleId, "周期费用规则");
        const body = object(request.body);
        const status = enumValue(
          body.status,
          ["active", "paused", "ended"] as const,
          "规则状态",
        );
        const reasonText = text(body.reason, "变更说明", 1000, 2);
        return commandReply(
          reply,
          options,
          context,
          request,
          "commercial.recurring-cost.status",
          { ruleId, status, reason: reasonText },
          async (transaction) => {
            await access(transaction).assertPermission(
              context.employeeId,
              "commercial.cost.manage",
            );
            const current = one(
              await transaction.query<{
                public_id: string;
                status: "active" | "paused" | "ended";
                version: number;
              }>(
                `SELECT public_id,status,version FROM mbox.recurring_operating_cost_rules WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE`,
                [...ids(context), ruleId],
              ),
              "周期费用规则不存在",
            );
            const allowed =
              (current.status === "active" &&
                (status === "paused" || status === "ended")) ||
              (current.status === "paused" &&
                (status === "active" || status === "ended"));
            if (!allowed)
              throw new OwnerFinanceRequestError(
                current.status === "ended"
                  ? "已结束的周期费用不能恢复，请新建规则"
                  : "周期费用规则状态没有变化",
              );
            const row = one(
              await transaction.query<{ public_id: string; version: number }>(
                `UPDATE mbox.recurring_operating_cost_rules SET status=$4,version=version+1,updated_at=clock_timestamp(),note=concat_ws(E'\n',note,$5::text) WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND version=$6 RETURNING public_id,version`,
                [
                  ...ids(context),
                  ruleId,
                  status,
                  reasonText,
                  current.version,
                ],
              ),
              "周期费用规则已被其他人修改，请刷新后重试",
            );
            return result(ruleId, row.public_id, status, row.version);
          },
          "commercial.recurring_cost.status_changed",
          "recurring_operating_cost",
        );
      }),
  );

  app.post("/commercial-ops/compensation-rules", async (request, reply) =>
    handle(reply, async () => {
      const context = await options.resolveContext(request);
      const body = object(request.body);
      const input = {
        employeeId: uuid(body.employeeId, "员工"),
        costCenterId: uuid(body.costCenterId, "成本中心"),
        payBasis: enumValue(body.payBasis, PAY_BASES, "计薪方式"),
        baseRateMinor: minor(body.baseRateMinor, "工资标准"),
        effectiveFrom: date(body.effectiveFrom, "生效日期"),
        effectiveUntil: optionalDate(body.effectiveUntil, "失效日期"),
        reason: text(body.reason, "调整原因", 1000, 2),
      };
      if (input.effectiveUntil && input.effectiveUntil < input.effectiveFrom)
        throw new OwnerFinanceRequestError("失效日期不能早于生效日期");
      return commandReply(
        reply,
        options,
        context,
        request,
        "commercial.compensation-rule.create",
        input,
        async (transaction) => {
          await access(transaction).assertPermission(
            context.employeeId,
            "commercial.payroll.manage",
          );
          const activeRule = await transaction.query<{
            effective_from: string;
          }>(
            `SELECT effective_from::text AS effective_from FROM mbox.employee_compensation_rules WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND employee_id=$3::uuid AND status='active' FOR UPDATE`,
            [...ids(context), input.employeeId],
          );
          const currentEffectiveFrom = activeRule.rows[0]?.effective_from;
          if (
            currentEffectiveFrom &&
            input.effectiveFrom <= currentEffectiveFrom
          )
            throw new OwnerFinanceRequestError(
              "新薪资标准的生效日必须晚于当前标准",
            );
          if (currentEffectiveFrom)
            await transaction.query(
              `UPDATE mbox.employee_compensation_rules SET status='superseded',effective_until=($4::date-1) WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND employee_id=$3::uuid AND status='active'`,
              [...ids(context), input.employeeId, input.effectiveFrom],
            );
          const publicId = `compensation-${randomUUID()}`;
          const row = one(
            await transaction.query<{ id: string }>(
              `INSERT INTO mbox.employee_compensation_rules(tenant_id,store_id,public_id,employee_id,cost_center_id,pay_basis,base_rate_minor,currency,effective_from,effective_until,reason,created_by_employee_id) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$7::bigint,'CNY',$8::date,$9::date,$10,$11::uuid) RETURNING id`,
              [
                ...ids(context),
                publicId,
                input.employeeId,
                input.costCenterId,
                input.payBasis,
                input.baseRateMinor,
                input.effectiveFrom,
                input.effectiveUntil,
                input.reason,
                context.employeeId,
              ],
            ),
          );
          return result(row.id, publicId, "active");
        },
        "commercial.compensation_rule.created",
        "employee_compensation_rule",
      );
    }),
  );

  app.post("/commercial-ops/payroll-runs", async (request, reply) =>
    handle(reply, async () => {
      const context = await options.resolveContext(request);
      const body = object(request.body);
      const rawLines = array(body.lines, "工资明细");
      if ((!rawLines.length && !body.removeEmployeeId) || rawLines.length > 200)
        throw new OwnerFinanceRequestError("工资明细数量不正确");
      const input = {
        draftRunId: body.draftRunId ? uuid(body.draftRunId, "工资草稿") : null,
        expectedVersion: body.draftRunId ? integer(body.expectedVersion, "草稿版本", 1, 1_000_000) : null,
        replaceEmployeeLine: body.replaceEmployeeLine === true,
        removeEmployeeId: body.removeEmployeeId ? uuid(body.removeEmployeeId, "移除员工") : null,
        periodStart: date(body.periodStart, "周期开始"),
        periodEnd: date(body.periodEnd, "周期结束"),
        note: optionalText(body.note, "备注", 1000),
        lines: rawLines.map((raw, index) => payrollLine(object(raw), index)),
      };
      if (input.periodEnd < input.periodStart)
        throw new OwnerFinanceRequestError("工资周期不正确");
      if (new Set(input.lines.map((line) => line.employeeId)).size !== input.lines.length)
        throw new OwnerFinanceRequestError("同一工资批次不能重复录入同一员工");
      if (input.removeEmployeeId && (!input.draftRunId || input.lines.length))
        throw new OwnerFinanceRequestError("请单独移除草稿中的员工明细");
      return commandReply(
        reply,
        options,
        context,
        request,
        "commercial.payroll-run.create",
        input,
        async (transaction) => {
          await access(transaction).assertPermission(
            context.employeeId,
            "commercial.payroll.manage",
          );
          const overlapping = await transaction.query<{ id: string; public_id: string; status: string; period_start: string; period_end: string; version: number }>(
            `SELECT id,public_id,status,period_start::text,period_end::text,version FROM mbox.payroll_runs WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status<>'voided' AND daterange(period_start,period_end,'[]') && daterange($3::date,$4::date,'[]') LIMIT 1 FOR UPDATE`,
            [...ids(context), input.periodStart, input.periodEnd],
          );
          const draft = overlapping.rows[0];
          if (input.draftRunId && (!draft || draft.id !== input.draftRunId || draft.status !== 'draft'
            || draft.period_start !== input.periodStart || draft.period_end !== input.periodEnd || draft.version !== input.expectedVersion))
            throw new OwnerFinanceRequestError("工资草稿已变化或已确认，请刷新后核对；未覆盖他人修改");
          if (overlapping.rowCount && !input.draftRunId)
            throw new OwnerFinanceRequestError(
              "该工资周期与已有工资单重叠，请先作废未入账工资单或调整周期",
            );
          const publicId = draft?.public_id ?? `payroll-${randomUUID()}`;
          const run = draft ?? one(
            await transaction.query<{ id: string }>(
              `INSERT INTO mbox.payroll_runs(tenant_id,store_id,public_id,period_start,period_end,currency,note,created_by_employee_id) VALUES($1::uuid,$2::uuid,$3,$4::date,$5::date,'CNY',$6,$7::uuid) RETURNING id`,
              [
                ...ids(context),
                publicId,
                input.periodStart,
                input.periodEnd,
                input.note,
                context.employeeId,
              ],
            ),
          );
          const previousLines = input.draftRunId ? await transaction.query<JsonObject>(
            `SELECT * FROM mbox.payroll_lines WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payroll_run_id=$3::uuid ORDER BY id`,
            [...ids(context), run.id],
          ) : { rows: [] };
          const appendedCount = input.lines.filter((line) => !previousLines.rows.some((row) => row.employee_id === line.employeeId)).length;
          if (previousLines.rows.length + appendedCount > 200) throw new OwnerFinanceRequestError("一个工资周期最多200名员工");
          if (input.removeEmployeeId) {
            if (previousLines.rows.length <= 1) throw new OwnerFinanceRequestError("最后一条明细请通过作废整个草稿处理");
            const removed = await transaction.query(
              `DELETE FROM mbox.payroll_lines WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payroll_run_id=$3::uuid AND employee_id=$4::uuid RETURNING id`,
              [...ids(context), run.id, input.removeEmployeeId],
            );
            if (!removed.rowCount) throw new OwnerFinanceRequestError("该员工明细不存在，请刷新");
          }
          for (const line of input.lines) {
            const exists = previousLines.rows.some((row) => row.employee_id === line.employeeId);
            if (exists && !input.replaceEmployeeLine) throw new OwnerFinanceRequestError("该员工已有工资明细，请选择编辑，不要重复追加");
            if (input.replaceEmployeeLine && !exists) throw new OwnerFinanceRequestError("待编辑的员工明细已变化，请刷新");
            if (exists) await transaction.query(
              `DELETE FROM mbox.payroll_lines WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payroll_run_id=$3::uuid AND employee_id=$4::uuid`,
              [...ids(context), run.id, line.employeeId],
            );
            const rule = one(
              await transaction.query<CompensationRuleDbRow>(
                `SELECT rule.pay_basis,rule.base_rate_minor::text AS base_rate_minor,rule.effective_from::text AS effective_from,rule.effective_until::text AS effective_until FROM mbox.employee_compensation_rules rule JOIN mbox.employees employee ON employee.tenant_id=rule.tenant_id AND employee.store_id=rule.store_id AND employee.id=rule.employee_id WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid AND rule.id=$3::uuid AND rule.employee_id=$4::uuid AND rule.effective_from<=$5::date AND (rule.effective_until IS NULL OR rule.effective_until>=$6::date)`,
                [
                  ...ids(context),
                  line.compensationRuleId,
                  line.employeeId,
                  input.periodStart,
                  input.periodEnd,
                ],
              ),
              "薪资规则与员工或工资周期不匹配",
            );
            const basePayMinor = calculatedBasePayMinor(
              numberMinor(rule.base_rate_minor),
              rule.pay_basis,
              line.units,
            );
            if (
              line.expectedBasePayMinor !== null &&
              line.expectedBasePayMinor !== basePayMinor
            )
              throw new OwnerFinanceRequestError(
                "基本工资与服务端薪资规则不一致，请刷新后重试",
              );
            if (
              line.deductionMinor >
              basePayMinor +
                line.overtimeMinor +
                line.bonusMinor +
                line.commissionMinor +
                line.allowanceMinor
            )
              throw new OwnerFinanceRequestError("扣款不能大于应发工资");
            await transaction.query(
              `INSERT INTO mbox.payroll_lines(tenant_id,store_id,payroll_run_id,employee_id,compensation_rule_id,units,base_pay_minor,overtime_minor,bonus_minor,commission_minor,allowance_minor,deduction_minor,employer_contribution_minor,note) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::numeric,$7::bigint,$8::bigint,$9::bigint,$10::bigint,$11::bigint,$12::bigint,$13::bigint,$14)`,
              [
                ...ids(context),
                run.id,
                line.employeeId,
                line.compensationRuleId,
                line.units,
                basePayMinor,
                line.overtimeMinor,
                line.bonusMinor,
                line.commissionMinor,
                line.allowanceMinor,
                line.deductionMinor,
                line.employerContributionMinor,
                line.note,
              ],
            );
          }
          const version = draft ? one(await transaction.query<{ version: number }>(
            `UPDATE mbox.payroll_runs SET version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid RETURNING version`,
            [...ids(context), run.id],
          )).version : 1;
          return { ...result(run.id, publicId, "draft", version),
            ...(draft ? { previousLines: JSON.parse(JSON.stringify(previousLines.rows)) as JsonValue, changes: JSON.parse(JSON.stringify(input)) as JsonValue } : {}) };
        },
        input.draftRunId ? "commercial.payroll_run.draft_updated" : "commercial.payroll_run.created",
        "payroll_run",
      );
    }),
  );

  app.post<{ Params: { runId: string } }>(
    "/commercial-ops/payroll-runs/:runId/approve",
    async (request, reply) =>
      handle(reply, async () => {
        const context = await options.resolveContext(request);
        const runId = uuid(request.params.runId, "工资单");
        const body = object(request.body);
        const reasonText = text(body.reason, "确认说明", 1000, 2);
        return commandReply(
          reply,
          options,
          context,
          request,
          "commercial.payroll-run.approve",
          { runId, reason: reasonText },
          async (transaction) => {
            await access(transaction).assertPermission(
              context.employeeId,
              "commercial.payroll.manage",
            );
            const row = one(
              await transaction.query<{
                public_id: string;
                version: number;
              }>(
                `UPDATE mbox.payroll_runs SET status='approved',approved_by_employee_id=$4::uuid,approved_at=clock_timestamp(),updated_at=clock_timestamp(),note=concat_ws(E'\n',note,$5::text),version=version+1 WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='draft' RETURNING public_id,version`,
                [...ids(context), runId, context.employeeId, reasonText],
              ),
              "工资草稿不存在或状态已改变",
            );
            return result(runId, row.public_id, "approved", row.version);
          },
          "commercial.payroll_run.approved",
          "payroll_run",
        );
      }),
  );

  app.post<{ Params: { runId: string } }>(
    "/commercial-ops/payroll-runs/:runId/void",
    async (request, reply) =>
      handle(reply, async () => {
        const context = await options.resolveContext(request);
        const runId = uuid(request.params.runId, "工资单");
        const body = object(request.body);
        const reasonText = text(body.reason, "作废原因", 1000, 2);
        return commandReply(
          reply,
          options,
          context,
          request,
          "commercial.payroll-run.void",
          { runId, reason: reasonText },
          async (transaction) => {
            await access(transaction).assertPermission(
              context.employeeId,
              "commercial.payroll.manage",
            );
            const row = one(
              await transaction.query<{
                public_id: string;
                version: number;
              }>(
                `UPDATE mbox.payroll_runs SET status='voided',voided_by_employee_id=$4::uuid,voided_at=clock_timestamp(),void_reason=$5,updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status IN ('draft','approved') RETURNING public_id,version`,
                [...ids(context), runId, context.employeeId, reasonText],
              ),
              "工资单已入账、已作废或不存在，不能作废",
            );
            return result(runId, row.public_id, "voided", row.version);
          },
          "commercial.payroll_run.voided",
          "payroll_run",
        );
      }),
  );

  app.post<{ Params: { runId: string } }>(
    "/commercial-ops/payroll-runs/:runId/post",
    async (request, reply) =>
      handle(reply, async () => {
        const context = await options.resolveContext(request);
        const runId = uuid(request.params.runId, "工资单");
        const body = object(request.body);
        const reasonText = text(body.reason, "入账说明", 1000, 2);
        return commandReply(
          reply,
          options,
          context,
          request,
          "commercial.payroll-run.post",
          { runId, reason: reasonText },
          async (transaction) => {
            await access(transaction).assertPermission(
              context.employeeId,
              "commercial.payroll.post",
            );
            const run = one(
              await transaction.query<PayrollRunDbRow>(
                `SELECT id,public_id,period_start::text AS period_start,period_end::text AS period_end,currency,version FROM mbox.payroll_runs WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved' FOR UPDATE`,
                [...ids(context), runId],
              ),
              "工资单不是待入账状态",
            );
            const category = one(
              await transaction.query<{
                id: string;
                system_category: CostCategory;
              }>(
                `SELECT id,system_category FROM mbox.operating_cost_category_definitions WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code='payroll' AND status='active'`,
                ids(context),
              ),
              "工资费用分类缺失",
            );
            const defaultCenter = one(
              await transaction.query<{ id: string }>(
                `SELECT id FROM mbox.cost_centers WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code='administration' AND status='active'`,
                ids(context),
              ),
              "行政成本中心缺失",
            );
            const lines = await transaction.query<PayrollLineDbRow>(
              `SELECT line.*,COALESCE(rule.cost_center_id,$4::uuid) AS resolved_cost_center_id,employee.display_name FROM mbox.payroll_lines line JOIN mbox.employees employee ON employee.tenant_id=line.tenant_id AND employee.store_id=line.store_id AND employee.id=line.employee_id LEFT JOIN mbox.employee_compensation_rules rule ON rule.tenant_id=line.tenant_id AND rule.store_id=line.store_id AND rule.id=line.compensation_rule_id WHERE line.tenant_id=$1::uuid AND line.store_id=$2::uuid AND line.payroll_run_id=$3::uuid ORDER BY line.id`,
              [...ids(context), runId, defaultCenter.id],
            );
            if (!lines.rowCount)
              throw new OwnerFinanceRequestError("工资单没有明细");
            const repository = new CommercialOpsRepository(transaction);
            for (const line of lines.rows) {
              await repository.createCost({
                publicId: `cost-${randomUUID()}`,
                category: category.system_category,
                recognitionState: "known",
                allocationPeriod: allocationForRange(
                  run.period_start,
                  run.period_end,
                ),
                serviceStartDate: run.period_start,
                serviceEndDate: run.period_end,
                cashPaidOn: null,
                netAmountMinor: numberMinor(line.employer_cost_minor),
                taxAmountMinor: 0,
                currency: run.currency,
                sourceType: "payroll",
                displayName: `${line.display_name}工资`,
                categoryDefinitionId: category.id,
                costCenterId: line.resolved_cost_center_id,
                payrollRunId: run.id,
                payrollLineId: line.id,
                employeeId: line.employee_id,
                note: reasonText,
                recordedBusinessDate: context.businessDate,
                recordedByEmployeeId: context.employeeId,
              });
            }
            const posted = one(
              await transaction.query<{ version: number }>(
                `UPDATE mbox.payroll_runs SET status='posted',posted_by_employee_id=$4::uuid,posted_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved' RETURNING version`,
                [...ids(context), runId, context.employeeId],
              ),
              "工资单状态已改变，未完成入账",
            );
            return result(runId, run.public_id, "posted", posted.version);
          },
          "commercial.payroll_run.posted",
          "payroll_run",
        );
      }),
  );
};

async function commandReply(
  reply: FastifyReply,
  options: OwnerFinanceApiOptions,
  context: NormalizedOperationsRequestContext,
  request: FastifyRequest,
  operationScope: string,
  input: unknown,
  work: (transaction: ScopedTransaction) => Promise<FinanceResult>,
  action: string,
  objectType: string,
) {
  const idempotencyKey = idempotency(request);
  const execution = await options.commandExecutor.execute(
    {
      scope: context.scope,
      operationScope,
      idempotencyKey,
      requestFingerprint: JSON.stringify({ input, actor: context.employeeId }),
      resultCodec: codec<FinanceResult>(),
    },
    async (transaction) => {
      const value = await work(transaction);
      return {
        result: value,
        auditEvents: [
          {
            actor: {
              type: "employee" as const,
              employeeId: context.employeeId,
            },
            action,
            objectType,
            objectId: value.id,
            businessDate: context.businessDate,
            afterData: value,
          },
        ],
        outboxMessages: [
          {
            aggregateType: objectType,
            aggregateId: value.id,
            aggregateVersion: value.aggregateVersion ?? 1,
            eventType: `${action}.v1`,
            payload: value,
          },
        ],
      };
    },
  );
  return reply
    .code(execution.replayed ? 200 : 201)
    .send({ data: execution.value, replayed: execution.replayed });
}

type RecurringDbRow = {
  id: string;
  public_id: string;
  name: string;
  category_definition_id: string;
  cost_center_id: string;
  recurrence: CostAllocationPeriod;
  starts_on: string;
  ends_on: string | null;
  allocation_period: CostAllocationPeriod;
  recognition_state: CostRecognitionState;
  net_amount_minor: string | number;
  tax_amount_minor: string | number;
  currency: string;
  source_type: Exclude<CostSourceType, "inventory_purchase">;
  counterparty: string | null;
  note: string | null;
  system_category: CostCategory;
};
type PayrollRunDbRow = {
  id: string;
  public_id: string;
  period_start: string;
  period_end: string;
  currency: string;
  version: number;
};
type PayrollLineDbRow = {
  id: string;
  employee_id: string;
  employer_cost_minor: string | number;
  resolved_cost_center_id: string;
  display_name: string;
};
type CompensationRuleDbRow = {
  pay_basis: "monthly" | "daily" | "hourly" | "per_shift";
  base_rate_minor: string | number;
  effective_from: string;
  effective_until: string | null;
};

function payrollLine(body: Record<string, unknown>, index: number) {
  const prefix = `第${index + 1}条`;
  return {
    employeeId: uuid(body.employeeId, `${prefix}员工`),
    compensationRuleId: uuid(body.compensationRuleId, `${prefix}薪资规则`),
    units: positiveDecimal(body.units ?? 1, `${prefix}计薪数量`),
    expectedBasePayMinor:
      body.basePayMinor === undefined
        ? null
        : minor(body.basePayMinor, `${prefix}基本工资`),
    overtimeMinor: minor(body.overtimeMinor ?? 0, `${prefix}加班`),
    bonusMinor: minor(body.bonusMinor ?? 0, `${prefix}奖金`),
    commissionMinor: minor(body.commissionMinor ?? 0, `${prefix}提成`),
    allowanceMinor: minor(body.allowanceMinor ?? 0, `${prefix}补贴`),
    deductionMinor: minor(body.deductionMinor ?? 0, `${prefix}扣款`),
    employerContributionMinor: minor(
      body.employerContributionMinor ?? 0,
      `${prefix}雇主承担`,
    ),
    note: optionalText(body.note, `${prefix}备注`, 1000),
  };
}
function calculatedBasePayMinor(
  baseRateMinor: number,
  payBasis: CompensationRuleDbRow["pay_basis"],
  units: string,
) {
  const quantityHundredths = Math.round(Number(units) * 100);
  if (payBasis === "monthly" && quantityHundredths !== 100)
    throw new OwnerFinanceRequestError("月薪的计薪数量必须为1个月");
  const amount = Math.round((baseRateMinor * quantityHundredths) / 100);
  if (!Number.isSafeInteger(amount))
    throw new OwnerFinanceRequestError("基本工资超出安全范围");
  return amount;
}
function recurringSource(
  category: CostCategory,
): Exclude<CostSourceType, "inventory_purchase"> {
  if (category === "rent") return "lease";
  if (category === "band" || category === "performer") return "performance";
  if (category === "utilities") return "utility_bill";
  return "manual";
}
function occurrences(
  start: string,
  end: string | null,
  through: string,
  period: CostAllocationPeriod,
) {
  const stop = end && end < through ? end : through;
  const result: string[] = [];
  for (let index = 0; index < 800; index++) {
    const candidate = addPeriod(start, period, index);
    if (candidate > stop) break;
    result.push(candidate);
  }
  if (result.length === 800)
    throw new OwnerFinanceRequestError("周期费用跨度过大，请缩短截止日期");
  return result;
}
function serviceWindow(start: string, period: CostAllocationPeriod) {
  return {
    startDate: start,
    endDate:
      period === "day" ? start : addDays(addPeriod(start, period, 1), -1),
  };
}
function addPeriod(value: string, period: CostAllocationPeriod, count: number) {
  if (period === "day") return addDays(value, count);
  if (period === "week") return addDays(value, count * 7);
  return addMonths(
    value,
    count * (period === "month" ? 1 : period === "quarter" ? 3 : 12),
  );
}
function addMonths(value: string, months: number) {
  const source = parseDate(value);
  const targetMonth = source.getUTCMonth() + months;
  const first = new Date(Date.UTC(source.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return formatDate(
    new Date(
      Date.UTC(
        first.getUTCFullYear(),
        first.getUTCMonth(),
        Math.min(source.getUTCDate(), lastDay),
      ),
    ),
  );
}
function addDays(value: string, days: number) {
  const parsed = parseDate(value);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatDate(parsed);
}
function parseDate(value: string) {
  return new Date(`${value}T00:00:00Z`);
}
function formatDate(value: Date) {
  return value.toISOString().slice(0, 10);
}
function monthStart(value: string) {
  return `${value.slice(0, 7)}-01`;
}
function monthEnd(value: string) {
  const parsed = parseDate(monthStart(value));
  parsed.setUTCMonth(parsed.getUTCMonth() + 1);
  parsed.setUTCDate(0);
  return formatDate(parsed);
}
function allocationForRange(start: string, end: string): CostAllocationPeriod {
  const days =
    Math.round(
      (parseDate(end).getTime() - parseDate(start).getTime()) / 86400000,
    ) + 1;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 93) return "quarter";
  return "year";
}
function ids(context: NormalizedOperationsRequestContext) {
  return [context.scope.tenantId, context.scope.storeId];
}
function emptyResult() {
  return { rows: [], rowCount: 0 };
}
function numericRows(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) =>
        key.endsWith("Minor") || key === "lineCount"
          ? [key, numberMinor(value as string | number)]
          : [key, value],
      ),
    ),
  );
}
function result(
  id: string,
  publicId: string,
  status: string,
  aggregateVersion = 1,
): FinanceResult {
  return { id, publicId, status, aggregateVersion };
}
function one<T>(query: { rows: T[] }, message = "记录不存在"): T {
  const row = query.rows[0];
  if (!row) throw new OwnerFinanceRequestError(message);
  return row;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OwnerFinanceRequestError("请求内容不正确");
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new OwnerFinanceRequestError(`${label}不正确`);
  return value;
}
function text(value: unknown, label: string, max: number, min = 1) {
  if (typeof value !== "string") {
    throw new OwnerFinanceRequestError(`${label}不正确`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max)
    throw new OwnerFinanceRequestError(`${label}长度不正确`);
  return normalized;
}
function optionalText(value: unknown, label: string, max: number) {
  return value === undefined || value === null || value === ""
    ? null
    : text(value, label, max);
}
function code(value: unknown) {
  const parsed = text(value, "编码", 64);
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(parsed))
    throw new OwnerFinanceRequestError(
      "编码只能使用小写字母、数字、点、横线或下划线",
    );
  return parsed;
}
function uuid(value: unknown, label: string) {
  const parsed = text(value, label, 36, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      parsed,
    )
  )
    throw new OwnerFinanceRequestError(`${label}不正确`);
  return parsed;
}
function date(value: unknown, label: string) {
  const parsed = text(value, label, 10, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed) ||
    Number.isNaN(Date.parse(`${parsed}T00:00:00Z`))
  )
    throw new OwnerFinanceRequestError(`${label}格式不正确`);
  return parsed;
}
function optionalDate(value: unknown, label: string) {
  return value === undefined || value === null || value === ""
    ? null
    : date(value, label);
}
function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    throw new OwnerFinanceRequestError(`${label}不正确`);
  return Number(value);
}
function minor(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new OwnerFinanceRequestError(`${label}必须是非负整数分`);
  return Number(value);
}
function numberMinor(value: string | number) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed))
    throw new OwnerFinanceRequestError("金额超出安全范围");
  return parsed;
}
function decimal(value: unknown, label: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10000)
    throw new OwnerFinanceRequestError(`${label}不正确`);
  return parsed.toFixed(2);
}
function positiveDecimal(value: unknown, label: string) {
  const parsed = decimal(value, label);
  if (Number(parsed) <= 0)
    throw new OwnerFinanceRequestError(`${label}必须大于0`);
  return parsed;
}
function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  const parsed = text(value, label, 64);
  if (!values.includes(parsed as T))
    throw new OwnerFinanceRequestError(`${label}不正确`);
  return parsed as T;
}
function idempotency(request: FastifyRequest) {
  const value =
    request.headers["idempotency-key"] ?? request.headers["x-idempotency-key"];
  if (
    Array.isArray(value) ||
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)
  )
    throw new OwnerFinanceRequestError("缺少有效的幂等键");
  return value;
}
function codec<T>(): JsonCodec<T> {
  return {
    encode: (value) => JSON.parse(JSON.stringify(value)) as JsonValue,
    decode: (value) => value as T,
  };
}

class OwnerFinanceRequestError extends Error {}
async function handle(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StaffAccessDeniedError)
      return reply
        .code(403)
        .send({
          error: {
            code: "OWNER_FINANCE_FORBIDDEN",
            message: "当前员工没有经营财务权限",
          },
        });
    if (error instanceof StaffNotFoundError)
      return reply
        .code(401)
        .send({
          error: {
            code: "OWNER_FINANCE_SESSION_INVALID",
            message: "员工登录状态无效",
          },
        });
    if (
      error instanceof OwnerFinanceRequestError ||
      error instanceof TypeError ||
      error instanceof RangeError
    )
      return reply
        .code(400)
        .send({
          error: {
            code: "OWNER_FINANCE_REQUEST_INVALID",
            message: error.message,
          },
        });
    if (
      error instanceof IdempotencyConflictError ||
      error instanceof IdempotencyInProgressError
    )
      return reply
        .code(409)
        .send({
          error: { code: "OWNER_FINANCE_CONFLICT", message: error.message },
        });
    if (
      databaseErrorCode(error) === "23P01" ||
      databaseErrorCode(error) === "23505"
    )
      return reply.code(409).send({
        error: {
          code: "OWNER_FINANCE_CONFLICT",
          message: "已有生效中的重复或重叠记录，请刷新后核对",
        },
      });
    if (error instanceof IdempotencyRecordError)
      return reply
        .code(503)
        .send({
          error: {
            code: "OWNER_FINANCE_UNAVAILABLE",
            message: "经营财务服务暂时不可用",
          },
        });
    requestLog(reply, error);
    return reply
      .code(500)
      .send({
        error: {
          code: "OWNER_FINANCE_INTERNAL_ERROR",
          message: "经营财务服务暂时不可用",
        },
      });
  }
}
function databaseErrorCode(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}
function requestLog(reply: FastifyReply, error: unknown) {
  reply.log.error({ err: error }, "owner finance API failed");
}

const COST_CATEGORIES = [
  "beverage_purchase",
  "personnel",
  "performer",
  "band",
  "rent",
  "utilities",
  "miscellaneous",
] as const satisfies readonly CostCategory[];
const PERIODS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const satisfies readonly CostAllocationPeriod[];
const RECOGNITION = [
  "known",
  "accrual",
  "actual",
] as const satisfies readonly CostRecognitionState[];
const SOURCES = [
  "payroll",
  "performance",
  "lease",
  "utility_bill",
  "manual",
] as const;
const PAY_BASES = ["monthly", "daily", "hourly", "per_shift"] as const;
