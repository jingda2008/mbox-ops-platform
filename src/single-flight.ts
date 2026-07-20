export interface SingleFlightRef<T> {
  current: Promise<T> | null
}

export function runSingleFlight<T>(
  inFlight: SingleFlightRef<T>,
  operation: () => Promise<T>,
): Promise<T> {
  if (inFlight.current) return inFlight.current

  const promise = operation()
  inFlight.current = promise
  const clear = () => {
    if (inFlight.current === promise) inFlight.current = null
  }
  void promise.then(clear, clear)
  return promise
}
