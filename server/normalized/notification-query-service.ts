import {
  NotificationRepository,
  type NotificationListQuery,
  type NotificationRecord,
} from './notification-repository.js'
import { StaffAccessRepository, StaffAccessDeniedError } from './staff-access-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type StoreScope,
} from './transaction-runner.js'

type TransactionExecutor = Pick<ScopedPostgresTransactionRunner, 'run'>

export class NotificationQueryService {
  constructor(private readonly transactions: TransactionExecutor) {}

  list(
    scope: Readonly<StoreScope>,
    query: Readonly<NotificationListQuery>,
    employeeId: string,
  ): Promise<NotificationRecord[]> {
    return this.transactions.run(
      scope,
      async (transaction) => {
        const access = await new StaffAccessRepository(transaction).assertPermission(employeeId, 'notification.view')
        if (access.permissions.includes('notification.view_all')) {
          return new NotificationRepository(transaction).list(query)
        }
        if (query.recipient && (query.recipient.type !== 'employee' || query.recipient.id !== employeeId)) {
          throw new StaffAccessDeniedError('当前员工只能查看自己的通知')
        }
        return new NotificationRepository(transaction).list({ ...query, recipient: { type: 'employee', id: employeeId } })
      },
      { readOnly: true },
    )
  }
}
