// A timeout cannot cancel an already submitted provider request. Callers must
// retain the original authorization use and treat its outcome as unknown.
export async function boundedNotificationOperation<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Notification operation timeout')), milliseconds)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
