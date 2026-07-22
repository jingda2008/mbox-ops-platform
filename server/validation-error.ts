import type { ZodError } from 'zod'

const fieldMessages: Record<string, string> = {
  actorId: '当前员工身份无效，请重新登录后再试',
  idempotencyKey: '本次操作标识无效，请重新提交',
  items: '请至少选择一件商品后再提交',
  productId: '商品信息不完整，请重新选择商品',
  tableId: '未选择桌台；如桌台尚未开台，请先开台后再下单',
}

export function clientValidationError(error: ZodError) {
  const issue = error.issues[0]
  const path = issue?.path.map(String) ?? []
  const field = path.find((part) => fieldMessages[part]) ?? ''
  return {
    code: 'VALIDATION_ERROR',
    message: fieldMessages[field] ?? '提交信息不完整，请检查必填内容后重试',
    details: { field: path.join('.') || null },
  }
}
