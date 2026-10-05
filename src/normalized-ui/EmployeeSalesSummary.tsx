import { useState } from 'react'
import { signedMinorAmount, type EmployeeSalesView } from './employee-sales-presentation'

export function EmployeeSalesSummary({ sales }: { sales: EmployeeSalesView[] }) {
  const [visibleCount, setVisibleCount] = useState(30)
  if (sales.length === 0) return <div className="staff-module-empty">当前范围暂无销售归属数据</div>
  return <>
    <p className="staff-module-footnote">数量与金额为销售归属净值，含退款冲减；不等于实际收款或员工佣金。</p>
    <div className="staff-module-list">{sales.slice(0, visibleCount).map((item) => <article key={JSON.stringify([item.employeeCode, item.productCode])}>
      <div><strong>{item.productName}</strong><small>{item.employeeDisplayName} · 净数量 {item.quantity}件</small></div>
      <b className={item.salesAmountMinor < 0 ? 'is-negative' : ''}>{item.currency === 'CNY' ? '¥' : `${item.currency} `}{signedMinorAmount(item.salesAmountMinor)}</b>
    </article>)}</div>
    <p className="staff-module-footnote">已显示 {Math.min(visibleCount, sales.length)} / {sales.length} 条销售归属</p>
    {visibleCount < sales.length && <button type="button" onClick={() => setVisibleCount((count) => count + 30)}>显示更多销售归属</button>}
  </>
}
