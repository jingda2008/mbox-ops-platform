import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  CalendarPlus,
  CircleDollarSign,
  RefreshCw,
  Settings2,
  Users,
} from "lucide-react";
import {
  NormalizedApiError,
  type NormalizedApiClient,
  type StaffAuthView,
} from "../normalized-api";
import { useConfirmationDialog } from "./ConfirmationDialog";
import { NumberInputWithUnit } from "./NumberInputWithUnit";
import "./owner-finance-panel.css";
import { executeRecoverableCommand } from "./recoverable-command";

type Mode = "cost" | "recurring" | "payroll" | "settings";
type Category = {
  id: string;
  code: string;
  name: string;
  systemCategory: string;
  isSystem: boolean;
};
type CostCenter = { id: string; code: string; name: string; isSystem: boolean };
type Employee = {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
  roles: string[];
};
type Compensation = {
  id: string;
  publicId: string;
  employeeId: string;
  employeeName: string;
  costCenterId: string;
  costCenterName: string;
  payBasis: string;
  baseRateMinor: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  status: string;
  reason: string;
};
type Cost = {
  id: string;
  publicId: string;
  name: string;
  category: string;
  recognitionState: string;
  allocationPeriod: string;
  serviceStartDate: string;
  serviceEndDate: string;
  cashPaidOn: string | null;
  netAmountMinor: number;
  taxAmountMinor: number;
  grossAmountMinor: number;
  currency: string;
  sourceType: string;
  categoryDefinitionId: string | null;
  costCenterId: string | null;
  costCenterName: string | null;
  counterparty: string | null;
  note: string | null;
  correctsCostEntryId: string | null;
  recurringRuleId: string | null;
  payrollRunId: string | null;
  corrected: boolean;
};
type Recurring = {
  id: string;
  publicId: string;
  name: string;
  categoryName: string;
  systemCategory: string;
  categoryDefinitionId: string;
  costCenterId: string;
  costCenterName: string;
  recurrence: string;
  startsOn: string;
  endsOn: string | null;
  allocationPeriod: string;
  recognitionState: string;
  grossAmountMinor: number;
  status: string;
};
type Payroll = {
  id: string;
  publicId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  lineCount: number;
  grossPayMinor: number;
  netPayMinor: number;
  employerCostMinor: number;
  approvedAt: string | null;
  postedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  version: number;
};
type PayrollLine = {
  id: string; payrollRunId: string; employeeId: string; employeeName: string;
  compensationRuleId: string; units: string; basePayMinor: number; overtimeMinor: number;
  bonusMinor: number; commissionMinor: number; allowanceMinor: number; deductionMinor: number;
  employerContributionMinor: number; note: string | null;
};
type Overview = {
  businessDate: string;
  categories: Category[];
  costCenters: CostCenter[];
  employees: Employee[];
  compensationRules: Compensation[];
  costs: Cost[];
  recurringRules: Recurring[];
  payrollRuns: Payroll[];
  payrollLines: PayrollLine[];
  canViewCost: boolean;
  canViewPayroll: boolean;
};

export function OwnerFinancePanel({
  api,
  auth,
}: {
  api: NormalizedApiClient;
  auth: StaffAuthView;
}) {
  const { confirmAction } = useConfirmationDialog();
  function postCommand(endpoint: string, body: unknown, options: { idempotencyKey: string }) {
    return executeRecoverableCommand(auth.employee.id + ":" + endpoint, body, options.idempotencyKey,
      (idempotencyKey) => api.postEndpoint(endpoint, body, { idempotencyKey }));
  }
  const [mode, setMode] = useState<Mode>(auth.permissions.some((p) => p.startsWith("commercial.cost.")) ? "cost" : "payroll");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const costFormRef = useRef<HTMLFormElement>(null);
  const [correctingCost, setCorrectingCost] = useState<Cost | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [editingPayrollLine, setEditingPayrollLine] = useState<PayrollLine | null>(null);
  const writeInFlight = useRef(false);
  const loadGeneration = useRef(0);
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const [range, setRange] = useState({ start: firstOfMonth, end: today });
  const [cost, setCost] = useState({
    name: "",
    categoryId: "",
    centerId: "",
    amount: "",
    tax: "0",
    start: today,
    end: today,
    paid: true,
    paidOn: today,
    counterparty: "",
    note: "",
  });
  const [recurring, setRecurring] = useState({
    name: "",
    categoryId: "",
    centerId: "",
    amount: "",
    tax: "0",
    recurrence: "month",
    start: firstOfMonth,
    end: "",
    paid: false,
    counterparty: "",
    note: "",
  });
  const [setting, setSetting] = useState({
    kind: "category" as "category" | "center",
    name: "",
    systemCategory: "miscellaneous",
  });
  const [comp, setComp] = useState({
    employeeId: "",
    centerId: "",
    payBasis: "monthly",
    rate: "",
    effectiveFrom: firstOfMonth,
    reason: "首次录入薪资标准",
  });
  const [payroll, setPayroll] = useState({
    employeeId: "",
    periodStart: firstOfMonth,
    periodEnd: today,
    units: "1",
    base: "",
    overtime: "0",
    bonus: "0",
    commission: "0",
    allowance: "0",
    deduction: "0",
    employerContribution: "0",
    note: "",
  });
  const canManage = auth.permissions.includes("commercial.cost.manage");
  const canPayroll =
    auth.permissions.includes("commercial.payroll.manage") &&
    overview?.canViewPayroll === true;
  const load = useCallback(async (afterWrite = false) => {
    const generation = ++loadGeneration.current;
    if (!range.start || !range.end || range.start > range.end) {
      setNotice("请选择完整且起止顺序正确的日期范围。");
      setBusy("");
      return;
    }
    setBusy("load");
    if (!afterWrite) setNotice("");
    try {
      const response = await api.getEndpoint<{ data: Overview }>(
        `/api/commercial-ops/owner-finance?startDate=${range.start}&endDate=${range.end}`,
      );
      if (generation === loadGeneration.current) setOverview(response.data);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setNotice((previous) => (afterWrite ? `${previous}；刷新失败，请刷新记录核对，勿重复新建。` : errorMessage(error, "经营费用暂时无法读取")));
    } finally {
      if (generation === loadGeneration.current) setBusy("");
    }
  }, [api, range.start, range.end]);
  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);
  useEffect(() => {
    if (!overview) return;
    const monthStart = `${overview.businessDate.slice(0, 7)}-01`;
    setCost((value) => ({
      ...value,
      categoryId:
        value.categoryId || operatingExpenseCategories(overview.categories)[0]?.id || "",
      centerId: value.centerId || overview.costCenters[0]?.id || "",
      start: value.start === today ? overview.businessDate : value.start,
      end: value.end === today ? overview.businessDate : value.end,
      paidOn:
        value.paidOn === today ? overview.businessDate : value.paidOn,
    }));
    setRecurring((value) => ({
      ...value,
      categoryId:
        value.categoryId ||
        recurringExpenseCategories(overview.categories)[0]?.id ||
        "",
      centerId: value.centerId || overview.costCenters[0]?.id || "",
      start: value.start === firstOfMonth ? monthStart : value.start,
    }));
    setComp((value) => ({
      ...value,
      employeeId:
        value.employeeId ||
        overview.employees.find((item) => item.status === "active")?.id ||
        "",
      centerId:
        value.centerId ||
        overview.costCenters.find((item) => item.code === "administration")
          ?.id ||
        overview.costCenters[0]?.id ||
        "",
      effectiveFrom:
        value.effectiveFrom === firstOfMonth ? monthStart : value.effectiveFrom,
    }));
    setPayroll((value) => ({
      ...value,
      employeeId:
        value.employeeId ||
        overview.employees.find((item) => item.status === "active")?.id ||
        "",
      periodStart:
        value.periodStart === firstOfMonth ? monthStart : value.periodStart,
      periodEnd:
        value.periodEnd === today ? overview.businessDate : value.periodEnd,
    }));
  }, [firstOfMonth, overview, today]);
  const selectedCategory = overview?.categories.find(
    (item) => item.id === cost.categoryId,
  );
  const selectedRecurringCategory = overview?.categories.find(
    (item) => item.id === recurring.categoryId,
  );
  const selectedPayrollRule = useMemo(
    () =>
      overview?.compensationRules.find(
        (item) =>
          item.employeeId === payroll.employeeId &&
          item.effectiveFrom <= payroll.periodStart &&
          (!item.effectiveUntil || item.effectiveUntil >= payroll.periodEnd),
      ),
    [overview, payroll.employeeId, payroll.periodEnd, payroll.periodStart],
  );
  useEffect(() => {
    const base = selectedPayrollRule
      ? fromMinor(calculatedBase(selectedPayrollRule, payroll.units))
      : "";
    setPayroll((value) => (value.base === base ? value : { ...value, base }));
  }, [payroll.units, selectedPayrollRule]);

  async function run(
    key: string,
    operation: () => Promise<unknown>,
    success: string,
  ): Promise<boolean> {
    if (busy || writeInFlight.current) return false;
    writeInFlight.current = true;
    setBusy(key);
    setNotice("");
    try {
      await operation();
      setNotice(success);
      await load(true);
      return true;
    } catch (error) {
      setNotice(errorMessage(error, "操作没有完成，请核对后重试"));
      return false;
    } finally {
      writeInFlight.current = false;
      setBusy("");
    }
  }
  async function submitCost(event: FormEvent) {
    event.preventDefault();
    if (!selectedCategory) return setNotice("请选择费用分类");
    const endpoint = correctingCost
      ? `/api/commercial-ops/costs/${correctingCost.id}/corrections`
      : "/api/commercial-ops/costs";
    const succeeded = await run(
      "cost",
      () =>
        postCommand(
          endpoint,
          {
            displayName: cost.name,
            category: selectedCategory.systemCategory,
            categoryDefinitionId: selectedCategory.id,
            costCenterId: cost.centerId,
            recognitionState: cost.paid ? "actual" : "known",
            allocationPeriod: allocation(cost.start, cost.end),
            serviceStartDate: cost.start,
            serviceEndDate: cost.end,
            cashPaidOn: cost.paid ? cost.paidOn : null,
            netAmountMinor: toMinor(cost.amount),
            taxAmountMinor: toMinor(cost.tax),
            currency: "CNY",
            sourceType: sourceFor(selectedCategory.systemCategory),
            counterparty: optional(cost.counterparty),
            note: optional(cost.note),
            ...(correctingCost
              ? { correctionReason: correctionReason.trim() }
              : {}),
          },
          { idempotencyKey: key("owner-cost") },
        ),
      correctingCost
        ? "费用已更正；原记录和更正原因均已保留"
        : "费用已记录并进入利润口径",
    );
    if (succeeded) {
      setCorrectingCost(null);
      setCorrectionReason("");
      const businessDate = overview?.businessDate ?? today;
      setCost((value) => ({
        ...value,
        name: "",
        amount: "",
        tax: "0",
        start: businessDate,
        end: businessDate,
        paid: true,
        paidOn: businessDate,
        counterparty: "",
        note: "",
      }));
    }
  }
  function beginCostCorrection(item: Cost) {
    const fallbackCategory = overview?.categories.find(
      (candidate) => candidate.systemCategory === item.category,
    );
    setCorrectingCost(item);
    setCorrectionReason("");
    setCost({
      name: item.name,
      categoryId: item.categoryDefinitionId ?? fallbackCategory?.id ?? "",
      centerId: item.costCenterId ?? overview?.costCenters[0]?.id ?? "",
      amount: fromMinor(item.netAmountMinor),
      tax: fromMinor(item.taxAmountMinor),
      start: item.serviceStartDate,
      end: item.serviceEndDate,
      paid: item.cashPaidOn !== null,
      paidOn: item.cashPaidOn ?? overview?.businessDate ?? today,
      counterparty: item.counterparty ?? "",
      note: item.note ?? "",
    });
    requestAnimationFrame(() =>
      costFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }
  function cancelCostCorrection() {
    setCorrectingCost(null);
    setCorrectionReason("");
  }
  async function submitRecurring(event: FormEvent) {
    event.preventDefault();
    if (!selectedRecurringCategory) return setNotice("请选择费用分类");
    await run(
      "recurring",
      () =>
        postCommand(
          "/api/commercial-ops/recurring-costs",
          {
            name: recurring.name,
            categoryDefinitionId: selectedRecurringCategory.id,
            costCenterId: recurring.centerId,
            recurrence: recurring.recurrence,
            allocationPeriod: recurring.recurrence,
            recognitionState: recurring.paid ? "actual" : "accrual",
            startsOn: recurring.start,
            endsOn: optional(recurring.end),
            netAmountMinor: toMinor(recurring.amount),
            taxAmountMinor: toMinor(recurring.tax),
            sourceType: sourceFor(selectedRecurringCategory.systemCategory),
            counterparty: optional(recurring.counterparty),
            note: optional(recurring.note),
          },
          { idempotencyKey: key("owner-recurring") },
        ),
      "周期费用规则已保存；点击“生成到今天”后才会入账",
    );
  }
  async function materialize() {
    const throughDate = overview?.businessDate ?? today;
    await run(
      "materialize",
      () =>
        postCommand(
          "/api/commercial-ops/recurring-costs/materialize",
          { throughDate },
          { idempotencyKey: key("owner-materialize") },
        ),
      "已补齐截至当前营业日应生成且尚未生成的周期费用",
    );
  }
  async function setRecurringStatus(
    item: Recurring,
    status: "active" | "paused" | "ended",
  ) {
    const label =
      status === "active" ? "恢复" : status === "paused" ? "暂停" : "结束";
    if (
      !(await confirmAction({
        title: `${label}周期费用`,
        description: `${label}“${item.name}”后，已生成的费用记录保持不变；未来营业日按新状态处理。`,
        confirmLabel: `确认${label}`,
      }))
    )
      return;
    await run(
      `recurring-${item.id}`,
      () =>
        postCommand(
          `/api/commercial-ops/recurring-costs/${item.id}/status`,
          { status, reason: `老板确认${label}周期费用规则` },
          { idempotencyKey: key("owner-recurring-status") },
        ),
      `周期费用规则已${label}`,
    );
  }
  async function submitSetting(event: FormEvent) {
    event.preventDefault();
    const code = `custom-${Date.now().toString(36)}`;
    const endpoint =
      setting.kind === "category"
        ? "/api/commercial-ops/cost-categories"
        : "/api/commercial-ops/cost-centers";
    const body =
      setting.kind === "category"
        ? { code, name: setting.name, systemCategory: setting.systemCategory }
        : { code, name: setting.name };
    await run(
      "setting",
      () =>
        postCommand(endpoint, body, {
          idempotencyKey: key("owner-setting"),
        }),
      "自定义项目已添加",
    );
  }
  async function submitComp(event: FormEvent) {
    event.preventDefault();
    await run(
      "comp",
      () =>
        postCommand(
          "/api/commercial-ops/compensation-rules",
          {
            employeeId: comp.employeeId,
            costCenterId: comp.centerId,
            payBasis: comp.payBasis,
            baseRateMinor: toMinor(comp.rate),
            effectiveFrom: comp.effectiveFrom,
            reason: comp.reason,
          },
          { idempotencyKey: key("owner-comp") },
        ),
      "薪资标准已建立；旧标准已保留并标记为历史版本",
    );
  }
  const currentDraft = overview?.payrollRuns.find((item) => item.status === "draft" && item.periodStart === payroll.periodStart && item.periodEnd === payroll.periodEnd);
  async function submitPayroll(event: FormEvent) {
    event.preventDefault();
    if (!selectedPayrollRule)
      return setNotice("请先为该员工建立有效的薪资标准");
    if (editingPayrollLine && (editingPayrollLine.employeeId !== payroll.employeeId || editingPayrollLine.payrollRunId !== currentDraft?.id))
      return setNotice("编辑对象与当前周期或员工不一致，请取消编辑后重新选择");
    const succeeded = await run(
      "payroll",
      () =>
        postCommand(
          "/api/commercial-ops/payroll-runs",
          {
            periodStart: payroll.periodStart,
            periodEnd: payroll.periodEnd,
            ...(currentDraft ? { draftRunId: currentDraft.id, expectedVersion: currentDraft.version, replaceEmployeeLine: Boolean(editingPayrollLine) } : {}),
            note: optional(payroll.note),
            lines: [
              {
                employeeId: payroll.employeeId,
                compensationRuleId: selectedPayrollRule.id,
                units: Number(payroll.units),
                basePayMinor: toMinor(payroll.base),
                overtimeMinor: toMinor(payroll.overtime),
                bonusMinor: toMinor(payroll.bonus),
                commissionMinor: toMinor(payroll.commission),
                allowanceMinor: toMinor(payroll.allowance),
                deductionMinor: toMinor(payroll.deduction),
                employerContributionMinor: toMinor(
                  payroll.employerContribution,
                ),
                note: optional(payroll.note),
              },
            ],
          },
          { idempotencyKey: key("owner-payroll") },
        ),
      "工资明细已保存到本期草稿；尚未入账，也不会自动转账",
    );
    if (succeeded) setEditingPayrollLine(null);
  }
  function editPayrollLine(line: PayrollLine) {
    const draft = overview?.payrollRuns.find((item) => item.id === line.payrollRunId && item.status === "draft");
    if (!draft || !canPayroll || busy) return;
    setEditingPayrollLine(line);
    setPayroll({ employeeId: line.employeeId, periodStart: draft.periodStart, periodEnd: draft.periodEnd,
      units: String(line.units), base: fromMinor(line.basePayMinor), overtime: fromMinor(line.overtimeMinor),
      bonus: fromMinor(line.bonusMinor), commission: fromMinor(line.commissionMinor), allowance: fromMinor(line.allowanceMinor),
      deduction: fromMinor(line.deductionMinor), employerContribution: fromMinor(line.employerContributionMinor), note: line.note ?? "" });
  }
  async function removePayrollLine(line: PayrollLine) {
    const draft = overview?.payrollRuns.find((item) => item.id === line.payrollRunId && item.status === "draft");
    if (!draft || !canPayroll || busy) return;
    if (!(await confirmAction({ title: "移除草稿明细", description: `从尚未入账的工资草稿移除${line.employeeName}，变更保留审计记录。`, confirmLabel: "确认移除" }))) return;
    await run("remove-payroll-line", () => postCommand("/api/commercial-ops/payroll-runs", {
      draftRunId: draft.id, expectedVersion: draft.version, periodStart: draft.periodStart, periodEnd: draft.periodEnd,
      removeEmployeeId: line.employeeId, lines: [], note: "移除未入账工资明细",
    }, { idempotencyKey: key("owner-payroll-remove") }), "工资草稿明细已移除");
  }
  async function approve(run: Payroll) {
    if (
      !(await confirmAction({
        title: "确认工资核算",
        description: `确认 ${run.periodStart} 至 ${run.periodEnd} 的工资草稿。此操作不转账，确认后仍需单独入账。`,
        confirmLabel: "确认核算",
      }))
    )
      return;
    await runAction(
      `approve-${run.id}`,
      () =>
        postCommand(
          `/api/commercial-ops/payroll-runs/${run.id}/approve`,
          { reason: "老板核对工资明细后确认" },
          { idempotencyKey: key("owner-payroll-approve") },
        ),
      "工资核算已确认，尚未入账",
    );
  }
  async function post(run: Payroll) {
    if (
      !(await confirmAction({
        title: "确认工资计入经营成本",
        description: `将 ¥${fromMinor(run.employerCostMinor)} 计入期间费用。仅生成账务记录，不会向员工转账。`,
        confirmLabel: "确认入账",
      }))
    )
      return;
    await runAction(
      `post-${run.id}`,
      () =>
        postCommand(
          `/api/commercial-ops/payroll-runs/${run.id}/post`,
          { reason: "老板确认工资成本入账" },
          { idempotencyKey: key("owner-payroll-post") },
        ),
      "工资已计入经营成本；未执行任何转账",
    );
  }
  async function voidPayroll(run: Payroll) {
    if (
      !(await confirmAction({
        title: "作废未入账工资单",
        description: `作废 ${run.periodStart} 至 ${run.periodEnd} 的工资单。作废会保留记录和原因，但不会计入经营成本；之后可以按正确内容重开。`,
        confirmLabel: "确认作废",
      }))
    )
      return;
    await runAction(
      `void-${run.id}`,
      () =>
        postCommand(
          `/api/commercial-ops/payroll-runs/${run.id}/void`,
          { reason: "老板确认作废未入账工资单并准备重新核算" },
          { idempotencyKey: key("owner-payroll-void") },
        ),
      "工资单已作废并保留审计记录，现在可以重开该周期",
    );
  }
  const runAction = run;

  if (!auth.permissions.some((p) => ["commercial.cost.view", "commercial.cost.manage", "commercial.payroll.view", "commercial.payroll.manage", "commercial.payroll.post"].includes(p))) return null;
  return (
    <section className="owner-finance-panel" aria-label="老板费用与工资管理">
      <header>
        <div>
          <strong>费用、员工与工资</strong>
          <small>经营账和支付分离：这里核算与入账，不会自动打款。</small>
        </div>
        <button
          type="button"
          aria-label="刷新经营费用"
          disabled={busy === "load"}
          onClick={() => void load()}
        >
          <RefreshCw size={16} />
        </button>
      </header>
      {notice && (
        <p className="owner-finance-notice" role="status">
          {notice}
        </p>
      )}
      <nav aria-label="经营费用功能">
        {(canManage || overview?.canViewCost) && <button data-active={mode === "cost"} onClick={() => setMode("cost")}>
          <CircleDollarSign size={16} />
          费用
        </button>}
        {canManage && <button
          data-active={mode === "recurring"}
          onClick={() => setMode("recurring")}
        >
          <CalendarPlus size={16} />
          周期费用
        </button>}
        {overview?.canViewPayroll && (
          <button
            data-active={mode === "payroll"}
            onClick={() => setMode("payroll")}
          >
            <Users size={16} />
            员工工资
          </button>
        )}
        {canManage && <button
          data-active={mode === "settings"}
          onClick={() => setMode("settings")}
        >
          <Settings2 size={16} />
          分类设置
        </button>}
      </nav>
      {mode === "cost" && (
        <>
          {canManage && <form
            ref={costFormRef}
            className="owner-finance-form"
            onSubmit={submitCost}
          >
            <header>
              <strong>{correctingCost ? "更正费用记录" : "记录一笔费用"}</strong>
              <small>
                {correctingCost
                  ? `正在更正“${correctingCost.name}”。原记录不会删除，更正后报表只采用最新记录。`
                  : "房租、乐队、厨房和每日临时支出都从这里录入；工资走工资核算，酒水采购走收货入库。"}
              </small>
            </header>
            <label>
              费用名称
              <input
                required
                maxLength={128}
                value={cost.name}
                onChange={(event) =>
                  setCost({ ...cost, name: event.target.value })
                }
                placeholder="如：9月房租"
              />
            </label>
            <SelectCategory
              value={cost.categoryId}
              setValue={(value) => setCost({ ...cost, categoryId: value })}
              items={operatingExpenseCategories(overview?.categories ?? [])}
            />
            <SelectCenter
              value={cost.centerId}
              setValue={(value) => setCost({ ...cost, centerId: value })}
              items={overview?.costCenters ?? []}
            />
            <label>
              未税金额
              <NumberInputWithUnit
                required
                inputMode="decimal"
                unit="元"
                value={cost.amount}
                onChange={(event) =>
                  setCost({ ...cost, amount: event.target.value })
                }
              />
            </label>
            <label>
              税额
              <NumberInputWithUnit
                required
                inputMode="decimal"
                unit="元"
                value={cost.tax}
                onChange={(event) =>
                  setCost({ ...cost, tax: event.target.value })
                }
              />
            </label>
            <label>
              费用开始
              <input
                required
                type="date"
                value={cost.start}
                onChange={(event) =>
                  setCost({ ...cost, start: event.target.value })
                }
              />
            </label>
            <label>
              费用结束
              <input
                required
                type="date"
                min={cost.start}
                value={cost.end}
                onChange={(event) =>
                  setCost({ ...cost, end: event.target.value })
                }
              />
            </label>
            <label>
              付款状态
              <select
                value={cost.paid ? "paid" : "unpaid"}
                onChange={(event) =>
                  setCost({ ...cost, paid: event.target.value === "paid" })
                }
              >
                <option value="paid">已支付</option>
                <option value="unpaid">金额已知、尚未支付</option>
              </select>
            </label>
            {cost.paid && (
              <label>
                实际付款日期
                <input
                  required
                  type="date"
                  value={cost.paidOn}
                  onChange={(event) =>
                    setCost({ ...cost, paidOn: event.target.value })
                  }
                />
              </label>
            )}
            <label>
              收款方（选填）
              <input
                maxLength={128}
                value={cost.counterparty}
                onChange={(event) =>
                  setCost({ ...cost, counterparty: event.target.value })
                }
              />
            </label>
            <label className="wide">
              备注（选填）
              <textarea
                maxLength={1000}
                rows={2}
                value={cost.note}
                onChange={(event) =>
                  setCost({ ...cost, note: event.target.value })
                }
              />
            </label>
            {correctingCost && (
              <label className="wide">
                更正原因
                <textarea
                  required
                  minLength={2}
                  maxLength={1000}
                  rows={2}
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  placeholder="说明为什么更正，便于日后审计"
                />
              </label>
            )}
            <div className="owner-finance-form-actions wide">
              <button disabled={busy !== ""}>
                {correctingCost ? "保存更正" : "记录费用"}
              </button>
              {correctingCost && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== ""}
                  onClick={cancelCostCorrection}
                >
                  取消更正
                </button>
              )}
            </div>
          </form>}
          <div className="owner-finance-form">
            <label>记录开始日期<input type="date" value={range.start} onChange={(event) => setRange({ ...range, start: event.target.value })} /></label>
            <label>记录结束日期<input type="date" value={range.end} onChange={(event) => setRange({ ...range, end: event.target.value })} /></label>
          </div>
          <Records
            costs={overview?.costs ?? []}
            busy={busy}
            onCorrect={beginCostCorrection}
            canManage={canManage}
          />
        </>
      )}
      {mode === "recurring" && canManage && (
        <>
          <form className="owner-finance-form" onSubmit={submitRecurring}>
            <header>
              <strong>建立周期费用</strong>
              <small>
                规则与实际入账分开，防止重复计算；生成动作具有防重复保护。酒水采购需走收货入库，不在这里自动生成。
              </small>
            </header>
            <label>
              规则名称
              <input
                required
                value={recurring.name}
                onChange={(event) =>
                  setRecurring({ ...recurring, name: event.target.value })
                }
                placeholder="如：每月房租"
              />
            </label>
            <SelectCategory
              value={recurring.categoryId}
              setValue={(value) =>
                setRecurring({ ...recurring, categoryId: value })
              }
              items={recurringExpenseCategories(overview?.categories ?? [])}
            />
            <SelectCenter
              value={recurring.centerId}
              setValue={(value) =>
                setRecurring({ ...recurring, centerId: value })
              }
              items={overview?.costCenters ?? []}
            />
            <label>
              每期未税金额
              <NumberInputWithUnit
                required
                inputMode="decimal"
                unit="元/期"
                value={recurring.amount}
                onChange={(event) =>
                  setRecurring({ ...recurring, amount: event.target.value })
                }
              />
            </label>
            <label>
              税额
              <NumberInputWithUnit
                required
                inputMode="decimal"
                unit="元/期"
                value={recurring.tax}
                onChange={(event) =>
                  setRecurring({ ...recurring, tax: event.target.value })
                }
              />
            </label>
            <label>
              周期
              <select
                value={recurring.recurrence}
                onChange={(event) =>
                  setRecurring({ ...recurring, recurrence: event.target.value })
                }
              >
                {periodOptions()}
              </select>
            </label>
            <label>
              首次日期
              <input
                required
                type="date"
                value={recurring.start}
                onChange={(event) =>
                  setRecurring({ ...recurring, start: event.target.value })
                }
              />
            </label>
            <label>
              结束日期（选填）
              <input
                type="date"
                min={recurring.start}
                value={recurring.end}
                onChange={(event) =>
                  setRecurring({ ...recurring, end: event.target.value })
                }
              />
            </label>
            <label>
              付款处理
              <select
                value={recurring.paid ? "paid" : "accrual"}
                onChange={(event) =>
                  setRecurring({
                    ...recurring,
                    paid: event.target.value === "paid",
                  })
                }
              >
                <option value="accrual">到期先计提，未声明付款</option>
                <option value="paid">到期视为已支付</option>
              </select>
            </label>
            <button disabled={busy !== ""}>保存周期规则</button>
          </form>
          <div className="owner-finance-toolbar">
            <span>{overview?.recurringRules.length ?? 0} 条规则</span>
            <button
              type="button"
              disabled={busy !== ""}
              onClick={() => void materialize()}
            >
              生成到当前营业日
            </button>
          </div>
          <RecurringList
            items={overview?.recurringRules ?? []}
            busy={busy}
            setStatus={setRecurringStatus}
          />
        </>
      )}
      {mode === "payroll" && overview?.canViewPayroll && (
        <>
          {canPayroll && <form className="owner-finance-form" onSubmit={submitComp}>
            <header>
              <strong>员工薪资标准</strong>
              <small>
                按版本保留历史；这里只定义核算标准，不保存银行卡，也不执行转账。
              </small>
            </header>
            <SelectEmployee
              value={comp.employeeId}
              setValue={(value) => setComp({ ...comp, employeeId: value })}
              items={overview.employees}
            />
            <SelectCenter
              value={comp.centerId}
              setValue={(value) => setComp({ ...comp, centerId: value })}
              items={overview.costCenters}
            />
            <label>
              计薪方式
              <select
                value={comp.payBasis}
                onChange={(event) =>
                  setComp({ ...comp, payBasis: event.target.value })
                }
              >
                <option value="monthly">月薪</option>
                <option value="daily">日薪</option>
                <option value="hourly">时薪</option>
                <option value="per_shift">班次</option>
              </select>
            </label>
            <label>
              工资标准
              <NumberInputWithUnit
                required
                inputMode="decimal"
                unit={rateUnit(comp.payBasis)}
                value={comp.rate}
                onChange={(event) =>
                  setComp({ ...comp, rate: event.target.value })
                }
              />
            </label>
            <label>
              生效日期
              <input
                required
                type="date"
                value={comp.effectiveFrom}
                onChange={(event) =>
                  setComp({ ...comp, effectiveFrom: event.target.value })
                }
              />
            </label>
            <label>
              调整原因
              <input
                required
                minLength={2}
                maxLength={1000}
                value={comp.reason}
                onChange={(event) =>
                  setComp({ ...comp, reason: event.target.value })
                }
              />
            </label>
            <button disabled={!canPayroll || busy !== ""}>保存薪资标准</button>
          </form>}
          {canPayroll && <form className="owner-finance-form" onSubmit={submitPayroll}>
            <header>
              <strong>{editingPayrollLine ? "编辑员工工资明细" : currentDraft ? "追加员工到本期草稿" : "建立工资草稿"}</strong>
              <small>
                基本工资由服务端薪资标准×计薪数量计算；应发=基本工资+加班+奖金+提成+补贴；实发=应发−员工代扣；经营成本=应发+雇主承担。缺勤应减少计薪数量，不要填入员工代扣。
              </small>
            </header>
            <SelectEmployee
              value={payroll.employeeId}
              setValue={(value) =>
                setPayroll({ ...payroll, employeeId: value, units: "1" })
              }
              items={overview.employees}
            />
            <label>
              周期开始
              <input
                required
                type="date"
                value={payroll.periodStart}
                onChange={(event) =>
                  setPayroll({ ...payroll, periodStart: event.target.value })
                }
              />
            </label>
            <label>
              周期结束
              <input
                required
                type="date"
                min={payroll.periodStart}
                value={payroll.periodEnd}
                onChange={(event) =>
                  setPayroll({ ...payroll, periodEnd: event.target.value })
                }
              />
            </label>
            <label>
              计薪数量
              <NumberInputWithUnit
                required
                inputMode="decimal"
                min="0.01"
                step="0.01"
                unit={quantityUnit(selectedPayrollRule?.payBasis)}
                value={payroll.units}
                readOnly={selectedPayrollRule?.payBasis === "monthly"}
                onChange={(event) =>
                  setPayroll({ ...payroll, units: event.target.value })
                }
              />
            </label>
            <label>
              规则计算基本工资
              <NumberInputWithUnit
                required
                inputMode="decimal"
                unit="元"
                value={payroll.base}
                readOnly
              />
            </label>
            {(
              [
                "overtime",
                "bonus",
                "commission",
                "allowance",
                "deduction",
                "employerContribution",
              ] as const
            ).map((field) => (
              <label key={field}>
                {payrollLabels[field]}
                <NumberInputWithUnit
                  required
                  inputMode="decimal"
                  unit="元"
                  value={payroll[field]}
                  onChange={(event) =>
                    setPayroll({ ...payroll, [field]: event.target.value })
                  }
                />
              </label>
            ))}
            {!selectedPayrollRule && (
              <p className="owner-finance-form-warning wide">
                没有一条薪资标准完整覆盖所选工资周期。请调整周期，或先建立从周期开始到结束均有效的薪资标准。
              </p>
            )}
            <label className="wide">
              核算备注（选填）
              <textarea
                rows={2}
                maxLength={1000}
                value={payroll.note}
                onChange={(event) =>
                  setPayroll({ ...payroll, note: event.target.value })
                }
              />
            </label>
            <button
              disabled={!canPayroll || !selectedPayrollRule || busy !== ""}
            >
              {editingPayrollLine ? "保存明细修改" : currentDraft ? "追加到本期草稿" : "建立工资草稿"}
            </button>
            {editingPayrollLine && <button type="button" className="secondary" onClick={() => setEditingPayrollLine(null)}>取消编辑</button>}
          </form>}
          <div className="owner-finance-list">
            <label>查看工资周期<select value={overview.payrollRuns.find((item) => item.periodStart === payroll.periodStart && item.periodEnd === payroll.periodEnd)?.id ?? ""} onChange={(event) => {
              const selected = overview.payrollRuns.find((item) => item.id === event.target.value);
              if (selected) { setEditingPayrollLine(null); setPayroll((value) => ({ ...value, periodStart: selected.periodStart, periodEnd: selected.periodEnd })); }
            }}><option value="">当前录入周期</option>{overview.payrollRuns.map((item) => <option key={item.id} value={item.id}>{item.periodStart} 至 {item.periodEnd}</option>)}</select></label>
            <header><strong>本期逐人明细</strong><span>{payroll.periodStart} 至 {payroll.periodEnd}</span></header>
            {(overview.payrollLines ?? []).filter((line) => overview.payrollRuns.some((item) => item.id === line.payrollRunId && item.periodStart === payroll.periodStart && item.periodEnd === payroll.periodEnd)).map((line) => <article key={line.id}>
              <div><strong>{line.employeeName}</strong><small>基本 ¥{fromMinor(line.basePayMinor)} · 加班 ¥{fromMinor(line.overtimeMinor)} · 奖金 ¥{fromMinor(line.bonusMinor)} · 提成 ¥{fromMinor(line.commissionMinor)} · 补贴 ¥{fromMinor(line.allowanceMinor)} · 代扣 ¥{fromMinor(line.deductionMinor)} · 雇主承担 ¥{fromMinor(line.employerContributionMinor)}</small></div>
              {canPayroll && currentDraft?.id === line.payrollRunId && <div className="owner-finance-actions"><button type="button" disabled={!!busy} onClick={() => editPayrollLine(line)}>编辑</button><button type="button" className="secondary" disabled={!!busy || currentDraft.lineCount <= 1} onClick={() => void removePayrollLine(line)}>移除</button></div>}
            </article>)}
          </div>
          <PayrollList
            items={overview.payrollRuns}
            busy={busy}
            approve={approve}
            post={post}
            voidPayroll={voidPayroll}
            canManage={canPayroll}
            canPost={auth.permissions.includes("commercial.payroll.post")}
          />
        </>
      )}
      {mode === "settings" && canManage && (
        <form className="owner-finance-form" onSubmit={submitSetting}>
          <header>
            <strong>自定义费用项目</strong>
            <small>自定义名称仍映射到固定会计分类，保证报表可比较。</small>
          </header>
          <label>
            项目类型
            <select
              value={setting.kind}
              onChange={(event) =>
                setSetting({
                  ...setting,
                  kind: event.target.value as "category" | "center",
                })
              }
            >
              <option value="category">费用分类</option>
              <option value="center">成本中心</option>
            </select>
          </label>
          <label>
            显示名称
            <input
              required
              maxLength={64}
              value={setting.name}
              onChange={(event) =>
                setSetting({ ...setting, name: event.target.value })
              }
            />
          </label>
          {setting.kind === "category" && (
            <label>
              会计归类
              <select
                value={setting.systemCategory}
                onChange={(event) =>
                  setSetting({ ...setting, systemCategory: event.target.value })
                }
              >
                {categoryOptions()}
              </select>
            </label>
          )}
          <button disabled={busy !== ""}>添加项目</button>
        </form>
      )}
    </section>
  );
}

function SelectCategory({
  value,
  setValue,
  items,
}: {
  value: string;
  setValue(value: string): void;
  items: Category[];
}) {
  return (
    <label>
      费用分类
      <select
        required
        value={value}
        onChange={(event) => setValue(event.target.value)}
      >
        <option value="">请选择</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function operatingExpenseCategories(items: Category[]) {
  return items.filter(
    (item) =>
      item.systemCategory !== "beverage_purchase" &&
      item.systemCategory !== "personnel",
  );
}

function recurringExpenseCategories(items: Category[]) {
  return operatingExpenseCategories(items);
}
function SelectCenter({
  value,
  setValue,
  items,
}: {
  value: string;
  setValue(value: string): void;
  items: CostCenter[];
}) {
  return (
    <label>
      成本中心
      <select
        required
        value={value}
        onChange={(event) => setValue(event.target.value)}
      >
        <option value="">请选择</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function SelectEmployee({
  value,
  setValue,
  items,
}: {
  value: string;
  setValue(value: string): void;
  items: Employee[];
}) {
  return (
    <label>
      员工
      <select
        required
        value={value}
        onChange={(event) => setValue(event.target.value)}
      >
        <option value="">请选择</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.displayName} · {item.employeeCode}
            {item.status === "active" ? "" : " · 账号已暂停"}
          </option>
        ))}
      </select>
    </label>
  );
}
function Records({
  costs,
  busy,
  onCorrect,
  canManage,
}: {
  costs: Cost[];
  busy: string;
  onCorrect(item: Cost): void;
  canManage: boolean;
}) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  useEffect(() => { setPage(0); }, [costs, search]);
  const term = search.trim().toLocaleLowerCase("zh-CN");
  const current = costs.filter((item) => !item.corrected && (!term || [item.name, item.publicId, item.costCenterName, item.counterparty, item.note, fromMinor(item.grossAmountMinor)].join(" ").toLocaleLowerCase("zh-CN").includes(term)));
  return (
    <div className="owner-finance-list">
      <header>
        <strong>所选期间费用记录</strong>
        <span>{current.length} 笔</span>
      </header>
      <label>搜索费用<input type="search" placeholder="项目、单号、往来方、备注或金额" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      {current.length === 0 ? (
        <p>{term ? "所选期间没有匹配的费用，请调整关键词或日期。" : "所选期间尚未录入费用。"}</p>
      ) : (
        current.slice(page * 50, (page + 1) * 50).map((item) => (
          <article key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <small>
                {item.costCenterName ?? "未分成本中心"} ·{" "}
                {item.serviceStartDate}
                {item.serviceEndDate === item.serviceStartDate
                  ? ""
                  : ` 至 ${item.serviceEndDate}`}{" "}
                · {item.cashPaidOn ? "已支付" : "未标记付款"}
              </small>
            </div>
            <div className="owner-finance-actions">
              <b>¥{fromMinor(item.grossAmountMinor)}</b>
              {canManage && item.sourceType !== "payroll" &&
                item.sourceType !== "inventory_purchase" && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== ""}
                    onClick={() => onCorrect(item)}
                  >
                    更正
                  </button>
                )}
            </div>
          </article>
        ))
      )}
      {current.length > 50 && <div className="owner-finance-actions"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page + 1} / {Math.ceil(current.length / 50)} 页</span><button type="button" disabled={(page + 1) * 50 >= current.length} onClick={() => setPage(page + 1)}>下一页</button></div>}
    </div>
  );
}
function RecurringList({
  items,
  busy,
  setStatus,
}: {
  items: Recurring[];
  busy: string;
  setStatus(
    item: Recurring,
    status: "active" | "paused" | "ended",
  ): Promise<void>;
}) {
  return (
    <div className="owner-finance-list">
      {items.length === 0 ? (
        <p>尚无周期费用规则。</p>
      ) : (
        items.map((item) => (
          <article key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <small>
                {item.categoryName} · {item.costCenterName} ·{" "}
                {periodLabel(item.recurrence)} · {item.startsOn}起 ·{" "}
                {recurringStatus(item.status)}
              </small>
            </div>
            <div className="owner-finance-actions">
              <b>¥{fromMinor(item.grossAmountMinor)}/期</b>
              {item.status === "active" ? (
                <>
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void setStatus(item, "paused")}
                  >
                    暂停
                  </button>
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void setStatus(item, "ended")}
                  >
                    结束
                  </button>
                </>
              ) : item.status === "paused" ? (
                <>
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void setStatus(item, "active")}
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== ""}
                    onClick={() => void setStatus(item, "ended")}
                  >
                    结束
                  </button>
                </>
              ) : null}
            </div>
          </article>
        ))
      )}
    </div>
  );
}
function PayrollList({
  items,
  busy,
  approve,
  post,
  voidPayroll,
  canManage,
  canPost,
}: {
  items: Payroll[];
  busy: string;
  approve(item: Payroll): Promise<void>;
  post(item: Payroll): Promise<void>;
  voidPayroll(item: Payroll): Promise<void>;
  canManage: boolean;
  canPost: boolean;
}) {
  return (
    <div className="owner-finance-list">
      <header>
        <strong>工资核算记录</strong>
        <span>{items.length} 期</span>
      </header>
      {items.map((item) => (
        <article key={item.id}>
          <div>
            <strong>
              {item.periodStart} 至 {item.periodEnd}
            </strong>
            <small>
              {item.lineCount} 人 · 应发 ¥{fromMinor(item.grossPayMinor)} · 实发
              ¥{fromMinor(item.netPayMinor)} · 经营成本 ¥
              {fromMinor(item.employerCostMinor)}
            </small>
          </div>
          <div className="owner-finance-actions">
            <em>{payrollStatus(item.status)}</em>
            {canManage && item.status === "draft" && (
              <button
                type="button"
                disabled={busy !== ""}
                onClick={() => void approve(item)}
              >
                确认
              </button>
            )}
            {canPost && item.status === "approved" && (
              <button
                type="button"
                disabled={busy !== ""}
                onClick={() => void post(item)}
              >
                入账
              </button>
            )}
            {canManage && (item.status === "draft" || item.status === "approved") && (
              <button
                type="button"
                className="secondary"
                disabled={busy !== ""}
                onClick={() => void voidPayroll(item)}
              >
                作废
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
function toMinor(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized))
    throw new Error("金额最多保留两位小数");
  const amount = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(amount)) throw new Error("金额超出范围");
  return amount;
}
function fromMinor(value: number) {
  return (value / 100).toFixed(2);
}
function optional(value: string) {
  return value.trim() === "" ? null : value.trim();
}
function key(scope: string) {
  return `${scope}-${crypto.randomUUID()}`;
}
function sourceFor(category: string) {
  return category === "rent"
    ? "lease"
    : category === "band" || category === "performer"
      ? "performance"
      : category === "utilities"
        ? "utility_bill"
        : category === "personnel"
          ? "payroll"
          : category === "beverage_purchase"
            ? "inventory_purchase"
            : "manual";
}
function allocation(start: string, end: string) {
  const days =
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        86400000,
    ) + 1;
  return days <= 1
    ? "day"
    : days <= 7
      ? "week"
      : days <= 31
        ? "month"
        : days <= 93
          ? "quarter"
          : "year";
}
function periodOptions() {
  return (
    <>
      <option value="day">每天</option>
      <option value="week">每周</option>
      <option value="month">每月</option>
      <option value="quarter">每季度</option>
      <option value="year">每年</option>
    </>
  );
}
function periodLabel(value: string) {
  return (
    (
      {
        day: "每天",
        week: "每周",
        month: "每月",
        quarter: "每季度",
        year: "每年",
      } as Record<string, string>
    )[value] ?? value
  );
}
function recurringStatus(value: string) {
  return (
    (
      { active: "执行中", paused: "已暂停", ended: "已结束" } as Record<
        string,
        string
      >
    )[value] ?? value
  );
}
function rateUnit(value: string) {
  return (
    (
      {
        monthly: "元/月",
        daily: "元/天",
        hourly: "元/小时",
        per_shift: "元/班",
      } as Record<string, string>
    )[value] ?? "元/单位"
  );
}
function quantityUnit(value: string | undefined) {
  return (
    (
      {
        monthly: "个月",
        daily: "天",
        hourly: "小时",
        per_shift: "班",
      } as Record<string, string>
    )[value ?? ""] ?? "单位"
  );
}
function calculatedBase(rule: Compensation, units: string) {
  const quantity = Number(units);
  if (!Number.isFinite(quantity) || quantity < 0) return 0;
  return Math.round((rule.baseRateMinor * Math.round(quantity * 100)) / 100);
}
function categoryOptions() {
  return (
    <>
      <option value="miscellaneous">其他费用</option>
      <option value="rent">房租</option>
      <option value="band">乐队</option>
      <option value="performer">演出</option>
      <option value="utilities">水电物业</option>
    </>
  );
}
function payrollStatus(value: string) {
  return (
    (
      {
        draft: "草稿",
        approved: "待入账",
        posted: "已入账",
        voided: "已作废",
      } as Record<string, string>
    )[value] ?? value
  );
}
function errorMessage(error: unknown, fallback: string) {
  return error instanceof NormalizedApiError || error instanceof Error
    ? error.message
    : fallback;
}
const payrollLabels = {
  overtime: "加班费",
  bonus: "奖金",
  commission: "提成",
  allowance: "补贴",
  deduction: "员工代扣（不减少经营成本）",
  employerContribution: "雇主承担",
} as const;
