import {
  NotificationRepository,
  type NotificationListQuery,
  type NotificationRecord,
} from './notification-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type StoreScope,
} from './transaction-runner.js'

type TransactionExecutor = Pick<ScopedPostgresTransactionRunner, 'run'>

export class NotificationQueryService {
  constructor(private readonly transactions: TransactionExecutor) {}

  list(
    scope: Readonly<StoreScope>,
    query: Readonly<NotificationListQuery> = {},
  ): Promise<NotificationRecord[]> {
    return this.transactions.run(
      scope,
      (transaction) => new NotificationRepository(transaction).list(query),
      { readOnly: true },
    )
  }
}
