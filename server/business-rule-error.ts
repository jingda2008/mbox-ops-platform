export class BusinessRuleError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(
    message: string,
    code = 'BUSINESS_RULE_REJECTED',
    statusCode = 409,
  ) {
    super(message)
    this.name = 'BusinessRuleError'
    this.code = code
    this.statusCode = statusCode
  }
}
