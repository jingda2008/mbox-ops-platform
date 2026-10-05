/** Public employee-sales DTO. Internal employee/product UUIDs are intentionally absent. */
export interface EmployeeSalesView {
  employeeCode: string
  employeeDisplayName: string
  productCode: string
  productName: string
  quantity: string
  salesAmountMinor: number
  currency: string
}

export function employeeSales(value: unknown): EmployeeSalesView[] {
  if (!Array.isArray(value)) throw new Error('销售归属数据格式异常，请重新读取')
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('销售归属记录不完整，请重新读取')
    const row = item as Record<string, unknown>
    if (!['employeeCode', 'employeeDisplayName', 'productCode', 'productName'].every((key) => typeof row[key] === 'string' && (row[key] as string).length > 0)
      || typeof row.quantity !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(row.quantity)
      || typeof row.salesAmountMinor !== 'number' || !Number.isSafeInteger(row.salesAmountMinor)
      || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) {
      throw new Error('销售归属记录不完整，请重新读取')
    }
    return {
      employeeCode: row.employeeCode as string, employeeDisplayName: row.employeeDisplayName as string,
      productCode: row.productCode as string, productName: row.productName as string,
      quantity: row.quantity, salesAmountMinor: row.salesAmountMinor, currency: row.currency,
    }
  })
}

export function signedMinorAmount(value: number): string {
  return `${value < 0 ? '-' : ''}${(Math.abs(value) / 100).toFixed(2)}`
}

/** Profit and employee-sales grants are independent; neither suppresses nor implies the other. */
export async function loadOperatingReports(
  get: (path: string) => Promise<{ data: unknown }>, permissions: readonly string[],
): Promise<{ profit: unknown; sales: EmployeeSalesView[] }> {
  const [profit, sales] = await Promise.all([
    permissions.includes('commercial.profit.view')
      ? get('/api/commercial-ops/profit?period=day') : Promise.resolve({ data: null }),
    permissions.some((permission) => ['commercial.sales.view', 'commercial.sales.view_all'].includes(permission))
      ? get('/api/commercial-ops/employee-sales') : Promise.resolve({ data: [] }),
  ])
  return { profit: profit.data, sales: employeeSales(sales.data) }
}
